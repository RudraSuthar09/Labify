/**
 * Settings — a read-only view of the operator-facing configuration.
 *
 * The primary audience is the factory-floor operator (or a support engineer
 * looking over their shoulder): when scans fail, this screen is the first place
 * to check whether the app is even pointed at the right backend. Values are
 * selectable so the operator can long-press to copy the URL and send it via
 * chat — this avoids adding an `expo-clipboard` dependency just for that.
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import env, { UNCONFIGURED_API_BASE_URL } from '../config/env';
import { pingBackend, type HealthCheckResult } from '../services/verification';
import { syncQueue, type QueueEntry, type SyncResult } from '../services/offlineQueue';
import { usePendingSync } from '../hooks/usePendingSync';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

type PingState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'done'; result: HealthCheckResult };

type SyncState =
  | { phase: 'idle' }
  | { phase: 'syncing' }
  | { phase: 'done'; result: SyncResult };

export default function SettingsScreen() {
  const [ping, setPing] = useState<PingState>({ phase: 'idle' });
  const [sync, setSync] = useState<SyncState>({ phase: 'idle' });
  const { entries, count } = usePendingSync();

  const handleTestConnection = useCallback(async () => {
    setPing({ phase: 'checking' });
    const result = await pingBackend();
    setPing({ phase: 'done', result });
  }, []);

  const handleRetryPending = useCallback(async () => {
    setSync({ phase: 'syncing' });
    const result = await syncQueue();
    setSync({ phase: 'done', result });
  }, []);

  // A URL that is missing entirely vs. the placeholder sentinel are the same
  // failure from the operator's perspective; render both as "not configured".
  const isConfigured =
    env.apiConfigured && env.apiBaseUrl !== UNCONFIGURED_API_BASE_URL;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {!isConfigured && (
          <View style={styles.warningCard}>
            <Text style={styles.warningTitle}>Backend URL not configured</Text>
            <Text style={styles.warningBody}>
              This build is missing the API_BASE_URL environment variable, so no
              scans will succeed. Reinstall a build that was published with the
              correct URL, or contact your administrator.
            </Text>
          </View>
        )}

        <Section title="Backend">
          <Field label="API Base URL">
            <Text style={styles.mono} selectable>
              {isConfigured ? env.apiBaseUrl : 'Not configured'}
            </Text>
          </Field>
          <Field label="OCR Provider">
            <Text style={styles.value} selectable>
              {env.ocrProvider}
            </Text>
          </Field>

          <View style={styles.testBlock}>
            <Pressable
              style={[
                styles.testButton,
                (ping.phase === 'checking' || !isConfigured) && styles.testButtonDisabled,
              ]}
              onPress={handleTestConnection}
              disabled={ping.phase === 'checking' || !isConfigured}
            >
              {ping.phase === 'checking' ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.testButtonText}>Test connection</Text>
              )}
            </Pressable>
            <PingStatus ping={ping} />
          </View>
        </Section>

        <Section title={`Pending Sync${count > 0 ? ` · ${count}` : ''}`}>
          <PendingSyncSection
            entries={entries}
            sync={sync}
            onRetry={handleRetryPending}
            isConfigured={isConfigured}
          />
        </Section>

        <Section title="Device">
          <Field label="Platform">
            <Text style={styles.value}>
              {Platform.OS} {String(Platform.Version)}
            </Text>
          </Field>
        </Section>

        <Text style={styles.footNote}>
          Tip: tap and hold the URL to copy it.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function PendingSyncSection({
  entries,
  sync,
  onRetry,
  isConfigured,
}: {
  entries: QueueEntry[];
  sync: SyncState;
  onRetry: () => void;
  isConfigured: boolean;
}) {
  if (entries.length === 0) {
    return (
      <View style={styles.pendingEmpty}>
        <Text style={styles.pendingEmptyText}>
          No scans waiting to sync. Scans made offline will appear here.
        </Text>
        <SyncResultCard sync={sync} />
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      {entries.map((e) => (
        <PendingRow key={e.id} entry={e} />
      ))}

      <Pressable
        onPress={onRetry}
        disabled={sync.phase === 'syncing' || !isConfigured}
        style={[
          styles.retryButton,
          (sync.phase === 'syncing' || !isConfigured) && styles.retryButtonDisabled,
        ]}
      >
        {sync.phase === 'syncing' ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.retryButtonText}>Retry pending ({entries.length})</Text>
        )}
      </Pressable>
      <SyncResultCard sync={sync} />
    </View>
  );
}

function PendingRow({ entry }: { entry: QueueEntry }) {
  const errored = entry.lastError && entry.lastError.kind !== 'network' && entry.lastError.kind !== 'timeout';
  return (
    <View style={[styles.pendingRow, errored ? styles.pendingRowErrored : null]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.pendingRowBarcode} numberOfLines={1} selectable>
          {entry.barcodeValue}
        </Text>
        <Text style={styles.pendingRowMeta}>
          {formatShortDate(entry.createdAt)} · {entry.attemptCount} attempt
          {entry.attemptCount === 1 ? '' : 's'}
        </Text>
        {errored && entry.lastError ? (
          <Text style={styles.pendingRowError} numberOfLines={2}>
            Server: {entry.lastError.message}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function SyncResultCard({ sync }: { sync: SyncState }) {
  if (sync.phase === 'idle') return null;
  if (sync.phase === 'syncing') {
    return <Text style={styles.pingHint}>Syncing…</Text>;
  }
  const { synced, failed, dropped, aborted } = sync.result;
  const parts: string[] = [];
  if (synced > 0) parts.push(`${synced} synced`);
  if (failed > 0) parts.push(`${failed} still failing`);
  if (dropped > 0) parts.push(`${dropped} dropped (image missing)`);
  if (aborted) parts.push('stopped — offline again');
  return (
    <View style={styles.syncResultBox}>
      <Text style={styles.syncResultText}>
        {parts.length === 0 ? 'Nothing to sync.' : parts.join(' · ')}
      </Text>
    </View>
  );
}

/** "Jul 8, 14:32" — used in the pending-row meta line. */
function formatShortDate(ts: number): string {
  const d = new Date(ts);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = d.getHours() < 10 ? `0${d.getHours()}` : String(d.getHours());
  const mm = d.getMinutes() < 10 ? `0${d.getMinutes()}` : String(d.getMinutes());
  return `${months[d.getMonth()]} ${d.getDate()}, ${hh}:${mm}`;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function PingStatus({ ping }: { ping: PingState }) {
  if (ping.phase === 'idle') {
    return (
      <Text style={styles.pingHint}>
        Sends a GET /health to the backend. Confirms the app can reach it.
      </Text>
    );
  }
  if (ping.phase === 'checking') {
    return <Text style={styles.pingHint}>Checking… (a cold server may take up to 30s)</Text>;
  }
  const { result } = ping;
  if (result.ok) {
    return (
      <View style={styles.pingOkBox}>
        <Text style={styles.pingOkTitle}>Reachable · {result.latencyMs} ms</Text>
        {result.timestamp && (
          <Text style={styles.pingOkDetail}>Server time: {result.timestamp}</Text>
        )}
      </View>
    );
  }
  return (
    <View style={styles.pingFailBox}>
      <Text style={styles.pingFailTitle}>
        {result.error.kind === 'timeout'
          ? 'Timed out'
          : result.error.kind === 'network'
            ? 'Not reachable'
            : result.error.kind === 'server'
              ? 'Server error'
              : 'Failed'}
      </Text>
      <Text style={styles.pingFailDetail}>{result.error.message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F4F6' },
  content: { padding: 16, gap: 20 },

  warningCard: {
    backgroundColor: '#FEF2F2',
    borderLeftWidth: 4,
    borderLeftColor: '#DC2626',
    borderRadius: 10,
    padding: 14,
    gap: 6,
  },
  warningTitle: { fontSize: 15, fontWeight: '800', color: '#991B1B' },
  warningBody: { fontSize: 13, color: '#7F1D1D', lineHeight: 19 },

  section: { gap: 6 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginLeft: 4,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    gap: 14,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },

  field: { gap: 3 },
  fieldLabel: { fontSize: 12, fontWeight: '600', color: '#6B7280' },
  value: { fontSize: 15, color: '#111827' },
  mono: { fontSize: 14, fontFamily: MONO, color: '#111827' },

  testBlock: { gap: 8, marginTop: 2 },
  testButton: {
    backgroundColor: '#0a7ea4',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  testButtonDisabled: { backgroundColor: '#9CA3AF' },
  testButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  pingHint: { fontSize: 12, color: '#6B7280', lineHeight: 17 },

  pingOkBox: {
    backgroundColor: '#ECFDF5',
    borderRadius: 8,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#16A34A',
    gap: 2,
  },
  pingOkTitle: { fontSize: 13, fontWeight: '700', color: '#065F46' },
  pingOkDetail: { fontSize: 12, color: '#065F46', fontFamily: MONO },

  pingFailBox: {
    backgroundColor: '#FEF2F2',
    borderRadius: 8,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#DC2626',
    gap: 2,
  },
  pingFailTitle: { fontSize: 13, fontWeight: '700', color: '#991B1B' },
  pingFailDetail: { fontSize: 12, color: '#7F1D1D', lineHeight: 17 },

  footNote: { fontSize: 12, color: '#9CA3AF', textAlign: 'center', marginTop: 4 },

  pendingEmpty: { gap: 8 },
  pendingEmptyText: { fontSize: 13, color: '#6B7280', lineHeight: 19 },

  pendingRow: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
    padding: 10,
    gap: 2,
  },
  pendingRowErrored: {
    borderColor: '#DC2626',
    backgroundColor: '#FEF2F2',
  },
  pendingRowBarcode: { fontSize: 14, fontFamily: MONO, color: '#111827' },
  pendingRowMeta: { fontSize: 12, color: '#6B7280', marginTop: 2 },
  pendingRowError: { fontSize: 12, color: '#991B1B', marginTop: 4 },

  retryButton: {
    backgroundColor: '#F59E0B',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
    marginTop: 4,
  },
  retryButtonDisabled: { backgroundColor: '#9CA3AF' },
  retryButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  syncResultBox: {
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    padding: 8,
    marginTop: 4,
  },
  syncResultText: { fontSize: 12, color: '#374151' },
});
