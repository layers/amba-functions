/**
 * Error taxonomy for `@layers/amba-functions`.
 *
 * Every error thrown across the SDK boundary inherits from `AmbaError`. The
 * hierarchy is exposed from this package (for Worker code) so
 * `if (err instanceof AmbaAuthError)` works on the customer side.
 *
 * All subclasses pin a literal `kind` so customer code can switch on
 * `err.kind` without an `instanceof` chain. The serialized JSON shape used
 * on the wire is documented at the bottom of this file
 * (`AmbaErrorJsonBody` + `serializeAmbaError`).
 */

export type AmbaErrorKind =
  | 'auth'
  | 'not_found'
  | 'validation'
  | 'rate_limit'
  | 'tenant_unavailable'
  | 'internal';

export interface AmbaErrorOptions {
  status: number;
  code: string;
  message: string;
  /** Stable identifier for support / logs. UUIDv7 when generated server-side. */
  request_id?: string | null;
  /** Subclass-specific structured payload. */
  details?: unknown;
  /** Underlying cause if any (e.g. wrapped upstream provider error). */
  cause?: unknown;
}

/**
 * Base error class. Never thrown directly — always one of the subclasses.
 * `kind` is a `readonly` literal on each subclass so `switch (err.kind)`
 * narrows correctly without an explicit cast.
 */
export abstract class AmbaError extends Error {
  abstract readonly kind: AmbaErrorKind;
  readonly status: number;
  readonly code: string;
  readonly request_id: string | null;
  readonly details?: unknown;
  override readonly cause?: unknown;

  constructor(options: AmbaErrorOptions) {
    super(options.message);
    this.name = this.constructor.name;
    this.status = options.status;
    this.code = options.code;
    this.request_id = options.request_id ?? null;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

// ─── Subclasses ────────────────────────────────────────────────────────

export type AmbaAuthCode =
  | 'auth_required'
  | 'developer_auth_required'
  | 'invalid_token'
  | 'as_user_mismatch'
  | 'project_mismatch'
  | 'forbidden';

export class AmbaAuthError extends AmbaError {
  readonly kind = 'auth' as const;
  declare readonly status: 401 | 403;
  declare readonly code: AmbaAuthCode;

  constructor(
    options: Omit<AmbaErrorOptions, 'status' | 'code'> & {
      status?: 401 | 403;
      code: AmbaAuthCode;
    },
  ) {
    super({ ...options, status: options.status ?? 401 });
  }
}

export interface AmbaNotFoundDetails {
  resource: string;
  id?: string;
}

export class AmbaNotFoundError extends AmbaError {
  readonly kind = 'not_found' as const;
  override readonly status = 404 as const;
  declare readonly details?: AmbaNotFoundDetails;

  constructor(options: Omit<AmbaErrorOptions, 'status'> & { details?: AmbaNotFoundDetails }) {
    super({ ...options, status: 404 });
  }
}

export interface AmbaValidationFieldError {
  path: string;
  message: string;
  received?: unknown;
  expected?: string;
}

export interface AmbaValidationDetails {
  fields: AmbaValidationFieldError[];
}

export class AmbaValidationError extends AmbaError {
  readonly kind = 'validation' as const;
  override readonly status = 400 as const;
  declare readonly details: AmbaValidationDetails;

  constructor(
    options: Omit<AmbaErrorOptions, 'status' | 'details'> & {
      details?: AmbaValidationDetails;
    },
  ) {
    super({ ...options, status: 400, details: options.details ?? { fields: [] } });
    this.details = options.details ?? { fields: [] };
  }
}

export interface AmbaRateLimitDetails {
  retry_after_seconds: number;
  scope: string;
  window: string;
  max: number;
}

export class AmbaRateLimitError extends AmbaError {
  readonly kind = 'rate_limit' as const;
  override readonly status = 429 as const;
  declare readonly code: 'rate_limited';
  declare readonly details: AmbaRateLimitDetails;

  constructor(
    options: Omit<AmbaErrorOptions, 'status' | 'code' | 'details'> & {
      details: AmbaRateLimitDetails;
    },
  ) {
    super({ ...options, status: 429, code: 'rate_limited', details: options.details });
    this.details = options.details;
  }
}

export interface AmbaTenantUnavailableDetails {
  project_id: string;
  /**
   * Lifecycle state of the tenant: one of `'provisioning' | 'suspended' |
   * 'failed' | 'archived' | 'unavailable'`. Customer code should treat any
   * non-empty value as "retry later" unless it's `'failed'` or `'archived'`,
   * which require operator action.
   */
  tenant_status: string;
  retry_after_seconds?: number;
}

export class AmbaTenantUnavailableError extends AmbaError {
  readonly kind = 'tenant_unavailable' as const;
  override readonly status = 503 as const;
  declare readonly code: 'tenant_not_provisioned' | 'tenant_unavailable';
  declare readonly details: AmbaTenantUnavailableDetails;

  constructor(
    options: Omit<AmbaErrorOptions, 'status' | 'code' | 'details'> & {
      code: 'tenant_not_provisioned' | 'tenant_unavailable';
      details: AmbaTenantUnavailableDetails;
    },
  ) {
    super({ ...options, status: 503, details: options.details });
    this.code = options.code;
    this.details = options.details;
  }
}

export class AmbaInternalError extends AmbaError {
  readonly kind = 'internal' as const;
  declare readonly status: 500 | 502 | 504;

  constructor(options: Omit<AmbaErrorOptions, 'status'> & { status?: 500 | 502 | 504 }) {
    super({ ...options, status: options.status ?? 500 });
  }
}

// ─── Discriminated-union convenience ───────────────────────────────────

export type AnyAmbaError =
  | AmbaAuthError
  | AmbaNotFoundError
  | AmbaValidationError
  | AmbaRateLimitError
  | AmbaTenantUnavailableError
  | AmbaInternalError;

export function isAmbaError(e: unknown): e is AnyAmbaError {
  return e instanceof AmbaError;
}

// ─── Wire serialization ─────────────────────────────────────────────────

export interface AmbaErrorJsonBody {
  error: {
    kind: AmbaErrorKind;
    code: string;
    status: number;
    message: string;
    request_id: string | null;
    details?: unknown;
  };
}

export function serializeAmbaError(err: AmbaError): AmbaErrorJsonBody {
  const body: AmbaErrorJsonBody['error'] = {
    kind: err.kind,
    code: err.code,
    status: err.status,
    message: err.message,
    request_id: err.request_id,
  };
  if (err.details !== undefined) body.details = err.details;
  return { error: body };
}

/**
 * Inverse of `serializeAmbaError`. Rehydrates typed errors from the wire
 * body. Defensive against missing / malformed payloads — falls back to
 * `AmbaInternalError` so the caller still sees an AmbaError.
 */
export function deserializeAmbaError(body: unknown, fallbackStatus = 500): AmbaError {
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return new AmbaInternalError({
      status: (fallbackStatus as 500 | 502 | 504) ?? 500,
      code: 'server_error',
      message: 'Unrecognized error response',
    });
  }
  const e = (body as { error: Partial<AmbaErrorJsonBody['error']> }).error;
  const message = e.message ?? 'Unknown error';
  const requestId = e.request_id ?? null;

  switch (e.kind) {
    case 'auth':
      return new AmbaAuthError({
        status: e.status === 403 ? 403 : 401,
        code: (e.code ?? 'invalid_token') as AmbaAuthCode,
        message,
        request_id: requestId,
        details: e.details,
      });
    case 'not_found':
      return new AmbaNotFoundError({
        code: e.code ?? 'not_found',
        message,
        request_id: requestId,
        details: e.details as AmbaNotFoundDetails | undefined,
      });
    case 'validation':
      return new AmbaValidationError({
        code: e.code ?? 'schema_violation',
        message,
        request_id: requestId,
        details: e.details as AmbaValidationDetails | undefined,
      });
    case 'rate_limit':
      return new AmbaRateLimitError({
        message,
        request_id: requestId,
        details: (e.details as AmbaRateLimitDetails | undefined) ?? {
          retry_after_seconds: 1,
          scope: 'unknown',
          window: '60s',
          max: 0,
        },
      });
    case 'tenant_unavailable':
      return new AmbaTenantUnavailableError({
        code: (e.code === 'tenant_not_provisioned'
          ? 'tenant_not_provisioned'
          : 'tenant_unavailable') as 'tenant_not_provisioned' | 'tenant_unavailable',
        message,
        request_id: requestId,
        details: (e.details as AmbaTenantUnavailableDetails | undefined) ?? {
          project_id: 'unknown',
          tenant_status: 'unknown',
        },
      });
    case 'internal':
    default:
      return new AmbaInternalError({
        status: (e.status === 502 || e.status === 504 ? e.status : 500) as 500 | 502 | 504,
        code: e.code ?? 'server_error',
        message,
        request_id: requestId,
      });
  }
}
