/**
 * Image storage service — persistent archive of scanned label photos.
 *
 * The rest of the app depends only on the {@link StorageProvider} interface and
 * the {@link getStorageProvider} factory. Swapping Supabase for S3 or local disk
 * is therefore a matter of adding a new class here; callers are untouched.
 *
 * The factory returns `undefined` when storage is not configured — persistence
 * is an optional feature and verification must succeed either way.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * A pluggable object store. Implementations receive an already-processed image
 * buffer plus a destination path and return the public URL to fetch it back.
 */
export interface StorageProvider {
  /** Stable identifier, e.g. "supabase" — used in logs. */
  readonly name: string;
  /**
   * Upload an image and return a URL that resolves to the stored object.
   * Throws on transport/auth/quota failures — callers translate that into a
   * logged warning (verification is not blocked on storage).
   */
  uploadImage(buffer: Buffer, filename: string): Promise<string>;
}

/**
 * Supabase Storage implementation. Uses the service-role key so uploads bypass
 * RLS — the client is server-only and must never be exposed to the frontend.
 *
 * The returned URL is the public URL for the object; the bucket must be public
 * for it to resolve without a signed link. For a private bucket, swap
 * `getPublicUrl` for `createSignedUrl(path, ttl)`.
 */
export class SupabaseStorage implements StorageProvider {
  readonly name = 'supabase';
  private readonly client: SupabaseClient;
  private readonly bucket: string;

  constructor(url: string, serviceKey: string, bucket: string) {
    this.client = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    this.bucket = bucket;
  }

  async uploadImage(buffer: Buffer, filename: string): Promise<string> {
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(filename, buffer, {
        contentType: 'image/jpeg',
        upsert: false,
      });

    if (error) {
      throw new Error(`Supabase upload failed: ${error.message}`);
    }

    const { data } = this.client.storage.from(this.bucket).getPublicUrl(filename);
    return data.publicUrl;
  }
}

let cachedProvider: StorageProvider | undefined;
let resolved = false;

/**
 * Return the configured storage provider, or `undefined` when persistence is
 * not enabled (missing SUPABASE_URL / SUPABASE_SERVICE_KEY). Construction is
 * cached; the enabled/disabled decision is logged once on first call.
 */
export function getStorageProvider(): StorageProvider | undefined {
  if (resolved) return cachedProvider;
  resolved = true;

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    logger.info(
      'Image storage is disabled (SUPABASE_URL / SUPABASE_SERVICE_KEY unset) — ' +
        'scans will be verified but not archived.',
    );
    return undefined;
  }

  cachedProvider = new SupabaseStorage(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY,
    env.SUPABASE_STORAGE_BUCKET,
  );
  logger.info(
    { provider: cachedProvider.name, bucket: env.SUPABASE_STORAGE_BUCKET },
    'Image storage provider initialised',
  );
  return cachedProvider;
}

/** Test seam: clear the cached provider (e.g. after changing env in a test). */
export function resetStorageProvider(): void {
  cachedProvider = undefined;
  resolved = false;
}
