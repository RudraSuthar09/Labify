/**
 * Offline scan queue — the "never lose a scan" guarantee.
 *
 * When a verification call fails (offline, timeout, server 5xx, or a backend
 * rejection like a 400) the scan is persisted here instead of dropped. When
 * NetInfo reports connectivity is back, the queue drains automatically. The
 * operator can also drain it manually from Settings.
 *
 * Design notes:
 *
 *   - The image is copied into the app's *document* directory the moment we
 *     enqueue. expo-camera writes to the *cache* directory, which the OS is
 *     free to purge under memory pressure — that would silently lose scans.
 *     The document directory survives across app relaunches until the user
 *     uninstalls the app, or we explicitly delete the file.
 *
 *   - Sync runs one entry at a time in FIFO order. On a transport failure
 *     (network / timeout) we stop the whole run — the operator is likely
 *     still offline, and hammering more requests only wastes battery and
 *     ratelimits us on the server. On a server / rejection failure we mark
 *     the entry with `lastError` and continue to the next, so one bad scan
 *     doesn't block the rest of the queue.
 *
 *   - The image-file-missing case (documented edge case) drops the entry and
 *     logs — trying to send an empty file would only fail on every retry.
 *
 *   - A tiny pub/sub is exposed for the UI: components subscribe to receive
 *     the current entry list any time the queue mutates. Cheap enough (< 20
 *     entries in practice) to just snapshot the array each time.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { Directory, File, Paths } from 'expo-file-system';

import { verifyLabel, VerificationCallError } from './verification';
import type {
  VerificationError,
  VerificationResult,
} from '../types/verification';

const STORAGE_KEY = 'labify.pendingSync.v1';
const PENDING_DIR_NAME = 'pending-scans';

/**
 * One queued scan. All fields JSON-serialisable — the whole array is written to
 * AsyncStorage on every mutation, so restarts pick up exactly where we stopped.
 */
export interface QueueEntry {
  /** Local UUID-ish id, stable across renders and app restarts. */
  id: string;
  /** Unix ms — when the scan happened on-device. */
  createdAt: number;
  /** Value decoded off the barcode. */
  barcodeValue: string;
  /** Label profile the operator picked (currently always battery_pack). */
  labelType: string;
  /** Persistent file:// URI to the copied image (NOT the original cache path). */
  imageUri: string;
  /** How many times we've tried to send this — for UI + backoff decisions. */
  attemptCount: number;
  /** Unix ms of last attempt, or null if never attempted. */
  lastAttemptAt: number | null;
  /**
   * Result of the last failed attempt, kept so the operator can see *why* the
   * server (or their connection) is rejecting a specific entry.
   */
  lastError: VerificationError | null;
}

// --- Storage --------------------------------------------------------------

let cache: QueueEntry[] | null = null;

/** Load the queue from AsyncStorage. A corrupt blob is treated as empty. */
async function readQueue(): Promise<QueueEntry[]> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = [];
      return cache;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      cache = [];
      return cache;
    }
    // Defensive: drop any entry missing the required fields (e.g. an older
    // schema version). Never crash on user-authored garbage in storage.
    cache = parsed.filter(
      (e): e is QueueEntry =>
        e &&
        typeof e === 'object' &&
        typeof e.id === 'string' &&
        typeof e.barcodeValue === 'string' &&
        typeof e.imageUri === 'string' &&
        typeof e.createdAt === 'number',
    );
    return cache;
  } catch {
    cache = [];
    return cache;
  }
}

async function writeQueue(next: QueueEntry[]): Promise<void> {
  cache = next;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: the in-memory cache still holds the mutation. Next boot may
    // lose it, but we prefer that over crashing the scan flow.
  }
}

// --- Pub/sub for UI ------------------------------------------------------

type Listener = (entries: QueueEntry[]) => void;
const listeners = new Set<Listener>();

function emit() {
  const snapshot = cache ? cache.slice() : [];
  for (const l of listeners) {
    try {
      l(snapshot);
    } catch {
      // A listener throwing must not break other listeners or the queue itself.
    }
  }
}

/**
 * Subscribe to queue mutations. Fires immediately with the current snapshot,
 * then on every enqueue / dequeue / mark. Returns an unsubscribe function
 * suitable for a `useEffect` cleanup.
 */
export function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  // Fire immediately so the UI has data on the first render.
  readQueue().then((entries) => cb(entries.slice()));
  return () => {
    listeners.delete(cb);
  };
}

// --- File management -----------------------------------------------------

function pendingDir(): Directory {
  const dir = new Directory(Paths.document, PENDING_DIR_NAME);
  // `create` is idempotent when we ask it to be, so this is safe to call
  // on every enqueue.
  try {
    dir.create({ intermediates: true, idempotent: true });
  } catch {
    // Very unusual — the document directory should always be writable. If it
    // isn't, the copy below will surface a clearer error.
  }
  return dir;
}

/**
 * Copy the source image (from expo-camera's cache dir) into our persistent
 * pending directory. Returns the new persistent URI, or null if the source
 * file is unreadable — the caller then aborts the enqueue.
 */
function persistImage(sourceUri: string, id: string): string | null {
  if (!sourceUri) return null;

  const source = new File(sourceUri);
  if (!source.exists) {
    // The camera claimed to write a file but it isn't there — a device-level
    // issue. Nothing we can do; abort the enqueue rather than lie to the user.
    return null;
  }

  const dest = new File(pendingDir(), `${id}.jpg`);
  try {
    // Node's fs.copyFile is atomic w.r.t. the source. expo-file-system's copy
    // is not documented as atomic on Android, but for our case (single-writer,
    // no concurrent copy) that's fine.
    source.copy(dest);
    return dest.uri;
  } catch {
    return null;
  }
}

/**
 * Delete a queued image file. Errors are swallowed — the entry has already
 * been removed from AsyncStorage; a leftover file is a minor disk-space leak,
 * not a correctness issue.
 */
function deleteImage(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Ignore — see comment above.
  }
}

// --- Public API: enqueue --------------------------------------------------

export interface EnqueueInput {
  barcodeValue: string;
  labelType: string;
  /** The original cache-directory URI from expo-camera. Will be copied. */
  imageUri: string;
  /** Categorised failure that caused the enqueue — surfaced back to the UI. */
  cause: VerificationError;
}

export type EnqueueResult =
  | { ok: true; entry: QueueEntry }
  | { ok: false; reason: 'no-image' };

/**
 * Persist a scan for later sync. Returns `ok:false` when the image can't be
 * copied — the caller should then surface an error instead of pretending the
 * scan is safely queued.
 */
export async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const persistedUri = persistImage(input.imageUri, id);
  if (!persistedUri) {
    return { ok: false, reason: 'no-image' };
  }

  const entry: QueueEntry = {
    id,
    createdAt: Date.now(),
    barcodeValue: input.barcodeValue,
    labelType: input.labelType,
    imageUri: persistedUri,
    attemptCount: 0,
    lastAttemptAt: null,
    lastError: input.cause,
  };

  const current = await readQueue();
  await writeQueue([...current, entry]);
  emit();
  return { ok: true, entry };
}

/** Current queue length. Cheap — reads the in-memory cache. */
export async function getPendingCount(): Promise<number> {
  const entries = await readQueue();
  return entries.length;
}

/** Snapshot of the current queue (for the Settings screen). */
export async function getEntries(): Promise<QueueEntry[]> {
  const entries = await readQueue();
  return entries.slice();
}

// --- Public API: sync -----------------------------------------------------

let isSyncing = false;

export type SyncResult = {
  /** How many entries left the queue successfully. */
  synced: number;
  /** How many stayed in the queue with a lastError (server rejected, etc.). */
  failed: number;
  /** How many were dropped because their image file went missing. */
  dropped: number;
  /**
   * True when the sync stopped early because the connection dropped. Callers
   * may show a "back offline" message in that case.
   */
  aborted: boolean;
};

/**
 * Try to drain the queue. Safe to call concurrently — a second caller is a
 * no-op while the first is in flight. Returns aggregate counts so the caller
 * (Settings "Retry pending" button) can show a toast/summary.
 */
export async function syncQueue(): Promise<SyncResult> {
  if (isSyncing) {
    return { synced: 0, failed: 0, dropped: 0, aborted: true };
  }
  isSyncing = true;

  let synced = 0;
  let failed = 0;
  let dropped = 0;
  let aborted = false;

  try {
    const startEntries = await readQueue();
    // Copy so we can iterate stably even as we mutate the underlying array.
    const ids = startEntries.map((e) => e.id);

    for (const id of ids) {
      const entries = await readQueue();
      const idx = entries.findIndex((e) => e.id === id);
      if (idx === -1) continue; // dequeued by a concurrent call — skip.
      const entry = entries[idx];

      // Image missing? Drop the entry with a log; no point retrying forever.
      const file = new File(entry.imageUri);
      if (!file.exists) {
        // eslint-disable-next-line no-console
        console.warn(
          `[offlineQueue] Dropping ${entry.id}: image no longer exists at ${entry.imageUri}`,
        );
        const next = entries.filter((e) => e.id !== id);
        await writeQueue(next);
        emit();
        dropped += 1;
        continue;
      }

      // Attempt the verify. We DON'T do anything with the returned
      // VerificationResult here — the backend already persisted it to the
      // audit log, and the HistoryScreen re-fetch will surface it. The queue
      // just needs to know "did the round-trip succeed".
      let result: VerificationResult | undefined;
      let error: VerificationError | undefined;
      try {
        result = await verifyLabel(entry.barcodeValue, entry.imageUri);
      } catch (e) {
        error =
          e instanceof VerificationCallError
            ? e.info
            : { kind: 'unknown', message: 'Something went wrong.' };
      }

      if (result) {
        // Success — dequeue + delete the persistent image.
        const now = await readQueue();
        const next = now.filter((e) => e.id !== id);
        await writeQueue(next);
        deleteImage(entry.imageUri);
        emit();
        synced += 1;
        continue;
      }

      // Failed. What kind?
      const kind = error?.kind ?? 'unknown';

      // Transport failures: we're back offline. Bump attempt count on this
      // entry and stop the whole sync — no point trying more.
      if (kind === 'network' || kind === 'timeout') {
        await markAttempt(id, error!);
        aborted = true;
        break;
      }

      // Server / unknown: keep queued, mark, continue with the rest — a bad
      // scan (e.g. missing image field discovered by the server) shouldn't
      // block otherwise-good ones behind it.
      await markAttempt(id, error!);
      failed += 1;
    }
  } finally {
    isSyncing = false;
  }

  return { synced, failed, dropped, aborted };
}

async function markAttempt(id: string, err: VerificationError): Promise<void> {
  const entries = await readQueue();
  const next = entries.map((e) =>
    e.id === id
      ? {
          ...e,
          attemptCount: e.attemptCount + 1,
          lastAttemptAt: Date.now(),
          lastError: err,
        }
      : e,
  );
  await writeQueue(next);
  emit();
}

// --- NetInfo-driven auto-retry -------------------------------------------

let netListenerRegistered = false;
// Debounce: NetInfo can fire multiple times per real connectivity event
// (especially on Android — CONNECTED → VALIDATED comes in two ticks). Coalesce.
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Wire up the connectivity listener that drains the queue when connectivity
 * comes back. Idempotent — call once at app boot. Does an initial `fetch()`
 * so we still auto-retry even if the app booted already-online with pending
 * items from a previous session.
 */
export function startSyncOrchestrator(): void {
  if (netListenerRegistered) return;
  netListenerRegistered = true;

  const trigger = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const count = await getPendingCount();
      if (count > 0) {
        void syncQueue();
      }
    }, 500);
  };

  NetInfo.addEventListener((state) => {
    // Both flags matter: `isConnected` says "the interface is up",
    // `isInternetReachable` says "we can actually reach the internet". On
    // captive-portal wifi the first is true but the second is false, and we
    // don't want to fire retries into a wall.
    if (state.isConnected && state.isInternetReachable) {
      trigger();
    }
  });

  // Also do a one-shot check at boot in case we're already online with a
  // non-empty queue left over from the previous session.
  NetInfo.fetch().then((state) => {
    if (state.isConnected && state.isInternetReachable) trigger();
  });
}
