import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// CRM side-effect of the commercial agent: contact notes.
//
// Best-effort and never throws: it runs AFTER the customer reply is
// already on the wire (see deal-analysis), so a failed note write can
// never cost the customer an answer. The helper is deterministic and
// side-effect free where possible so it is cheap to unit-test.
// ============================================================

export interface RecordContactNoteArgs {
  accountId: string;
  userId: string;
  contactId: string;
  /** Already-formatted note text. Blank input is a no-op. */
  noteText: string;
}

/**
 * Append a note to the contact's profile. Consecutive identical notes
 * are collapsed (same text as the newest note) so a multi-turn
 * conversation that keeps repeating the same fact does not spam the
 * profile. Returns true when a row was inserted.
 */
export async function recordContactNote(
  db: SupabaseClient,
  args: RecordContactNoteArgs
): Promise<boolean> {
  const text = args.noteText.trim();
  if (!text) return false;

  const { data: latest } = await db
    .from('contact_notes')
    .select('note_text')
    .eq('contact_id', args.contactId)
    .eq('account_id', args.accountId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (
    latest &&
    typeof latest.note_text === 'string' &&
    latest.note_text.trim() === text
  ) {
    return false;
  }

  const { error } = await db.from('contact_notes').insert({
    contact_id: args.contactId,
    user_id: args.userId,
    account_id: args.accountId,
    note_text: text,
  });
  if (error) {
    console.error(
      '[ai lead-crm] could not record contact note:',
      error.message
    );
    return false;
  }
  return true;
}

/** Prefix used for notes written by the commercial agent. */
export const AI_NOTE_PREFIX = '🤖 Nota IA:';

/** Format the model's free-text note into the stored internal note. */
export function formatLeadNote(note: string): string {
  const text = note.trim();
  return text ? `${AI_NOTE_PREFIX} ${text}` : '';
}
