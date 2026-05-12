/**
 * `@layers/amba-functions` — public entry point.
 *
 * The package customers import inside a Cloudflare Worker:
 *
 *   import { defineFunction } from '@layers/amba-functions';
 *   export default defineFunction(async (req, ctx) => {
 *     const userId = ctx.auth.assertUser();
 *     const posts = await ctx.collections.posts.asUser(userId).find();
 *     return Response.json({ posts });
 *   });
 */

export { defineFunction } from './define-function.js';
export type {
  DefineFunctionOptions,
  FunctionExportedHandler,
  FunctionHandler,
} from './define-function.js';

export type {
  AmbaFunctionEnv,
  AuthContext,
  AiContext,
  AnthropicContext,
  Collection,
  CollectionsRoot,
  Context,
  CreateInput,
  DeleteQuery,
  EmailContext,
  EmailSendInput,
  EmbeddingsCreateInput,
  EmbeddingsCreateResult,
  EventInput,
  EventsContext,
  FanOutContext,
  FanOutForUsersInput,
  FetcherLike,
  FindQuery,
  HyperdriveLike,
  OpenAiContext,
  QueueContext,
  QueueSendInput,
  R2BucketLike,
  R2ObjectLike,
  SecretsContext,
  StorageContext,
  StorageDeleteInput,
  StoragePresignInput,
  StoragePresignResult,
  StorageUploadInput,
  StorageUploadResult,
  TenantDbBinding,
  UpdateQuery,
  WhereClause,
} from './types.js';

export {
  AmbaAuthError,
  AmbaError,
  AmbaInternalError,
  AmbaNotFoundError,
  AmbaRateLimitError,
  AmbaTenantUnavailableError,
  AmbaValidationError,
  deserializeAmbaError,
  isAmbaError,
  serializeAmbaError,
} from './errors.js';
export type {
  AmbaAuthCode,
  AmbaErrorJsonBody,
  AmbaErrorKind,
  AmbaErrorOptions,
  AmbaNotFoundDetails,
  AmbaRateLimitDetails,
  AmbaTenantUnavailableDetails,
  AmbaValidationDetails,
  AmbaValidationFieldError,
  AnyAmbaError,
} from './errors.js';
