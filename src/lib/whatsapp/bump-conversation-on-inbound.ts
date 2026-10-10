import type { SupabaseClient } from '@supabase/supabase-js'

export type BumpSignature = '3-arg' | '2-arg'

export interface BumpOutcome {
  error: { code?: string; message: string } | null
  signature: BumpSignature
}

interface PostgrestErrorLike {
  code?: string
  message: string
}

/** True when the RPC failed because the function itself is missing. */
export function isMissingFunctionError(
  error: PostgrestErrorLike | null | undefined,
): boolean {
  if (!error) return false
  return (
    error.code === '42883' ||
    error.code === 'PGRST202' ||
    /does not exist/i.test(error.message) ||
    /could not find the function/i.test(error.message)
  )
}

/**
 * The atomic inbound bump (migration 037 / 072). The canonical call is the
 * 3-arg signature (p_conversation_id, p_last_message_text, p_last_inbound_wamid).
 * If the deployed database predates migration 072 it only has the 2-arg
 * function (which throws 42883 / PGRST202 for a 3-arg call); this wrapper
 * retries with the legacy 2-arg signature so webhook delivery never dies on an
 * unapplied migration, and downgrades the stamping to what the DB supports.
 */
export async function bumpConversationOnInbound(
  client: SupabaseClient,
  args: {
    conversationId: string
    lastMessageText: string
    lastInboundWamid: string | null
  },
): Promise<BumpOutcome> {
  const { error } = await client.rpc('bump_conversation_on_inbound', {
    p_conversation_id: args.conversationId,
    p_last_message_text: args.lastMessageText,
    p_last_inbound_wamid: args.lastInboundWamid,
  })

  if (!error) return { error: null, signature: '3-arg' }
  if (!isMissingFunctionError(error)) {
    return { error, signature: '3-arg' }
  }

  console.warn(
    `[bump] 3-arg bump_conversation_on_inbound unavailable (${error.code ?? error.message}) — ` +
      `migration 072 not applied to this database. Retrying with the legacy 2-arg ` +
      `signature (last_inbound_wamid / last_inbound_at will not be stamped). conversation=${args.conversationId}`,
  )

  const retry = await client.rpc('bump_conversation_on_inbound', {
    p_conversation_id: args.conversationId,
    p_last_message_text: args.lastMessageText,
  })

  if (retry.error) {
    console.error('[bump] 2-arg fallback also failed:', retry.error)
    return { error: retry.error, signature: '2-arg' }
  }

  console.warn(
    `[bump] unread bumped via 2-arg fallback. Apply the latest migrations so ` +
      `last_inbound_wamid / last_inbound_at stamp the CASO B anchor. conversation=${args.conversationId}`,
  )
  return { error: null, signature: '2-arg' }
}