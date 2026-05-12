/**
 * `ctx.auth` implementation.
 *
 * Pure value object — userId/developerId are populated from the dispatch
 * headers parsed and HMAC-verified by `defineFunction`'s wrapper. The
 * class exists primarily for the `assertUser` / `assertDeveloper`
 * convenience methods.
 */

import { AmbaAuthError } from './errors.js';
import type { AuthContext } from './types.js';

export interface AuthInputs {
  userId: string | null;
  developerId: string | null;
  requestId: string;
}

export class AuthContextImpl implements AuthContext {
  readonly userId: string | null;
  readonly developerId: string | null;
  private readonly requestId: string;

  constructor(input: AuthInputs) {
    this.userId = input.userId;
    this.developerId = input.developerId;
    this.requestId = input.requestId;
  }

  assertUser(): string {
    if (!this.userId) {
      throw new AmbaAuthError({
        code: 'auth_required',
        message: 'This function requires an authenticated end-user.',
        request_id: this.requestId,
      });
    }
    return this.userId;
  }

  assertDeveloper(): string {
    if (!this.developerId) {
      throw new AmbaAuthError({
        code: 'developer_auth_required',
        message: 'This function requires a developer Bearer token.',
        request_id: this.requestId,
      });
    }
    return this.developerId;
  }
}
