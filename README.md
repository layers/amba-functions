# @layers/amba-functions

The SDK customer Cloudflare Workers import to build amba functions.

`defineFunction` wraps your handler with HMAC verification of the incoming
dispatched request and constructs a typed `ctx` object exposing auth,
collections, AI, events, storage, email, queue, fan-out, and secrets.

## Install

```sh
npm install @layers/amba-functions
# or: pnpm add @layers/amba-functions
# or: yarn add @layers/amba-functions
```

## Usage

```ts
import { defineFunction } from '@layers/amba-functions';

export default defineFunction(async (req, ctx) => {
  const userId = ctx.auth.assertUser();
  const letters = await ctx.collections.letters.asUser(userId).find();
  return Response.json({ letters });
});
```

The handler receives the Worker `Request` and a `ctx`:

- `ctx.auth` — `userId` / `developerId`, plus `assertUser()` / `assertDeveloper()`.
- `ctx.collections.<name>` — typed CRUD against your tenant database.
- `ctx.ai.anthropic` / `ctx.ai.openai` / `ctx.ai.embeddings` — proxied AI calls.
- `ctx.events.track({ name, properties })` — record an engagement event.
- `ctx.storage` — `upload`, `delete`, `presign` against your project's R2.
- `ctx.email.send` — templated or ad-hoc transactional email.
- `ctx.queue.send` — enqueue a background job.
- `ctx.fanOut.forUsersInSegment` — invoke a function for every user in a segment.
- `ctx.secrets.get('STRIPE_KEY')` — read a Workers Secret bound to this script.

Errors thrown by the SDK are subclasses of `AmbaError` (`AmbaAuthError`,
`AmbaNotFoundError`, `AmbaValidationError`, `AmbaRateLimitError`,
`AmbaTenantUnavailableError`, `AmbaInternalError`).

## License

MIT
