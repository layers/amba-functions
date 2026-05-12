/**
 * `defineFunction` — the entry point customers import.
 *
 * Returns a Workers `ExportedHandler<Env>` whose `fetch` runs:
 *
 *   1. Parse + HMAC-verify the dispatch headers (rejects with
 *      `AmbaAuthError(401)` on missing/expired/invalid signatures).
 *   2. Construct `ctx` from the verified payload + `env` bindings.
 *   3. Invoke the customer handler.
 *   4. Catch uncaught errors, serialize to the wire JSON shape, and
 *      return them with the matching HTTP status.
 *
 * The wrapping `try/catch` ensures every non-`AmbaError` thrown from
 * customer code becomes an `AmbaInternalError` on the wire — never a
 * 500 with a stack trace leaked to the caller.
 */

import { AuthContextImpl } from './auth.js';
import { makeCollectionsRoot, selectTenantDbBinding } from './collections.js';
import { createAiContext } from './ai.js';
import { EmailContextImpl } from './email.js';
import { EventsContextImpl } from './events.js';
import {
  AmbaError,
  AmbaInternalError,
  AmbaTenantUnavailableError,
  serializeAmbaError,
} from './errors.js';
import { FanOutContextImpl } from './fan-out.js';
import { parseDispatchHeaders, verifyDispatchHeaders } from './headers.js';
import { QueueContextImpl } from './queue.js';
import { SecretsContextImpl } from './secrets.js';
import { StorageContextImpl } from './storage.js';
import type { AmbaFunctionEnv, Context, TenantDbBinding } from './types.js';

export type FunctionHandler = (req: Request, ctx: Context) => Promise<Response> | Response;

/**
 * Cloudflare Workers `ExportedHandler` shape — minimal so we don't pull in
 * `@cloudflare/workers-types` as a hard dep. Customer scripts that
 * already include those types will see a structurally-compatible result.
 */
export interface FunctionExportedHandler {
  fetch(req: Request, env: AmbaFunctionEnv, executionCtx?: unknown): Promise<Response>;
}

export interface DefineFunctionOptions {
  /**
   * Override the tenant-DB binding used by `ctx.collections`. Test-only —
   * production callers leave this `undefined` and the runtime selects the
   * binding based on `env`.
   */
  tenantDbBinding?: TenantDbBinding;
  /**
   * Skip HMAC verification of dispatch headers. Test-only.
   * Customer code MUST NOT pass this in production — the dispatcher
   * refuses to dispatch without signing the headers, and the SDK refuses
   * to accept them without verifying. The escape hatch exists so tests
   * can exercise customer-handler logic without minting fixture HMACs.
   */
  unsafeSkipVerification?: boolean;
}

export function defineFunction(
  handler: FunctionHandler,
  options: DefineFunctionOptions = {},
): FunctionExportedHandler {
  return {
    async fetch(req, env): Promise<Response> {
      let requestId: string | null = null;
      try {
        // 1. Headers — parse first, verify second so missing-header errors
        //    don't pay the crypto cost.
        const parsed = parseDispatchHeaders(req);
        requestId = parsed.requestId;

        if (!options.unsafeSkipVerification) {
          if (!env.EDGE_HEADER_SIGNING_SECRET) {
            throw new AmbaInternalError({
              code: 'server_misconfigured',
              message: 'EDGE_HEADER_SIGNING_SECRET binding missing on script',
              request_id: requestId,
            });
          }
          await verifyDispatchHeaders(parsed, env.EDGE_HEADER_SIGNING_SECRET);
        }

        // 2. Build ctx — tenant-DB binding selection happens once per
        //    request so a missing binding fails fast.
        const tenantBinding =
          options.tenantDbBinding ?? selectTenantDbBinding(env, env.AMBA_INTERNAL_TOKEN ?? '');

        // Collections is exposed lazily — if the binding is absent and
        // the customer never touches ctx.collections, we don't fail.
        const collections = tenantBinding
          ? makeCollectionsRoot(tenantBinding, requestId)
          : makeMissingTenantBindingProxy(parsed.projectId, requestId);

        const auth = new AuthContextImpl({
          userId: parsed.userId,
          developerId: parsed.developerId,
          requestId,
        });

        const ctx: Context = {
          auth,
          collections,
          events: new EventsContextImpl({
            apiUrl: env.AMBA_API_URL,
            internalToken: env.AMBA_INTERNAL_TOKEN,
            projectId: parsed.projectId,
            authUserId: parsed.userId,
            authDeveloperId: parsed.developerId,
            requestId,
          }),
          storage: new StorageContextImpl({
            apiUrl: env.AMBA_API_URL,
            internalToken: env.AMBA_INTERNAL_TOKEN,
            projectId: parsed.projectId,
            requestId,
            r2: env.STORAGE,
            cdnHost: env.AMBA_CDN_HOST,
          }),
          ai: createAiContext({
            gatewayUrl: env.AMBA_AI_GATEWAY_URL,
            internalToken: env.AMBA_INTERNAL_TOKEN,
            projectId: parsed.projectId,
            requestId,
            authUserId: parsed.userId,
            authDeveloperId: parsed.developerId,
          }),
          email: new EmailContextImpl({
            apiUrl: env.AMBA_API_URL,
            internalToken: env.AMBA_INTERNAL_TOKEN,
            projectId: parsed.projectId,
            requestId,
          }),
          queue: new QueueContextImpl({
            apiUrl: env.AMBA_API_URL,
            internalToken: env.AMBA_INTERNAL_TOKEN,
            projectId: parsed.projectId,
            requestId,
          }),
          fanOut: new FanOutContextImpl({
            apiUrl: env.AMBA_API_URL,
            internalToken: env.AMBA_INTERNAL_TOKEN,
            projectId: parsed.projectId,
            requestId,
          }),
          secrets: new SecretsContextImpl(env),
          fetch: globalThis.fetch.bind(globalThis),
          projectId: parsed.projectId,
          functionName: parsed.functionName,
          invocationId: parsed.requestId,
        };

        // 3. Customer handler.
        return await handler(req, ctx);
      } catch (err) {
        if (err instanceof AmbaError) {
          return errorToResponse(err);
        }
        // Non-AmbaError → wrap in AmbaInternalError so we never leak a
        // raw stack trace across the wire.
        const wrapped = new AmbaInternalError({
          code: 'unhandled_exception',
          message: err instanceof Error ? err.message : String(err),
          request_id: requestId,
          cause: err,
        });
        return errorToResponse(wrapped);
      }
    },
  };
}

function errorToResponse(err: AmbaError): Response {
  return new Response(JSON.stringify(serializeAmbaError(err)), {
    status: err.status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * If neither `env.HYPERDRIVE` nor `env.EDGE_DB_PROXY` is bound, we still
 * want `ctx.collections.x.find(...)` to fail with a typed error rather
 * than `undefined.find is not a function`. Build a Proxy whose every
 * method throws `AmbaTenantUnavailableError`.
 */
function makeMissingTenantBindingProxy(projectId: string, requestId: string) {
  const handler: ProxyHandler<object> = {
    get() {
      const fail = () => {
        throw new AmbaTenantUnavailableError({
          code: 'tenant_not_provisioned',
          message: 'Tenant DB binding (HYPERDRIVE or EDGE_DB_PROXY) is not bound to this script.',
          details: { project_id: projectId, tenant_status: 'provisioning' },
          request_id: requestId,
        });
      };
      const collProxy: ProxyHandler<object> = {
        get(_t, p) {
          if (typeof p !== 'string') return undefined;
          if (p === 'asUser') {
            return () => new Proxy(Object.create(null), collProxy);
          }
          return () => Promise.reject(fail());
        },
      };
      return new Proxy(Object.create(null), collProxy);
    },
  };
  return new Proxy(Object.create(null), handler) as never;
}
