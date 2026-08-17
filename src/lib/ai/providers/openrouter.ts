import { AiError, type ProviderResult, type ToolCall } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  toOpenAiContent,
  type ProviderArgs,
} from './shared'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

interface OpenRouterChoice {
  message?: {
    content?: string
    tool_calls?: {
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }[]
  }
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * Call OpenRouter's Chat Completions endpoint (OpenAI-compatible API).
 * Uses the caller's own OpenRouter key with the HTTP-Referer header
 * required by OpenRouter.
 */
export async function generateOpenRouter(
  args: ProviderArgs,
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools } = args

  const merged = mergeConsecutive(messages)
  const msgPayload = merged.map((m) => ({
    role: m.role,
    content: toOpenAiContent(m),
  }))

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...msgPayload],
    max_tokens: MAX_OUTPUT_TOKENS,
  }

  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))
  }

  let res: Response
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://wacrm.tech',
        'X-Title': 'WACRM AI Assistant',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenRouter', res)
  }

  const data = (await res.json().catch(() => null)) as OpenRouterResponse | null
  const choice = data?.choices?.[0]
  const text = choice?.message?.content ?? ''

  const toolCalls: ToolCall[] | undefined = choice?.message?.tool_calls?.map(
    (tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }),
  )

  if (!text.trim() && (!toolCalls || toolCalls.length === 0)) {
    throw new AiError('OpenRouter returned an empty response.', {
      code: 'empty_response',
    })
  }

  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text: text.trim(), usage, toolCalls }
}
