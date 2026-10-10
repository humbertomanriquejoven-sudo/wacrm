import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  bumpConversationOnInbound,
  isMissingFunctionError,
} from './bump-conversation-on-inbound'

/** A client whose `.rpc` returns a scripted sequence of results. */
function rpcClient(
  results: Array<{ data?: unknown; error: { code?: string; message: string } | null }>,
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let i = 0
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args })
      const result = results[Math.min(i, results.length - 1)]
      i += 1
      return Promise.resolve(result)
    },
  } as unknown as SupabaseClient
  return { client, calls }
}

describe('isMissingFunctionError', () => {
  it('recognizes the Postgres undefined_function code', () => {
    expect(isMissingFunctionError({ code: '42883', message: 'nope' })).toBe(true)
  })

  it('recognizes the PostgREST could-not-find-function code', () => {
    expect(isMissingFunctionError({ code: 'PGRST202', message: 'nope' })).toBe(true)
  })

  it('recognizes the textual signatures', () => {
    expect(
      isMissingFunctionError({
        message: 'function bump_conversation_on_inbound does not exist',
      }),
    ).toBe(true)
    expect(
      isMissingFunctionError({ message: 'Could not find the function public.bump' }),
    ).toBe(true)
  })

  it('does not treat an unrelated failure as a missing function', () => {
    expect(isMissingFunctionError({ code: '23505', message: 'duplicate key' })).toBe(false)
    expect(isMissingFunctionError(null)).toBe(false)
  })
})

describe('bumpConversationOnInbound', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the canonical 3-arg signature when it succeeds', async () => {
    const { client, calls } = rpcClient([{ data: null, error: null }])
    const out = await bumpConversationOnInbound(client, {
      conversationId: 'conv-1',
      lastMessageText: 'hi',
      lastInboundWamid: 'wamid.IN',
    })
    expect(out.error).toBeNull()
    expect(out.signature).toBe('3-arg')
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual({
      p_conversation_id: 'conv-1',
      p_last_message_text: 'hi',
      p_last_inbound_wamid: 'wamid.IN',
    })
  })

  it('falls back to the legacy 2-arg signature when 3-arg is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, calls } = rpcClient([
      {
        data: null,
        error: {
          code: '42883',
          message: 'function bump_conversation_on_inbound does not exist',
        },
      },
      { data: null, error: null },
    ])

    const out = await bumpConversationOnInbound(client, {
      conversationId: 'conv-1',
      lastMessageText: 'hi',
      lastInboundWamid: 'wamid.IN',
    })

    expect(out.error).toBeNull()
    expect(out.signature).toBe('2-arg')
    expect(calls).toHaveLength(2)
    expect(calls[0].args).toHaveProperty('p_last_inbound_wamid', 'wamid.IN')
    expect(calls[1].args).toEqual({
      p_conversation_id: 'conv-1',
      p_last_message_text: 'hi',
    })
    expect(calls[1].args).not.toHaveProperty('p_last_inbound_wamid')
    expect(warn).toHaveBeenCalled()
  })

  it('returns the original error when it is not a missing-function error', async () => {
    const { client, calls } = rpcClient([
      { data: null, error: { code: '500', message: 'connection reset' } },
    ])
    const out = await bumpConversationOnInbound(client, {
      conversationId: 'conv-1',
      lastMessageText: 'hi',
      lastInboundWamid: null,
    })
    expect(out.error?.code).toBe('500')
    expect(out.signature).toBe('3-arg')
    // No fallback attempt for a non-signature failure.
    expect(calls).toHaveLength(1)
  })

  it('surfaces the fallback error when the 2-arg call also fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = rpcClient([
      { data: null, error: { code: '42883', message: 'does not exist' } },
      { data: null, error: { code: '500', message: 'still broken' } },
    ])
    const out = await bumpConversationOnInbound(client, {
      conversationId: 'conv-1',
      lastMessageText: 'hi',
      lastInboundWamid: null,
    })
    expect(out.error?.message).toBe('still broken')
    expect(out.signature).toBe('2-arg')
    expect(warn).toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
  })
})