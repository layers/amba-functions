/**
 * `ctx.email.send` — POSTs to the amba API which routes through your email
 * provider. Suppression-aware: the API silently logs `email.suppressed`
 * if the recipient is on the suppression list.
 */

import {
  AmbaInternalError,
  AmbaNotFoundError,
  AmbaValidationError,
  deserializeAmbaError,
} from './errors.js';
import type { EmailContext, EmailSendInput } from './types.js';

export interface EmailContextDeps {
  apiUrl: string;
  internalToken: string;
  projectId: string;
  requestId: string;
}

export class EmailContextImpl implements EmailContext {
  constructor(private readonly deps: EmailContextDeps) {}

  async send(input: EmailSendInput): Promise<{ id: string }> {
    if (!input.to) {
      throw new AmbaValidationError({
        code: 'schema_violation',
        message: 'email.send requires { to }',
        request_id: this.deps.requestId,
      });
    }
    const isTemplated = 'template' in input && typeof input.template === 'string';
    const isAdHoc = 'subject' in input && typeof input.subject === 'string';
    if (!isTemplated && !isAdHoc) {
      throw new AmbaValidationError({
        code: 'schema_violation',
        message: 'email.send requires { template } or { subject }',
        request_id: this.deps.requestId,
      });
    }

    const url = `${this.deps.apiUrl.replace(/\/+$/, '')}/admin/internal/email/send`;
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
        code: 'resource_not_found',
        message: 'email.send: template or user_id not found',
        request_id: this.deps.requestId,
        details: { resource: 'email_template_or_user' },
      });
    }
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      if (json && typeof json === 'object') throw deserializeAmbaError(json, res.status);
      throw new AmbaInternalError({
        code: 'upstream_failure',
        message: `email.send failed: HTTP ${res.status}`,
        request_id: this.deps.requestId,
      });
    }
    return (await res.json()) as { id: string };
  }
}
