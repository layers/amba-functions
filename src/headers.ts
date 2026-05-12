/**
 * HMAC verification for the dispatched request signing scheme.
 * Internal — do not call directly.
 */

import { AmbaAuthError } from './errors.js';

// ─── Header names ──────────────────────────────────────────────────────

export const EDGE_HEADER_PROJECT_ID = 'X-Amba-Project-Id';
export const EDGE_HEADER_USER_ID = 'X-Amba-User-Id';
export const EDGE_HEADER_DEVELOPER_ID = 'X-Amba-Developer-Id';
export const EDGE_HEADER_REQUEST_ID = 'X-Amba-Request-Id';
export const EDGE_HEADER_FUNCTION_NAME = 'X-Amba-Function-Name';
export const EDGE_HEADER_TIMESTAMP = 'X-Amba-Edge-Timestamp';
export const EDGE_HEADER_SIGNATURE = 'X-Amba-Edge-Signature';

/** Replay-protection window in seconds. */
export const EDGE_HEADER_REPLAY_WINDOW_SECONDS = 60;

// ─── Canonical signing input ───────────────────────────────────────────

/**
 * Build the canonical string fed into HMAC-SHA256. Order is fixed.
 */
export function canonicalEdgeHeaderInput(parts: {
  projectId: string;
  userId: string;
  developerId: string;
  requestId: string;
  functionName: string;
  timestampSeconds: number;
}): string {
  return [
    'v1',
    parts.projectId,
    parts.userId,
    parts.developerId,
    parts.requestId,
    parts.functionName,
    parts.timestampSeconds.toString(),
  ].join('\n');
}

// ─── Crypto helpers ────────────────────────────────────────────────────

/** Constant-time string comparison for HMAC signatures. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function hexEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

/** Compute HMAC-SHA256 of `message` with `secret` and return hex. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return hexEncode(new Uint8Array(sig));
}

// ─── Parsed shape ──────────────────────────────────────────────────────

export interface ParsedDispatchHeaders {
  projectId: string;
  requestId: string;
  functionName: string;
  userId: string | null;
  developerId: string | null;
  timestampSeconds: number;
  signature: string;
}

/**
 * Read the dispatch headers off a Request. Throws
 * `AmbaAuthError(401, 'invalid_token')` if any header is missing or the
 * timestamp is unparseable. Does NOT verify the HMAC — call
 * {@link verifyDispatchHeaders} after parsing.
 */
export function parseDispatchHeaders(req: Request): ParsedDispatchHeaders {
  const projectId = req.headers.get(EDGE_HEADER_PROJECT_ID);
  const requestId = req.headers.get(EDGE_HEADER_REQUEST_ID);
  const functionName = req.headers.get(EDGE_HEADER_FUNCTION_NAME);
  const timestampRaw = req.headers.get(EDGE_HEADER_TIMESTAMP);
  const signature = req.headers.get(EDGE_HEADER_SIGNATURE);
  const userIdRaw = req.headers.get(EDGE_HEADER_USER_ID);
  const developerIdRaw = req.headers.get(EDGE_HEADER_DEVELOPER_ID);

  if (
    projectId === null ||
    requestId === null ||
    functionName === null ||
    timestampRaw === null ||
    signature === null ||
    userIdRaw === null ||
    developerIdRaw === null
  ) {
    throw new AmbaAuthError({
      code: 'invalid_token',
      message: 'Required amba dispatch header is missing',
      status: 401,
    });
  }

  const timestampSeconds = Number.parseInt(timestampRaw, 10);
  if (!Number.isFinite(timestampSeconds)) {
    throw new AmbaAuthError({
      code: 'invalid_token',
      message: 'Invalid X-Amba-Edge-Timestamp header',
      status: 401,
    });
  }

  return {
    projectId,
    requestId,
    functionName,
    userId: userIdRaw === '' ? null : userIdRaw,
    developerId: developerIdRaw === '' ? null : developerIdRaw,
    timestampSeconds,
    signature,
  };
}

/**
 * Verify the parsed headers against the shared secret. Returns the parsed
 * headers on success; throws `AmbaAuthError(401, 'invalid_token')` if the
 * timestamp is outside the replay window or the recomputed HMAC doesn't
 * match the supplied signature.
 */
export async function verifyDispatchHeaders(
  parsed: ParsedDispatchHeaders,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<ParsedDispatchHeaders> {
  const skew = Math.abs(nowSec - parsed.timestampSeconds);
  if (skew > EDGE_HEADER_REPLAY_WINDOW_SECONDS) {
    throw new AmbaAuthError({
      code: 'invalid_token',
      message: 'Dispatch signature outside replay window',
      status: 401,
    });
  }

  const expected = await hmacSha256Hex(
    secret,
    canonicalEdgeHeaderInput({
      projectId: parsed.projectId,
      userId: parsed.userId ?? '',
      developerId: parsed.developerId ?? '',
      requestId: parsed.requestId,
      functionName: parsed.functionName,
      timestampSeconds: parsed.timestampSeconds,
    }),
  );

  if (!constantTimeEqual(expected, parsed.signature)) {
    throw new AmbaAuthError({
      code: 'invalid_token',
      message: 'Dispatch signature verification failed',
      status: 401,
    });
  }
  return parsed;
}
