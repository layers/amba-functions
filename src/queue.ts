/**
 * `ctx.queue.send` enqueues a generic background job. Supports `delay`
 * and `idempotency_key`. Idempotency keys dedupe within a 24h window.
 */

import { AmbaInternalError, AmbaValidationError, deserializeAmbaError } from './errors.js';
import type { QueueContext, QueueSendInput } from './types.js';

export interface QueueContextDeps {
  apiUrl: string;
  internalToken: string;
  projectId: string;
  requestId: string;
}

export class QueueContextImpl implements QueueContext {
  constructor(private readonly deps: QueueContextDeps) {}

  async send<TPayload = unknown>(input: QueueSendInput<TPayload>): Promise<{ job_id: string }> {
    if (!input.name) {
      throw new AmbaValidationError({
        code: 'schema_violation',
        message: 'queue.send requires { name }',
        request_id: this.deps.requestId,
      });
    }
    if (typeof input.delay_seconds === 'number' && input.delay_seconds < 0) {
      throw new AmbaValidationError({
        code: 'invalid_argument',
        message: 'queue.send: delay_seconds must be non-negative',
        request_id: this.deps.requestId,
      });
    }
    const url = `${this.deps.apiUrl.replace(/\/+$/, '')}/admin/projects/${encodeURIComponent(
      this.deps.projectId,
    )}/queue/send`;
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
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      if (json && typeof json === 'object') throw deserializeAmbaError(json, res.status);
      throw new AmbaInternalError({
        code: 'upstream_failure',
        message: `queue.send failed: HTTP ${res.status}`,
        request_id: this.deps.requestId,
      });
    }
    return (await res.json()) as { job_id: string };
  }
}
