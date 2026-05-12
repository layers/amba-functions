/**
 * `ctx.events.track` — engagement event recorder.
 *
 * Routing: when the dispatched request was end-user authed, POST to the
 * client events endpoint (the API auto-stamps `app_user_id` from the
 * bearer session). When the request was developer-authed, POST to the
 * admin project events endpoint. Customer code does not see this
 * distinction — `ctx.events.track` is one method.
 *
 * The `user_id` override lets a developer-authed function record events
 * on behalf of a specific user; rejected when the function is
 * end-user-authed because the API auto-stamps from the session JWT.
 */

import { AmbaInternalError, AmbaValidationError, deserializeAmbaError } from './errors.js';
import type { EventInput, EventsContext } from './types.js';

export interface EventsContextDeps {
  apiUrl: string;
  internalToken: string;
  projectId: string;
  authUserId: string | null;
  authDeveloperId: string | null;
  requestId: string;
}

export class EventsContextImpl implements EventsContext {
  constructor(private readonly deps: EventsContextDeps) {}

  async track(event: EventInput): Promise<void> {
    if (!event.name || typeof event.name !== 'string') {
      throw new AmbaValidationError({
        code: 'schema_violation',
        message: 'event.name is required',
        request_id: this.deps.requestId,
        details: { fields: [{ path: 'name', message: 'required' }] },
      });
    }

    const isAdminContext = this.deps.authDeveloperId !== null;
    // Route selection:
    //   1. audit: true              → /admin/projects/:p/audit-events
    //   2. developer-authed         → /admin/projects/:p/events
    //   3. end-user-authed (default) → /client/events
    // Audit events from end-user-authed routes are rejected here so the
    // SDK error happens before the wire round-trip; the API also rejects
    // for defense-in-depth.
    if (event.audit && !isAdminContext) {
      throw new AmbaValidationError({
        code: 'invalid_argument',
        message:
          'event.audit=true is only valid in developer-authed function context. End-user-authed routes cannot record audit events.',
        request_id: this.deps.requestId,
      });
    }
    // Audit events: server-only timestamps. The audit log forbids
    // back-dating — `created_at` is server-set and immutable. Reject
    // `occurred_at` synchronously here so caller intent doesn't get
    // silently dropped on the floor.
    if (event.audit && event.occurred_at !== undefined) {
      throw new AmbaValidationError({
        code: 'invalid_argument',
        message:
          'occurred_at is not permitted on audit events — back-dating is forbidden by the audit append-only contract (created_at is server-set).',
        request_id: this.deps.requestId,
        details: { fields: [{ path: 'occurred_at', message: 'forbidden when audit=true' }] },
      });
    }
    const path = event.audit
      ? `/admin/projects/${encodeURIComponent(this.deps.projectId)}/audit-events`
      : isAdminContext
        ? `/admin/projects/${encodeURIComponent(this.deps.projectId)}/events`
        : `/client/events`;

    if (!isAdminContext && event.user_id) {
      // End-user context already implies a user; supplying user_id would
      // be ambiguous (does it override the session?). Reject early.
      throw new AmbaValidationError({
        code: 'invalid_argument',
        message:
          'event.user_id can only be set when the function is developer-authed; remove it for end-user-authed routes.',
        request_id: this.deps.requestId,
      });
    }

    const url = `${this.deps.apiUrl.replace(/\/+$/, '')}${path}`;
    // The audit-events endpoint expects `event_name`; the legacy events
    // endpoints expect `event`. Translate at the route-selection layer so
    // customer code always uses `event.name` regardless of destination.
    const body = event.audit
      ? JSON.stringify({
          event_name: event.name,
          user_id: event.user_id,
          properties: event.properties ?? {},
        })
      : JSON.stringify({
          event: event.name,
          user_id: event.user_id,
          properties: event.properties ?? {},
          occurred_at: event.occurred_at,
        });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.deps.internalToken}`,
        'x-amba-project-id': this.deps.projectId,
        'x-amba-request-id': this.deps.requestId,
      },
      body,
    });

    if (!res.ok) {
      const json = await res.json().catch(() => null);
      if (json && typeof json === 'object') {
        throw deserializeAmbaError(json, res.status);
      }
      throw new AmbaInternalError({
        code: 'upstream_failure',
        message: `events.track failed: HTTP ${res.status}`,
        request_id: this.deps.requestId,
      });
    }
  }
}
