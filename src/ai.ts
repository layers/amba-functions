/**
 * `ctx.ai` — proxies through the amba AI gateway.
 *
 * The Anthropic surface mirrors `@anthropic-ai/sdk` exactly so customer
 * code can swap between the official SDK and `ctx.ai.anthropic` with no
 * signature changes. Prompt-cache headers (`anthropic-beta`,
 * `cache_control` blocks in body) pass through byte-for-byte.
 *
 * The OpenAI surface is shaped the same way (signatures align with `OpenAI`
 * SDK). Embeddings is provider-agnostic.
 *
 * The gateway URL comes from `env.AMBA_AI_GATEWAY_URL`. The gateway holds
 * provider keys, applies rate limits, and writes usage events — none of
 * which the SDK has to know about.
 */

import {
  AmbaAuthError,
  AmbaInternalError,
  AmbaRateLimitError,
  deserializeAmbaError,
  isAmbaError,
} from './errors.js';
import type {
  AiContext,
  AnthropicContext,
  EmbeddingsCreateInput,
  EmbeddingsCreateResult,
  OpenAiContext,
} from './types.js';

export interface AiContextDeps {
  gatewayUrl: string;
  internalToken: string;
  projectId: string;
  requestId: string;
  /**
   * End-user id when the function ran in end-user-authed context. Forwarded
   * to the gateway as `x-amba-user-id` so per-(project, user, prompt) rate
   * limits and usage events attribute correctly.
   */
  authUserId: string | null;
  /**
   * Developer id when the function ran in developer-authed context.
   * Forwarded as `x-amba-developer-id`. Mutually exclusive with
   * `authUserId` in practice.
   */
  authDeveloperId: string | null;
}

export function createAiContext(deps: AiContextDeps): AiContext {
  return {
    anthropic: createAnthropicContext(deps),
    openai: createOpenAiContext(deps),
    embeddings: {
      async create(input: EmbeddingsCreateInput): Promise<EmbeddingsCreateResult> {
        const res = await aiFetch(deps, '/embeddings', input);
        return (await res.json()) as EmbeddingsCreateResult;
      },
    },
  };
}

function createAnthropicContext(deps: AiContextDeps): AnthropicContext {
  return {
    messages: {
      async create(params: unknown): Promise<unknown> {
        const res = await aiFetch(deps, '/anthropic/messages', params);
        return await res.json();
      },
      stream(params: unknown): AsyncIterable<unknown> {
        return streamFromGateway(deps, '/anthropic/messages', params);
      },
    },
  };
}

function createOpenAiContext(deps: AiContextDeps): OpenAiContext {
  return {
    chat: {
      completions: {
        async create(params: unknown): Promise<unknown> {
          const res = await aiFetch(deps, '/openai/chat/completions', params);
          return await res.json();
        },
      },
    },
  };
}

async function aiFetch(deps: AiContextDeps, path: string, body: unknown): Promise<Response> {
  const url = `${deps.gatewayUrl.replace(/\/+$/, '')}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildAiGatewayHeaders(deps),
    body: JSON.stringify(body),
  });
  if (res.ok) return res;

  const errBody = await res.json().catch(() => null);
  if (errBody && typeof errBody === 'object') {
    const typed = deserializeAmbaError(errBody, res.status);
    if (isAmbaError(typed)) throw typed;
  }
  if (res.status === 429) {
    throw new AmbaRateLimitError({
      message: 'AI gateway rate limit',
      request_id: deps.requestId,
      details: {
        retry_after_seconds: Number(res.headers.get('retry-after') ?? '1') || 1,
        scope: '(project,user,prompt)',
        window: '60s',
        max: 0,
      },
    });
  }
  if (res.status === 401) {
    throw new AmbaAuthError({
      code: 'invalid_token',
      message: 'AI gateway rejected the internal token',
      request_id: deps.requestId,
    });
  }
  throw new AmbaInternalError({
    code: 'upstream_failure',
    message: `AI gateway returned ${res.status}`,
    request_id: deps.requestId,
  });
}

function buildAiGatewayHeaders(
  deps: AiContextDeps,
  extras: Record<string, string> = {},
): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${deps.internalToken}`,
    'x-amba-project-id': deps.projectId,
    'x-amba-request-id': deps.requestId,
    'x-amba-user-id': deps.authUserId ?? '',
    'x-amba-developer-id': deps.authDeveloperId ?? '',
    ...extras,
  };
}

/**
 * SSE-style event stream parser. Yields one event per `data: …` line.
 */
async function* streamFromGateway(
  deps: AiContextDeps,
  path: string,
  body: unknown,
): AsyncIterable<unknown> {
  const url = `${deps.gatewayUrl.replace(/\/+$/, '')}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildAiGatewayHeaders(deps, { accept: 'text/event-stream' }),
    body: JSON.stringify({ ...(body as object), stream: true }),
  });
  if (!res.ok) {
    throw new AmbaInternalError({
      code: 'upstream_failure',
      message: `AI gateway stream returned ${res.status}`,
      request_id: deps.requestId,
    });
  }
  if (!res.body) {
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload);
        } catch {
          // Skip malformed lines.
        }
      }
    }
  }
}
