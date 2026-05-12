/**
 * `ctx.secrets.get` — synchronous lookup against Workers Secrets bound to
 * the dispatched script.
 *
 * Workers Secrets land on `env` as plain string properties (CF runtime
 * contract). The convention is that customer-managed secrets are uppercase
 * underscore-separated names (`STRIPE_KEY`, `OPENAI_API_KEY`). amba-managed
 * bindings (anything starting with `AMBA_` or `EDGE_`, plus the
 * dispatch-binding names `HYPERDRIVE` / `STORAGE` / `EDGE_DB_PROXY`) are
 * excluded so customer code can't accidentally read the dispatch HMAC, the
 * internal API token, or any future amba-controlled binding.
 *
 * Returns `null` when the secret isn't bound. Customers that require a
 * secret are expected to assert non-null at the call site.
 */

import type { AmbaFunctionEnv, SecretsContext } from './types.js';

const RESERVED_EXACT_KEYS = new Set<string>(['HYPERDRIVE', 'STORAGE', 'EDGE_DB_PROXY']);

const RESERVED_KEY_PREFIXES = ['AMBA_', 'EDGE_'] as const;

function isReservedKey(name: string): boolean {
  if (RESERVED_EXACT_KEYS.has(name)) return true;
  for (const prefix of RESERVED_KEY_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

export class SecretsContextImpl implements SecretsContext {
  constructor(private readonly env: AmbaFunctionEnv) {}

  get(name: string): string | null {
    if (isReservedKey(name)) return null;
    const value = (this.env as Record<string, unknown>)[name];
    if (typeof value !== 'string') return null;
    return value;
  }
}
