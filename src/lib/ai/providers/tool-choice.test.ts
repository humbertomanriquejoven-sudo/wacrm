import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateOpenAi } from './openai'
import { generateOpenRouter } from './openrouter'
import { generateAnthropic } from './anthropic'
import { EVALUATE_LEAD_TOOL } from '../deal-scoring'
import type { ProviderArgs } from './shared'

// The lead-scoring pass forces `evaluate_lead` so the model emits a
// structured tool call (never prose that could leak toward WhatsApp).
// These tests lock the per-provider translation of `toolChoice`.

const BASE: ProviderArgs = {
  apiKey: 'sk-test',
  model: 'test-model',
  systemPrompt: 'system',
  messages: [{ role: 'user', content: 'hola' }],
  timeoutMs: 5_000,
  tools: [EVALUATE_LEAD_TOOL],
}

const FORCED = {
  type: 'function',
  function: { name: 'evaluate_lead' },
} as const

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const fetchMock = vi.fn()

function bodyOf(callIndex = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit
  return JSON.parse(init.body as string) as Record<string, unknown>
}

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

describe('OpenAI tool_choice', () => {
  it('defaults to auto when tools are present', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    )
    await generateOpenAi(BASE)
    expect(bodyOf().tool_choice).toBe('auto')
  })

  it('forwards a forced named function verbatim', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    )
    await generateOpenAi({ ...BASE, toolChoice: FORCED })
    expect(bodyOf().tool_choice).toEqual(FORCED)
  })
})

describe('OpenRouter tool_choice', () => {
  it('forwards a forced named function verbatim', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    )
    await generateOpenRouter({ ...BASE, toolChoice: FORCED })
    expect(bodyOf().tool_choice).toEqual(FORCED)
  })
})

describe('Anthropic tool_choice', () => {
  it('translates a forced named function to {type:tool,name}', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] }),
    )
    await generateAnthropic({ ...BASE, toolChoice: FORCED })
    expect(bodyOf().tool_choice).toEqual({ type: 'tool', name: 'evaluate_lead' })
  })

  it("translates 'required' to {type:any} and defaults to {type:auto}", async () => {
    vi.stubGlobal('fetch', fetchMock)
    // A Response body is single-use, so mint a fresh one per call.
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] })),
    )
    await generateAnthropic({ ...BASE, toolChoice: 'required' })
    expect(bodyOf(0).tool_choice).toEqual({ type: 'any' })

    await generateAnthropic(BASE)
    expect(bodyOf(1).tool_choice).toEqual({ type: 'auto' })
  })
})
