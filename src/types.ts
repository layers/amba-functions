/**
 * Shared types for `@layers/amba-functions`.
 *
 * Notes on Cloudflare-Workers types:
 *   - We avoid pulling in `@cloudflare/workers-types` as a direct dep so the
 *     SDK stays trim and consumable from non-Worker contexts (tests,
 *     type-check from a docs build, etc.). Instead we declare the minimum
 *     bindings we touch (`R2Bucket`, `Hyperdrive`, `Fetcher`) here. Customer
 *     code that needs the full Workers type surface installs
 *     `@cloudflare/workers-types` separately.
 */

// ─── Worker bindings (minimal shapes we actually use) ───────────────────

/** Minimal R2 binding shape (matches @cloudflare/workers-types `R2Bucket`). */
export interface R2BucketLike {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectLike | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface R2ObjectLike {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

/**
 * Minimal Hyperdrive binding shape.
 *
 * The SDK abstracts the binding behind {@link TenantDbBinding}; this type
 * exists only so the runtime can detect whether a Hyperdrive binding is
 * present in `env`.
 */
export interface HyperdriveLike {
  connectionString: string;
  /** `connect()` returns a node-postgres-compatible client. */
  connect(): unknown;
}

/** Minimal Fetcher binding (used for service bindings to other Workers). */
export interface FetcherLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

// ─── Env contract ───────────────────────────────────────────────────────
//
// `Env` is the type Cloudflare Workers expects on `ExportedHandler<Env>`.
// Customer Workers receive an `env` whose shape is a *superset* of this —
// they may add their own bindings (KV namespaces, Durable Objects, …).
// The SDK reads only the fields below; everything else is opaque.

export interface AmbaFunctionEnv {
  // ── amba-managed bindings ──

  /**
   * HMAC secret shared with the dispatcher for request-header signing &
   * verification. Set by the deploy tooling. Do not modify.
   */
  EDGE_HEADER_SIGNING_SECRET: string;

  /** Base URL of the amba control-plane API (e.g. `https://api.amba.dev`). */
  AMBA_API_URL: string;

  /** Service URL for the amba AI gateway. */
  AMBA_AI_GATEWAY_URL: string;

  /** Project id this script is deployed under. */
  AMBA_PROJECT_ID: string;

  /**
   * Internal API token the SDK presents on amba-API calls. Set by the
   * deploy tooling. Do not modify.
   */
  AMBA_INTERNAL_TOKEN: string;

  // ── Tenant-DB binding (one of these is present) ──

  /** Cloudflare Hyperdrive binding. */
  HYPERDRIVE?: HyperdriveLike;

  /** Service binding to the tenant DB proxy. */
  EDGE_DB_PROXY?: FetcherLike;

  // ── Storage binding ──

  /** Per-project R2 bucket binding. */
  STORAGE?: R2BucketLike;

  /**
   * CDN host for the project. Used to construct public object URLs. Set at
   * deploy time.
   */
  AMBA_CDN_HOST?: string;

  // ── Customer-set Workers Secrets land here as string values. ──
  [key: string]: unknown;
}

// ─── Public Context shape ──────────────────────────────────────────────

export interface AuthContext {
  /**
   * End-user id when the request carried a valid session token; null
   * otherwise (including unauthenticated routes such as public webhooks).
   * Customer code MUST handle both branches.
   */
  readonly userId: string | null;

  /**
   * Developer id when the request used a developer Bearer token; null
   * when the request was end-user authed or unauthed.
   */
  readonly developerId: string | null;

  /** Returns `userId` or throws `AmbaAuthError(401, 'auth_required')`. */
  assertUser(): string;

  /** Returns `developerId` or throws `AmbaAuthError(401, 'developer_auth_required')`. */
  assertDeveloper(): string;
}

// ── Collections DSL ──

export type WhereClause<TRow> = {
  [K in keyof TRow]?:
    | TRow[K]
    | { eq: TRow[K] }
    | { ne: TRow[K] }
    | { gt: TRow[K] }
    | { gte: TRow[K] }
    | { lt: TRow[K] }
    | { lte: TRow[K] }
    | { in: TRow[K][] }
    | { notIn: TRow[K][] }
    | { like: string }
    | { ilike: string }
    | { isNull: true }
    | { isNotNull: true };
} & {
  and?: WhereClause<TRow>[];
  or?: WhereClause<TRow>[];
  not?: WhereClause<TRow>;
};

export type CreateInput<TRow> = Omit<TRow, 'id' | 'created_at' | 'updated_at' | 'deleted_at'>;

export interface FindQuery<TRow> {
  where?: WhereClause<TRow>;
  order?:
    | `${string} asc`
    | `${string} desc`
    | string
    | (`${string} asc` | `${string} desc` | string)[];
  limit?: number;
  offset?: number;
  cursor?: string;
  select?: (keyof TRow)[];
  includeDeleted?: boolean;
}

export interface UpdateQuery<TRow> {
  where: WhereClause<TRow>;
  set: Partial<Omit<TRow, 'id' | 'created_at' | 'updated_at' | 'deleted_at'>>;
  limit?: number;
}

export interface DeleteQuery<TRow> {
  where: WhereClause<TRow>;
  limit?: number;
}

export interface Collection<TRow extends Record<string, unknown>> {
  create(input: CreateInput<TRow>): Promise<TRow>;
  find(query?: FindQuery<TRow>): Promise<TRow[]>;
  findOne(query?: FindQuery<TRow>): Promise<TRow | null>;
  count(query?: Pick<FindQuery<TRow>, 'where' | 'includeDeleted'>): Promise<number>;
  update(query: UpdateQuery<TRow>): Promise<TRow[]>;
  delete(query: DeleteQuery<TRow>): Promise<{ count: number }>;
  asUser(userId: string): Collection<TRow>;
}

export type CollectionsRoot = {
  readonly [name: string]: Collection<Record<string, unknown>>;
};

// ── Tenant DB binding abstraction ──

export interface TenantDbBinding {
  /**
   * Run a parameterised SQL statement against the tenant DB and return the
   * result rows. Implementations MUST treat `params` as positional bind
   * parameters (`$1`, `$2`, …), never string-substituted into `sql`.
   */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
}

// ── Other ctx.* sub-shapes ──

export interface EventInput {
  name: string;
  user_id?: string;
  properties?: Record<string, unknown>;
  occurred_at?: string;
  /**
   * Route to the append-only audit-events log instead of engagement events.
   * Append-only is enforced at the storage layer.
   *
   * Rejected on end-user-authed routes — audit events require
   * developer-authed context.
   *
   * Customer code that sets `audit: true` on a routine event should be
   * reviewed: audit events are immutable and forever-retained.
   */
  audit?: boolean;
}

export interface EventsContext {
  track(event: EventInput): Promise<void>;
}

export interface StorageUploadInput {
  bucket: string;
  key?: string;
  body: ReadableStream | ArrayBuffer | Blob | string;
  content_type?: string;
  retention_days?: number;
  metadata?: Record<string, string>;
}

export interface StorageUploadResult {
  id: string;
  url: string;
  key: string;
}

export interface StorageDeleteInput {
  id?: string;
  bucket?: string;
  key?: string;
}

export interface StoragePresignInput {
  bucket: string;
  key: string;
  method: 'GET' | 'PUT';
  expires_in_seconds?: number;
}

export interface StoragePresignResult {
  url: string;
  expires_at: string;
}

export interface StorageContext {
  upload(input: StorageUploadInput): Promise<StorageUploadResult>;
  delete(input: StorageDeleteInput): Promise<void>;
  presign(input: StoragePresignInput): Promise<StoragePresignResult>;
}

/**
 * Anthropic-shaped surface. Mirrors the official SDK's method shape but
 * keeps types loose (`unknown`) so customers can swap to the real
 * `@anthropic-ai/sdk` without re-declaring this surface, AND so this
 * package doesn't pull in Anthropic types as a hard dep. Customers who
 * want strict Anthropic typing import `@anthropic-ai/sdk` and cast.
 */
export interface AnthropicContext {
  readonly messages: {
    create(params: unknown): Promise<unknown>;
    stream(params: unknown): AsyncIterable<unknown>;
  };
}

export interface OpenAiContext {
  readonly chat: {
    readonly completions: {
      create(params: unknown): Promise<unknown>;
    };
  };
}

export interface EmbeddingsCreateInput {
  provider: 'anthropic' | 'openai';
  model: string;
  input: string | string[];
}

export interface EmbeddingsCreateResult {
  embeddings: number[][];
  usage: { input_tokens: number };
}

export interface AiContext {
  readonly anthropic: AnthropicContext;
  readonly openai: OpenAiContext;
  readonly embeddings: {
    create(input: EmbeddingsCreateInput): Promise<EmbeddingsCreateResult>;
  };
}

export type EmailSendInput =
  | { to: { user_id: string }; template: string; data?: Record<string, unknown> }
  | { to: { email: string }; template: string; data?: Record<string, unknown> }
  | { to: { email: string }; subject: string; html?: string; text?: string };

export interface EmailContext {
  send(input: EmailSendInput): Promise<{ id: string }>;
}

export interface QueueSendInput<TPayload = unknown> {
  name: string;
  payload: TPayload;
  delay_seconds?: number;
  idempotency_key?: string;
}

export interface QueueContext {
  send<TPayload = unknown>(input: QueueSendInput<TPayload>): Promise<{ job_id: string }>;
}

export interface FanOutForUsersInput {
  segment_id: string;
  invoke: { function: string; payload?: Record<string, unknown> };
  delivery_window?: { local_hour_start: number; local_hour_end: number };
}

export interface FanOutContext {
  forUsersInSegment(
    input: FanOutForUsersInput,
  ): Promise<{ batch_count: number; estimated_user_count: number }>;
}

export interface SecretsContext {
  /**
   * Synchronous lookup against Workers Secrets bound to this script.
   * Returns `null` if the secret is not bound. Customer code that requires
   * a secret should assert non-null at the call site.
   */
  get(name: string): string | null;
}

export interface Context {
  readonly auth: AuthContext;
  readonly collections: CollectionsRoot;
  readonly events: EventsContext;
  readonly storage: StorageContext;
  readonly ai: AiContext;
  readonly email: EmailContext;
  readonly queue: QueueContext;
  readonly fanOut: FanOutContext;
  readonly secrets: SecretsContext;
  readonly fetch: typeof fetch;
  readonly projectId: string;
  readonly functionName: string;
  readonly invocationId: string;
}
