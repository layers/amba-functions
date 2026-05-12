/**
 * `ctx.storage` — direct R2 binding + media-asset row tracking.
 *
 * `upload` writes the object to R2 (`env.STORAGE.put`) and inserts a media
 * asset row via the amba API so the rest of the platform's media surfaces
 * continue to work. `delete` mirrors that — soft-delete the row, and the
 * media-asset cleanup flow handles R2 deletion.
 */

import {
  AmbaInternalError,
  AmbaNotFoundError,
  AmbaValidationError,
  deserializeAmbaError,
} from './errors.js';
import type {
  R2BucketLike,
  StorageContext,
  StorageDeleteInput,
  StoragePresignInput,
  StoragePresignResult,
  StorageUploadInput,
  StorageUploadResult,
} from './types.js';

export interface StorageContextDeps {
  apiUrl: string;
  internalToken: string;
  projectId: string;
  requestId: string;
  r2: R2BucketLike | undefined;
  cdnHost: string | undefined;
}

export class StorageContextImpl implements StorageContext {
  constructor(private readonly deps: StorageContextDeps) {}

  async upload(input: StorageUploadInput): Promise<StorageUploadResult> {
    if (!input.bucket) {
      throw new AmbaValidationError({
        code: 'schema_violation',
        message: 'storage.upload requires { bucket }',
        request_id: this.deps.requestId,
      });
    }
    if (!this.deps.r2) {
      throw new AmbaInternalError({
        code: 'storage_unavailable',
        message: 'storage binding not wired on this script.',
        request_id: this.deps.requestId,
      });
    }

    const key = input.key ?? generateObjectKey();
    const objectKey = `${input.bucket}/${key}`;
    await this.deps.r2.put(objectKey, input.body, {
      httpMetadata: input.content_type ? { contentType: input.content_type } : undefined,
      customMetadata: input.metadata,
    });

    // Track the asset via the API so downstream media surfaces stay consistent.
    const url = `${this.deps.apiUrl.replace(/\/+$/, '')}/admin/projects/${encodeURIComponent(
      this.deps.projectId,
    )}/media/track`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.deps.internalToken}`,
        'x-amba-project-id': this.deps.projectId,
        'x-amba-request-id': this.deps.requestId,
      },
      body: JSON.stringify({
        bucket: input.bucket,
        key,
        content_type: input.content_type,
        retention_days: input.retention_days,
        metadata: input.metadata,
      }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      if (json && typeof json === 'object') {
        throw deserializeAmbaError(json, res.status);
      }
      throw new AmbaInternalError({
        code: 'upstream_failure',
        message: `storage.upload track failed: HTTP ${res.status}`,
        request_id: this.deps.requestId,
      });
    }
    const tracked = (await res.json()) as { id: string; url?: string };
    if (tracked.url) {
      return { id: tracked.id, url: tracked.url, key };
    }
    if (!this.deps.cdnHost) {
      throw new AmbaInternalError({
        code: 'storage_unavailable',
        message:
          'storage.upload: CDN host (AMBA_CDN_HOST) is not configured on this script; cannot return a public URL.',
        request_id: this.deps.requestId,
      });
    }
    return {
      id: tracked.id,
      url: `https://${this.deps.cdnHost}/${objectKey}`,
      key,
    };
  }

  async delete(input: StorageDeleteInput): Promise<void> {
    if (!input.id && !(input.bucket && input.key)) {
      throw new AmbaValidationError({
        code: 'schema_violation',
        message: 'storage.delete requires either { id } or { bucket, key }',
        request_id: this.deps.requestId,
      });
    }
    const url = `${this.deps.apiUrl.replace(/\/+$/, '')}/admin/projects/${encodeURIComponent(
      this.deps.projectId,
    )}/media/delete`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.deps.internalToken}`,
        'x-amba-project-id': this.deps.projectId,
        'x-amba-request-id': this.deps.requestId,
      },
      body: JSON.stringify(input),
    });
    if (res.status === 404) {
      throw new AmbaNotFoundError({
        code: input.id ? 'row_not_found' : 'object_not_found',
        message: 'No media asset matches the supplied address',
        request_id: this.deps.requestId,
        details: { resource: 'media_asset' },
      });
    }
    if (!res.ok) {
      throw new AmbaInternalError({
        code: 'upstream_failure',
        message: `storage.delete failed: HTTP ${res.status}`,
        request_id: this.deps.requestId,
      });
    }
  }

  async presign(input: StoragePresignInput): Promise<StoragePresignResult> {
    if (!input.bucket || !input.key || !input.method) {
      throw new AmbaValidationError({
        code: 'schema_violation',
        message: 'storage.presign requires { bucket, key, method }',
        request_id: this.deps.requestId,
      });
    }
    // Defer to the API — it constructs S3-style presigned URLs against R2.
    const url = `${this.deps.apiUrl.replace(/\/+$/, '')}/admin/projects/${encodeURIComponent(
      this.deps.projectId,
    )}/media/presign`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.deps.internalToken}`,
        'x-amba-project-id': this.deps.projectId,
        'x-amba-request-id': this.deps.requestId,
      },
      body: JSON.stringify(input),
    });
    if (res.status === 404) {
      throw new AmbaNotFoundError({
        code: 'bucket_not_found',
        message: `Bucket '${input.bucket}' or key '${input.key}' not found`,
        request_id: this.deps.requestId,
        details: { resource: 'storage_bucket' },
      });
    }
    if (!res.ok) {
      throw new AmbaInternalError({
        code: 'upstream_failure',
        message: `storage.presign failed: HTTP ${res.status}`,
        request_id: this.deps.requestId,
      });
    }
    return (await res.json()) as StoragePresignResult;
  }
}

/**
 * Generate a UUIDv4-shape object key. Workers expose `crypto.randomUUID`
 * natively; Node 19+ does too. The fallback keeps tests deterministic if a
 * runner stubs `crypto`.
 */
function generateObjectKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as Crypto & { randomUUID(): string }).randomUUID();
  }
  return `obj-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
