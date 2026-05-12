/**
 * `ctx.fanOut.forUsersInSegment` — POSTs to the amba API which fans the
 * invocation out across every user in the named segment.
 */

import {
  AmbaInternalError,
  AmbaNotFoundError,
  AmbaValidationError,
  deserializeAmbaError,
} from './errors.js';
import type { FanOutContext, FanOutForUsersInput } from './types.js';

export interface FanOutContextDeps {
  apiUrl: string;
  internalToken: string;
  projectId: string;
  requestId: string;
}

export class FanOutContextImpl implements FanOutContext {
  constructor(private readonly deps: FanOutContextDeps) {}

  async forUsersInSegment(
    input: FanOutForUsersInput,
  ): Promise<{ batch_count: number; estimated_user_count: number }> {
    if (!input.segment_id) {
      throw new AmbaValidationError({
        code: 'schema_violation',
        message: 'fanOut requires { segment_id }',
        request_id: this.deps.requestId,
      });
    }
    if (!input.invoke?.function) {
      throw new AmbaValidationError({
        code: 'schema_violation',
        message: 'fanOut requires { invoke.function }',
        request_id: this.deps.requestId,
      });
    }
    const url = `${this.deps.apiUrl.replace(/\/+$/, '')}/admin/projects/${encodeURIComponent(
      this.deps.projectId,
    )}/fan-out/segment`;
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
        code: 'segment_or_function_not_found',
        message: 'fanOut: segment or function not found',
        request_id: this.deps.requestId,
        details: { resource: 'segment_or_function' },
      });
    }
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      if (json && typeof json === 'object') throw deserializeAmbaError(json, res.status);
      throw new AmbaInternalError({
        code: 'upstream_failure',
        message: `fanOut failed: HTTP ${res.status}`,
        request_id: this.deps.requestId,
      });
    }
    return (await res.json()) as {
      batch_count: number;
      estimated_user_count: number;
    };
  }
}
