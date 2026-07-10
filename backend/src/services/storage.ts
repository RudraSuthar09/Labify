/**
 * Image storage service — persistent archive of scanned label photos.
 *
 * The rest of the app depends only on the {@link StorageProvider} interface and
 * the {@link getStorageProvider} factory. Swapping Cloudinary for S3 or local
 * disk is therefore a matter of adding a new class here; callers are untouched.
 *
 * The factory returns `undefined` when storage is not configured — persistence
 * is an optional feature and verification must succeed either way.
 */
import { v2 as cloudinary } from 'cloudinary';

import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * A pluggable object store. Implementations receive an already-processed image
 * buffer plus a destination path and return the public URL to fetch it back.
 */
export interface StorageProvider {
  /** Stable identifier, e.g. "cloudinary" — used in logs. */
  readonly name: string;
  /**
   * Upload an image and return a URL that resolves to the stored object.
   * Throws on transport/auth/quota failures — callers translate that into a
   * logged warning (verification is not blocked on storage).
   */
  uploadImage(buffer: Buffer, filename: string): Promise<string>;
}

/**
 * Cloudinary implementation. The SDK auto-configures from the CLOUDINARY_URL
 * environment variable (cloudinary://<key>:<secret>@<cloud_name>), so enabling
 * the feature is a single line in .env — no bucket to create, no keys to wire.
 *
 * The returned URL is Cloudinary's HTTPS `secure_url`, which resolves publicly
 * without a signed link.
 */
export class CloudinaryStorage implements StorageProvider {
  readonly name = 'cloudinary';
  private readonly folder: string;

  constructor(folder: string) {
    // `secure: true` guarantees https URLs. Credentials come from CLOUDINARY_URL
    // which the SDK reads automatically; calling config() with no creds keeps
    // that behaviour while letting us force secure URLs.
    cloudinary.config({ secure: true });
    this.folder = folder;
  }

  async uploadImage(buffer: Buffer, filename: string): Promise<string> {
    // `public_id` is the filename without extension; Cloudinary derives the
    // format from the uploaded bytes. We pass the date-partitioned path so the
    // media library mirrors the scans/YYYY/MM/DD layout.
    const publicId = `${this.folder}/${filename.replace(/\.[^.]+$/, '')}`;

    const url = await new Promise<string>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { public_id: publicId, resource_type: 'image', overwrite: false },
        (error, result) => {
          if (error || !result) {
            reject(new Error(`Cloudinary upload failed: ${error?.message ?? 'no result'}`));
            return;
          }
          resolve(result.secure_url);
        },
      );
      stream.end(buffer);
    });

    return url;
  }
}

let cachedProvider: StorageProvider | undefined;
let resolved = false;

/**
 * Return the configured storage provider, or `undefined` when persistence is
 * not enabled (missing CLOUDINARY_URL). Construction is cached; the
 * enabled/disabled decision is logged once on first call.
 */
export function getStorageProvider(): StorageProvider | undefined {
  if (resolved) return cachedProvider;
  resolved = true;

  if (!env.CLOUDINARY_URL) {
    logger.info(
      'Image storage is disabled (CLOUDINARY_URL unset) — scans will be ' +
        'verified but not archived.',
    );
    return undefined;
  }

  cachedProvider = new CloudinaryStorage(env.CLOUDINARY_FOLDER);
  logger.info(
    { provider: cachedProvider.name, folder: env.CLOUDINARY_FOLDER },
    'Image storage provider initialised',
  );
  return cachedProvider;
}

/** Test seam: clear the cached provider (e.g. after changing env in a test). */
export function resetStorageProvider(): void {
  cachedProvider = undefined;
  resolved = false;
}
