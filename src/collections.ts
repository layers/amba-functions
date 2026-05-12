/**
 * `ctx.collections.<name>` implementation.
 *
 * The collections root is a `Proxy` that returns a `CollectionImpl` per
 * accessed name (`ctx.collections.letters`, `ctx.collections.plans`, …).
 * Each `CollectionImpl` is a thin compiler from the typed query DSL
 * (`where`, `order`, `limit`, …) to parameterised SQL, executed via the
 * abstract {@link TenantDbBinding}.
 *
 * Two binding implementations live in this file. Tenant database access
 * binding. Used internally by the runtime.
 *
 * `.asUser(uid)` is a wrapper that AND's `WHERE user_id = $1` into every
 * subsequent query and rejects `create`/`update` payloads whose `user_id`
 * differs from `uid`. Calling `.asUser()` twice with the same uid is a
 * no-op; with a different uid throws synchronously.
 */

import { AmbaAuthError, AmbaTenantUnavailableError, AmbaValidationError } from './errors.js';
import type {
  AmbaFunctionEnv,
  Collection,
  CollectionsRoot,
  CreateInput,
  DeleteQuery,
  FetcherLike,
  FindQuery,
  HyperdriveLike,
  TenantDbBinding,
  UpdateQuery,
  WhereClause,
} from './types.js';

// ─── Binding implementations ───────────────────────────────────────────

/**
 * Connect via `env.HYPERDRIVE.connect()`. `connect()` returns a
 * node-postgres-compatible client.
 */
export class HyperdriveDbBinding implements TenantDbBinding {
  constructor(private readonly hyperdrive: HyperdriveLike) {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const client = this.hyperdrive.connect() as {
      query: (sql: string, params: unknown[]) => Promise<{ rows: T[] } | T[]>;
      end?: () => Promise<void>;
    };
    try {
      const result = await client.query(sql, params);
      const rows = Array.isArray(result) ? result : result.rows;
      return rows;
    } finally {
      // pg-compatible clients expose `.end()`; the Hyperdrive pooler may
      // expose nothing. Best-effort.
      await client.end?.().catch(() => {});
    }
  }
}

/**
 * Send queries to the tenant DB proxy via service binding. Used when the
 * Hyperdrive binding is absent.
 */
export class EdgeDbProxyBinding implements TenantDbBinding {
  constructor(
    private readonly fetcher: FetcherLike,
    private readonly projectId: string,
    private readonly internalToken: string,
  ) {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const res = await this.fetcher.fetch('https://edge-db-proxy/query', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.internalToken}`,
        'x-amba-project-id': this.projectId,
      },
      body: JSON.stringify({ sql, params }),
    });
    if (!res.ok) {
      if (res.status === 503) {
        throw new AmbaTenantUnavailableError({
          code: 'tenant_unavailable',
          message: `Tenant DB proxy unavailable for project ${this.projectId}`,
          details: { project_id: this.projectId, tenant_status: 'unavailable' },
        });
      }
      throw new Error(`Tenant DB proxy returned ${res.status}`);
    }
    const json = (await res.json()) as { rows: T[] };
    return json.rows;
  }
}

/**
 * Pick the right binding given the `env` shape. Caller asserts at least one
 * is present — `defineFunction`'s wrapper raises `AmbaTenantUnavailableError`
 * if neither is bound.
 */
export function selectTenantDbBinding(
  env: AmbaFunctionEnv,
  internalToken: string,
): TenantDbBinding | null {
  if (env.HYPERDRIVE) return new HyperdriveDbBinding(env.HYPERDRIVE);
  if (env.EDGE_DB_PROXY) {
    return new EdgeDbProxyBinding(env.EDGE_DB_PROXY, env.AMBA_PROJECT_ID, internalToken);
  }
  return null;
}

// ─── Proxy root ────────────────────────────────────────────────────────

/**
 * Build a `CollectionsRoot` Proxy. Each `.<name>` access returns a
 * `CollectionImpl`. Names starting with `_` are rejected at access time.
 */
export function makeCollectionsRoot(binding: TenantDbBinding, requestId: string): CollectionsRoot {
  const cache = new Map<string, Collection<Record<string, unknown>>>();
  const target = Object.create(null);
  return new Proxy(target, {
    get(_, prop): Collection<Record<string, unknown>> | undefined {
      if (typeof prop !== 'string') return undefined;
      if (prop.startsWith('_')) {
        throw new AmbaValidationError({
          code: 'invalid_argument',
          message: `Collection name '${prop}' is reserved (collections starting with '_' are not addressable from ctx).`,
          details: {
            fields: [
              {
                path: 'collection',
                message: 'reserved name',
                received: prop,
              },
            ],
          },
          request_id: requestId,
        });
      }
      let coll = cache.get(prop);
      if (!coll) {
        coll = new CollectionImpl(prop, binding, requestId, null);
        cache.set(prop, coll);
      }
      return coll;
    },
    has(_, prop) {
      return typeof prop === 'string' && !prop.startsWith('_');
    },
  }) as CollectionsRoot;
}

// ─── CollectionImpl ────────────────────────────────────────────────────

class CollectionImpl<TRow extends Record<string, unknown>> implements Collection<TRow> {
  private readonly tableName: string;

  constructor(
    private readonly name: string,
    private readonly binding: TenantDbBinding,
    private readonly requestId: string,
    /** `null` = project scope; non-null = `.asUser(uid)`-narrowed handle. */
    private readonly scopedUserId: string | null,
  ) {
    this.tableName = quoteIdent(`coll_${name}`);
  }

  asUser(userId: string): Collection<TRow> {
    if (!userId) {
      throw new AmbaValidationError({
        code: 'invalid_argument',
        message: '.asUser() requires a non-empty userId',
        request_id: this.requestId,
      });
    }
    if (this.scopedUserId === userId) return this;
    if (this.scopedUserId !== null && this.scopedUserId !== userId) {
      throw new AmbaAuthError({
        code: 'as_user_mismatch',
        message: `.asUser('${userId}') called on a handle already narrowed to '${this.scopedUserId}'.`,
        status: 403,
        request_id: this.requestId,
      });
    }
    return new CollectionImpl<TRow>(this.name, this.binding, this.requestId, userId);
  }

  async create(input: CreateInput<TRow>): Promise<TRow> {
    if (this.scopedUserId !== null) {
      const provided = (input as Record<string, unknown>)['user_id'];
      if (provided !== undefined && provided !== this.scopedUserId) {
        throw new AmbaAuthError({
          code: 'as_user_mismatch',
          message: 'create() payload user_id differs from .asUser() narrowing',
          status: 403,
          request_id: this.requestId,
        });
      }
      if (provided === undefined) {
        (input as Record<string, unknown>)['user_id'] = this.scopedUserId;
      }
    }
    const cols = Object.keys(input as object);
    if (cols.length === 0) {
      throw new AmbaValidationError({
        code: 'schema_violation',
        message: 'create() requires at least one field',
        request_id: this.requestId,
      });
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${this.tableName} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders}) RETURNING *`;
    const params = cols.map((c) => (input as Record<string, unknown>)[c]);
    const rows = await this.binding.query<TRow>(sql, params);
    if (!rows[0]) {
      throw new AmbaValidationError({
        code: 'schema_violation',
        message: 'Insert returned no rows',
        request_id: this.requestId,
      });
    }
    return rows[0];
  }

  async find(query: FindQuery<TRow> = {}): Promise<TRow[]> {
    const built = this.buildSelect(query);
    return this.binding.query<TRow>(built.sql, built.params);
  }

  async findOne(query: FindQuery<TRow> = {}): Promise<TRow | null> {
    const rows = await this.find({ ...query, limit: 1 });
    return rows[0] ?? null;
  }

  async count(query: Pick<FindQuery<TRow>, 'where' | 'includeDeleted'> = {}): Promise<number> {
    const params: unknown[] = [];
    const whereSql = this.buildWhere(query.where, params, query.includeDeleted ?? false);
    const sql = `SELECT COUNT(*)::int AS count FROM ${this.tableName} ${whereSql}`;
    const rows = await this.binding.query<{ count: number }>(sql, params);
    return rows[0]?.count ?? 0;
  }

  async update(query: UpdateQuery<TRow>): Promise<TRow[]> {
    if (!query.where) {
      throw new AmbaValidationError({
        code: 'schema_violation',
        message: 'update() requires an explicit where clause (use { where: {} } for "all")',
        request_id: this.requestId,
      });
    }
    if (this.scopedUserId !== null) {
      const setUid = (query.set as Record<string, unknown>)['user_id'];
      if (setUid !== undefined && setUid !== this.scopedUserId) {
        throw new AmbaAuthError({
          code: 'as_user_mismatch',
          message: 'update() set.user_id differs from .asUser() narrowing',
          status: 403,
          request_id: this.requestId,
        });
      }
    }
    const setKeys = Object.keys(query.set as object);
    if (setKeys.length === 0) {
      throw new AmbaValidationError({
        code: 'schema_violation',
        message: 'update() requires a non-empty set payload',
        request_id: this.requestId,
      });
    }
    for (const k of setKeys) {
      if (k === 'id' || k === 'created_at' || k === 'updated_at' || k === 'deleted_at') {
        throw new AmbaValidationError({
          code: 'schema_violation',
          message: `update() cannot set server-managed column '${k}'`,
          request_id: this.requestId,
          details: { fields: [{ path: `set.${k}`, message: 'server-managed' }] },
        });
      }
    }
    const params: unknown[] = [];
    const setFrags: string[] = [];
    for (const k of setKeys) {
      params.push((query.set as Record<string, unknown>)[k]);
      setFrags.push(`${quoteIdent(k)} = $${params.length}`);
    }
    setFrags.push(`updated_at = NOW()`);
    const whereSql = this.buildWhere(query.where, params, false);
    const limitSql = query.limit ? this.buildLimitForUpdate(query.limit, params) : '';
    const sql = `UPDATE ${this.tableName} SET ${setFrags.join(', ')} ${whereSql} ${limitSql} RETURNING *`;
    return this.binding.query<TRow>(sql, params);
  }

  async delete(query: DeleteQuery<TRow>): Promise<{ count: number }> {
    if (!query.where) {
      throw new AmbaValidationError({
        code: 'schema_violation',
        message: 'delete() requires an explicit where clause',
        request_id: this.requestId,
      });
    }
    const params: unknown[] = [];
    const whereSql = this.buildWhere(query.where, params, false);
    const limitSql = query.limit ? this.buildLimitForUpdate(query.limit, params) : '';
    // Soft delete only.
    const sql = `UPDATE ${this.tableName} SET deleted_at = NOW(), updated_at = NOW() ${whereSql} ${limitSql} RETURNING "id"`;
    const rows = await this.binding.query<{ id: string }>(sql, params);
    return { count: rows.length };
  }

  // ── SQL builder helpers ───────────────────────────────────────────────

  private buildSelect(query: FindQuery<TRow>): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const select =
      query.select && query.select.length > 0
        ? query.select.map((c) => quoteIdent(String(c))).join(', ')
        : '*';
    const whereSql = this.buildWhere(query.where, params, query.includeDeleted ?? false);
    const orderSql = this.buildOrder(query.order);
    const limit = Math.min(query.limit ?? 50, 1000);
    params.push(limit);
    let sql = `SELECT ${select} FROM ${this.tableName} ${whereSql} ${orderSql} LIMIT $${params.length}`;
    if (typeof query.offset === 'number' && query.offset > 0) {
      params.push(query.offset);
      sql += ` OFFSET $${params.length}`;
    }
    return { sql, params };
  }

  private buildWhere(
    where: WhereClause<TRow> | undefined,
    params: unknown[],
    includeDeleted: boolean,
  ): string {
    const fragments: string[] = [];
    if (!includeDeleted) fragments.push(`deleted_at IS NULL`);
    if (this.scopedUserId !== null) {
      params.push(this.scopedUserId);
      fragments.push(`"user_id" = $${params.length}`);
    }
    if (where) {
      const sub = compileWhere(where, params);
      if (sub) fragments.push(sub);
    }
    return fragments.length === 0 ? '' : `WHERE ${fragments.join(' AND ')}`;
  }

  private buildOrder(order: FindQuery<TRow>['order'] | undefined): string {
    if (!order) return '';
    const list = Array.isArray(order) ? order : [order];
    const compiled = list.map(compileOrderEntry).filter(Boolean);
    return compiled.length === 0 ? '' : `ORDER BY ${compiled.join(', ')}`;
  }

  private buildLimitForUpdate(limit: number, params: unknown[]): string {
    params.push(Math.min(limit, 10_000));
    return `AND "id" IN (SELECT "id" FROM ${this.tableName} ${
      this.scopedUserId !== null ? `WHERE "user_id" = $1` : ''
    } LIMIT $${params.length})`;
  }
}

// ─── Where clause compiler ─────────────────────────────────────────────

function compileWhere<TRow>(where: WhereClause<TRow>, params: unknown[]): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (key === 'and') {
      const subs = (value as WhereClause<TRow>[]).map((w) => compileWhere(w, params));
      parts.push(`(${subs.filter(Boolean).join(' AND ')})`);
    } else if (key === 'or') {
      const subs = (value as WhereClause<TRow>[]).map((w) => compileWhere(w, params));
      parts.push(`(${subs.filter(Boolean).join(' OR ')})`);
    } else if (key === 'not') {
      parts.push(`NOT (${compileWhere(value as WhereClause<TRow>, params)})`);
    } else {
      parts.push(compileColumnPredicate(key, value, params));
    }
  }
  return parts.length === 0 ? '' : parts.join(' AND ');
}

function compileColumnPredicate(column: string, value: unknown, params: unknown[]): string {
  const ident = quoteIdent(column);
  if (value === null) {
    return `${ident} IS NULL`;
  }
  if (typeof value !== 'object') {
    params.push(value);
    return `${ident} = $${params.length}`;
  }
  const obj = value as Record<string, unknown>;
  if ('eq' in obj) {
    params.push(obj['eq']);
    return `${ident} = $${params.length}`;
  }
  if ('ne' in obj) {
    params.push(obj['ne']);
    return `${ident} <> $${params.length}`;
  }
  if ('gt' in obj) {
    params.push(obj['gt']);
    return `${ident} > $${params.length}`;
  }
  if ('gte' in obj) {
    params.push(obj['gte']);
    return `${ident} >= $${params.length}`;
  }
  if ('lt' in obj) {
    params.push(obj['lt']);
    return `${ident} < $${params.length}`;
  }
  if ('lte' in obj) {
    params.push(obj['lte']);
    return `${ident} <= $${params.length}`;
  }
  if ('in' in obj) {
    params.push(obj['in']);
    return `${ident} = ANY($${params.length})`;
  }
  if ('notIn' in obj) {
    params.push(obj['notIn']);
    return `NOT (${ident} = ANY($${params.length}))`;
  }
  if ('like' in obj) {
    params.push(obj['like']);
    return `${ident} LIKE $${params.length}`;
  }
  if ('ilike' in obj) {
    params.push(obj['ilike']);
    return `${ident} ILIKE $${params.length}`;
  }
  if (obj['isNull'] === true) return `${ident} IS NULL`;
  if (obj['isNotNull'] === true) return `${ident} IS NOT NULL`;
  throw new AmbaValidationError({
    code: 'invalid_argument',
    message: `Unrecognized where operator on column '${column}'`,
    details: {
      fields: [{ path: `where.${column}`, message: 'unknown operator', received: value }],
    },
  });
}

function compileOrderEntry(entry: string): string {
  const m = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(asc|desc))?$/i.exec(entry.trim());
  if (!m) {
    throw new AmbaValidationError({
      code: 'invalid_argument',
      message: `Invalid order clause: ${entry}`,
      details: { fields: [{ path: 'order', message: 'syntax', received: entry }] },
    });
  }
  const col = quoteIdent(m[1]!);
  const dir = (m[2] ?? 'asc').toUpperCase();
  return `${col} ${dir}`;
}

/**
 * Quote a Postgres identifier. Throws on names containing characters that
 * don't fit `[a-zA-Z_][a-zA-Z0-9_]*`.
 */
function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new AmbaValidationError({
      code: 'invalid_argument',
      message: `Invalid identifier: '${name}'`,
      details: { fields: [{ path: 'identifier', message: 'syntax', received: name }] },
    });
  }
  return `"${name}"`;
}
