import { AiError, type ChatMessage, type ProviderResult, type ToolCall } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  toAnthropicContent,
  type ProviderArgs,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicContent {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContent[]
}

interface AnthropicResponse {
  content?: AnthropicContent[]
  usage?: { input_tokens?: number; output_tokens?: number }
  stop_reason?: string
}

function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

/**
 * Build the Anthropic `messages` payload. Tool calls come back as
 * `tool_use` content blocks on the assistant message; tool results are
 * `tool_result` blocks on a `user` message (Anthropic's protocol has no
 * `role: 'tool'`). Consecutive tool results are packed into a single
 * user message with multiple blocks, so the old text-annotated approach
 * also stays compatible.
 */
function buildAnthropicPayload(
  merged: ChatMessage[],
): Array<{ role: ChatMessage['role']; content: AnthropicContent[] | string }> {
  const out: Array<{
    role: ChatMessage['role']
    content: AnthropicContent[] | string
  }> = []

  for (const m of merged) {
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId ?? '',
            content: m.content,
          },
        ],
      })
      continue
    }

    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: AnthropicContent[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        })
      }
      out.push({ role: 'assistant', content: blocks })
      continue
    }

    out.push({ role: m.role, content: toAnthropicContent(m) })
  }

  // Anthropic requires strictly alternating roles, and every tool_result
  // user message must directly follow the assistant tool_use block.
  // Merge consecutive tool-result user messages into one, and if a lone
  // tool user message ever precedes a user message (no assistant between
  // them), leave it as-is — Anthropic handles adjacent tool results.
  const collapsed: typeof out = []
  for (const msg of out) {
    const last = collapsed[collapsed.length - 1]
    if (
      last &&
      last.role === 'user' &&
      msg.role === 'user' &&
      Array.isArray(last.content) &&
      last.content[0]?.type === 'tool_result'
    ) {
      last.content = [...(last.content as AnthropicContent[]), ...(msg.content as AnthropicContent[])]
      continue
    }
    collapsed.push({ ...msg })
  }
  return collapsed
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateAnthropic(
  args: ProviderArgs,
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools } = args

  const normalized = normalizeForAnthropic(messages)
  const msgPayload = buildAnthropicPayload(normalized)

  const body: Record<string, unknown> = {
    model,
    system: systemPrompt,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: msgPayload,
  }

  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
  }

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null

  const textBlocks = data?.content
    ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()

  const toolCalls: ToolCall[] | undefined = data?.content
    ?.filter((b) => b.type === 'tool_use' && b.id && b.name)
    .map((b) => ({
      id: b.id!,
      name: b.name!,
      arguments: (b.input as Record<string, unknown>) ?? {},
    }))

  if (!textBlocks && (!toolCalls || toolCalls.length === 0)) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }

  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
  })
  return { text: textBlocks || '', usage, toolCalls }
}
