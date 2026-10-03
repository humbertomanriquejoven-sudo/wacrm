import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Clear the parked reply once it has been delivered (or discarded).
 *
 * Called after a successful flush, and by the discard endpoint. Leaving the
 * flag set would keep showing a banner for a conversation whose answer has
 * already arrived.
 */
export async function clearParkedReply(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<void> {
  const { error } = await db
    .from('conversations')
    .update({
      awaiting_valid_phone: false,
      pending_reply_text: null,
      pending_reply_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .eq('account_id', accountId)

  if (error) {
    console.error(
      `[pending-reply] conversation ${conversationId}: could not clear the parked reply:`,
      error.message,
    )
  }
}

/** A conversation with a reply waiting for a usable address. */
export interface PendingConversation {
  id: string
  contact_id: string
  pending_reply_text: string
  pending_reply_at: string | null
}

/**
 * Every conversation for a contact still holding a parked reply.
 *
 * Scoped by account so a phone edit can never flush another tenant's
 * queued message.
 */
export async function listPendingReplies(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<PendingConversation[]> {
  const { data } = await db
    .from('conversations')
    .select('id, contact_id, pending_reply_text, pending_reply_at')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .not('pending_reply_text', 'is', null)

  return ((data ?? []) as PendingConversation[]).filter(
    (c) => Boolean(c.pending_reply_text && c.pending_reply_text.trim()),
  )
}

/**
 * Any address a contact can be reached at. A parked reply is only worth
 * flushing when at least one of these is present.
 */
export interface FlushRecipient {
  phone?: string | null
  wa_user_id?: string | null
  username?: string | null
}

/**
 * True when the contact has an address Meta can be asked to deliver to.
 *
 * Any stored address counts: a dialable E.164 number, a BSUID or a public
 * @handle. Meta's `to` field accepts all three, so a parked reply is worth
 * flushing as soon as ANY of them is on file.
 */
export function hasSendableRecipient(recipient: FlushRecipient): boolean {
  return Boolean(
    (recipient.phone && recipient.phone.trim()) ||
      (recipient.wa_user_id && recipient.wa_user_id.trim()) ||
      (recipient.username && recipient.username.trim()),
  )
}

/**
 * Send every parked reply for a contact, now that it has a usable address.
 *
 * Refuses to run only when the contact has no address at all — this is the
 * last gate before the flush, so a genuinely empty save can never re-trigger
 * the same rejection loop it was meant to fix.
 *
 * One conversation's failure doesn't stop the others: each reply is
 * attempted and the successes are collected, because a contact may hold
 * several threads and losing all of them over one bad row would be worse
 * than delivering what we can.
 */
export async function flushPendingReplies(args: {
  db: SupabaseClient
  accountId: string
  contactId: string
  recipient: FlushRecipient
  send: (conversationId: string, text: string) => Promise<void>
}): Promise<{ sent: number; failed: number; conversations: string[] }> {
  const { db, accountId, contactId, recipient, send } = args

  if (!hasSendableRecipient(recipient)) {
    return { sent: 0, failed: 0, conversations: [] }
  }

  const pending = await listPendingReplies(db, accountId, contactId)
  if (pending.length === 0) return { sent: 0, failed: 0, conversations: [] }

  let sent = 0
  let failed = 0
  const delivered: string[] = []

  for (const conversation of pending) {
    try {
      await send(conversation.id, conversation.pending_reply_text)
      await clearParkedReply(db, accountId, conversation.id)
      sent += 1
      delivered.push(conversation.id)
    } catch (err) {
      failed += 1
      console.error(
        `[pending-reply] conversation ${conversation.id}: deferred send failed for contact ${contactId}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  console.log(
    `[pending-reply] contact ${contactId}: flushed ${sent}/${pending.length} parked repl${pending.length === 1 ? 'y' : 'ies'}` +
      (failed > 0 ? ` (${failed} still failing)` : ''),
  )

  return { sent, failed, conversations: delivered }
}