import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// RESUME NOTE — when the AI resumes a thread a human had taken over,
// leave a short internal note summarizing the human intervention so the
// bot (and the next agent) inherit the context.
//
// Deterministic: composed from the messages the human actually sent, no
// extra LLM call, so it cannot fail or add latency to the takeover
// hand-back.
// ============================================================

/** Longest a quoted human message runs before it is ellipsized. */
const MAX_QUOTE_LEN = 160;
/** How many of the most recent human messages to summarize. */
const MAX_QUOTED_MESSAGES = 5;

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max
    ? collapsed
    : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Build the internal note summarizing what the human said while the AI
 * was paused. `humanMessages` is the list of messages an agent sent
 * (oldest first). Reads as, e.g.:
 *
 *   "🤖 IA reanudada. Intervención humana (2 mensajes): “hola, te
 *    atiendo yo”; “te comparto el PDF”."
 *
 * Returns a short generic note when there were no human messages.
 */
export function buildResumeNote(humanMessages: string[]): string {
  const cleaned = humanMessages
    .map((m) => (typeof m === 'string' ? m.trim() : ''))
    .filter((m) => m.length > 0);

  if (cleaned.length === 0) {
    return '🤖 IA reanudada: no se registraron mensajes humanos durante la intervención.';
  }

  const quoted = cleaned
    .slice(-MAX_QUOTED_MESSAGES)
    .map((m) => `“${truncate(m, MAX_QUOTE_LEN)}”`)
    .join('; ');

  const label =
    cleaned.length === 1 ? '1 mensaje' : `${cleaned.length} mensajes`;
  return `🤖 IA reanudada. Intervención humana (${label}): ${quoted}.`;
}

export interface RecordResumeNoteArgs {
  accountId: string;
  /** Owner id written to `contact_notes.user_id` (NOT NULL). */
  userId: string;
  contactId: string;
  conversationId: string;
}

/**
 * Read the human agent messages of the conversation and persist the
 * resume note. Best-effort: returns false (and logs) instead of throwing
 * so it can never turn a "Resume AI" click into an error response.
 */
export async function recordResumeNote(
  db: SupabaseClient,
  args: RecordResumeNoteArgs
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('messages')
      .select('content_text')
      .eq('conversation_id', args.conversationId)
      .eq('sender_type', 'agent')
      .not('content_text', 'is', null)
      .order('created_at', { ascending: true })
      .limit(50);

    if (error) {
      console.error(
        '[ai resume-note] could not read human messages:',
        error.message
      );
      return false;
    }

    const humanMessages = (data ?? [])
      .map((m) => (typeof m.content_text === 'string' ? m.content_text : ''))
      .filter((m) => m.trim().length > 0);

    const noteText = buildResumeNote(humanMessages);

    const { error: insertErr } = await db.from('contact_notes').insert({
      contact_id: args.contactId,
      user_id: args.userId,
      account_id: args.accountId,
      note_text: noteText,
    });
    if (insertErr) {
      console.error(
        '[ai resume-note] could not record resume note:',
        insertErr.message
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      '[ai resume-note] failed:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}
