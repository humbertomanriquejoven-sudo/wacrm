import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';

/**
 * Find or open a conversation thread for a contact.
 *
 * One helper for every path that needs a thread: the inbound webhook, the
 * manual INBOX send, the broadcast mirror. There used to be three private,
 * subtly different copies of this function, which is why the broadcast path
 * could only LOOK a conversation up and gave up when it found none.
 *
 * Nothing here assumes a contact has a dialable phone number. Threads are
 * keyed by `contact_id`, so a contact known only by an `@user` handle, a BSUID
 * or a `WAID.`/`LID.` id gets a thread exactly like anyone else.
 */

export interface FoundConversation {
  conversation: { id: string } & Record<string, unknown>;
  /** True when this call opened the thread. */
  created: boolean;
}

/**
 * We deliberately do NOT use `.single()`. It errors on BOTH 0 rows and >=2
 * rows, and the old code treated any error as "none found" and inserted a new
 * row. So once two conversations existed for a contact (from a race - Meta
 * retries a delivery, or a batch fans out to concurrent runs), every
 * subsequent message errored on the lookup and created yet another
 * conversation, snowballing into a wall of duplicate chats (issue #363).
 *
 * Ordering oldest-first and taking one row makes the lookup resolve to the
 * same canonical survivor the dedup migration (036) keeps, so any pre-existing
 * duplicates converge instead of compounding.
 */
export async function findOrCreateConversation(
  db: Pick<SupabaseClient, 'from'>,
  args: {
    accountId: string;
    /**
     * Audit user stamped on a newly opened thread. Required, not nullable:
     * `conversations.user_id` is NOT NULL, so accepting `null` here would only
     * defer the failure to an insert error that the caller is expected to
     * swallow — losing a delivered message.
     */
    ownerUserId: string;
    contactId: string;
  },
): Promise<FoundConversation | null> {
  const { accountId, ownerUserId, contactId } = args;

  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findError) {
    console.error('[conversation] error finding thread:', findError.message);
    return null;
  }

  if (existingRows && existingRows.length > 0) {
    return {
      conversation: existingRows[0] as FoundConversation['conversation'],
      created: false,
    };
  }

  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
    })
    .select()
    .single();

  if (createError) {
    // Lost a race: a concurrent delivery opened the thread between our lookup
    // and our insert, and the unique index (migration 036) rejected the
    // duplicate. Re-resolve the winning row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return {
          conversation: raced[0] as FoundConversation['conversation'],
          created: false,
        };
      }
    }
    console.error('[conversation] error creating thread:', createError.message);
    return null;
  }

  return { conversation: newConv as FoundConversation['conversation'], created: true };
}
