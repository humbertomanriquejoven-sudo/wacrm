import type { SupabaseClient } from '@supabase/supabase-js';
import { toStringList } from './deal-scoring';

// ============================================================
// CRM side-effects of the commercial agent: funnel tags + contact
// notes.
//
// Both are best-effort and never throw: they run AFTER the customer
// reply is already on the wire (see deal-analysis), so a failed tag or
// note write can never cost the customer an answer. Every helper is
// deterministic and side-effect free where possible so it is cheap to
// unit-test.
// ============================================================

/** Default color for tags the agent has to create on the fly. */
export const DEFAULT_TAG_COLOR = '#3b82f6';

/**
 * The HMA Arquitectura funnel tags the commercial agent keeps up to
 * date. They are offered to the model as the allowed vocabulary so it
 * picks exact, repeatable names instead of inventing variations that
 * would fragment the tag list. Missing tags are created on first use.
 */
export const LEAD_TAG_SUGGESTIONS = [
  'En conversacion',
  'Reunion de Diseño',
  'Reunion de Remodelacion',
  'Esperando respuesta de cotizacion de coc',
  'Se genero Cotizacion, esperando',
  'Confirmar reunion DOMINGO para el lunes',
  'Llamar Mañana',
  'No contesto',
  'Llamar no contesta, activo ventana de 24',
] as const;

/**
 * Normalize the model's tag output into a clean, de-duplicated
 * (case-insensitive) list. Accepts either an array or a delimited
 * string, mirroring the other evaluation fields.
 */
export function normalizeTagNames(value: unknown): string[] {
  const names = toStringList(value)
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export interface ApplyLeadTagsArgs {
  accountId: string;
  /** Owner used for `tags.user_id` (NOT NULL) when a tag must be created. */
  userId: string;
  contactId: string;
  /** Tag names from the model's evaluation (matched case-insensitively). */
  tagNames: string[];
}

/**
 * Apply the model's tags to the contact, creating any missing tag
 * definition in the account first. Existing tags are matched
 * case-insensitively so "en conversacion" reuses "En conversacion".
 *
 * Only ever ADDS: the funnel rules say a tag is applied/updated, never
 * that the agent may remove history another operator set. Returns the
 * names that were applied (or already present).
 */
export async function applyLeadTags(
  db: SupabaseClient,
  args: ApplyLeadTagsArgs
): Promise<string[]> {
  const names = normalizeTagNames(args.tagNames);
  if (names.length === 0) return [];

  const byKey = await loadTagIdsByKey(db, args.accountId);
  if (!byKey) return [];

  const toCreate = names.filter((n) => !byKey.has(n.toLowerCase()));
  if (toCreate.length > 0) {
    const { data: created, error } = await db
      .from('tags')
      .insert(
        toCreate.map((name) => ({
          user_id: args.userId,
          account_id: args.accountId,
          name,
          color: DEFAULT_TAG_COLOR,
        }))
      )
      .select('id, name');
    if (error) {
      console.error('[ai lead-crm] could not create lead tags:', error.message);
    }
    for (const tag of created ?? []) {
      byKey.set(String(tag.name).trim().toLowerCase(), String(tag.id));
    }
  }

  const applied: string[] = [];
  const rows: { contact_id: string; tag_id: string }[] = [];
  const seenIds = new Set<string>();
  for (const name of names) {
    const tagId = byKey.get(name.toLowerCase());
    if (!tagId || seenIds.has(tagId)) continue;
    seenIds.add(tagId);
    rows.push({ contact_id: args.contactId, tag_id: tagId });
    applied.push(name);
  }
  if (rows.length === 0) return [];

  const { error } = await db
    .from('contact_tags')
    .upsert(rows, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });
  if (error) {
    console.error('[ai lead-crm] could not apply lead tags:', error.message);
    return [];
  }
  return applied;
}

/** Account tags as `lowercase name → id`, or null when the read failed. */
async function loadTagIdsByKey(
  db: SupabaseClient,
  accountId: string
): Promise<Map<string, string> | null> {
  const { data, error } = await db
    .from('tags')
    .select('id, name')
    .eq('account_id', accountId);
  if (error) {
    console.error('[ai lead-crm] could not load account tags:', error.message);
    return null;
  }
  const byKey = new Map<string, string>();
  for (const tag of data ?? []) {
    const key = String(tag.name).trim().toLowerCase();
    if (!key || byKey.has(key)) continue;
    byKey.set(key, String(tag.id));
  }
  return byKey;
}

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
