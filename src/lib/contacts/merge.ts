import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isDialablePhone,
  normalizeMetaIdentifier,
  normalizeUsername,
  toDialable,
} from '@/lib/whatsapp/recipient-resolver'

/**
 * Merge of two rows that carry the SAME Meta identifier.
 *
 * A person is only ever folded together when both rows share an identical
 * BSUID — an opaque, per-WABA id Meta issues for a single user. Phone
 * numbers and BSUIDs are the only keys allowed to justify a merge; display
 * names and @usernames are NOT, because they are neither unique nor
 * authenticated. Two different numbers, or two different BSUIDs, must stay
 * as two independent contacts and conversations even if the visible profile
 * name is the same.
 *
 * This is the one legitimate merge shape: a contact already holding a real
 * `phone` plus a BSUID, and a stale orphan row that still has the same BSUID
 * sitting in its `phone` column (legacy rows created before `wa_user_id`
 * existed). `findMergeableOrphan` only returns rows that share the BSUID.
 *
 * The fold:
 *   1. every conversation moves across, and so do its messages;
 *   2. identity fields the survivor lacks are absorbed from the orphan;
 *   3. the orphan row is deleted.
 *
 * Destructive by design, and scoped by `account_id`, so a merge can never
 * cross tenants.
 */

/**
 * Tables whose `contact_id` points at the orphan and would be cascaded or
 * nulled when it is deleted. Membership here is not optional: forgetting
 * one means the merge destroys that side's history. Kept as data so the
 * list can be read at a glance against the schema.
 */
const PLAIN_CHILD_TABLES = [
  'contact_notes',
  'deals',
  'broadcast_recipients',
  'automation_logs',
  'automation_pending_executions',
  // ON DELETE CASCADE — without this re-point, appointments vanish.
  'citas',
  // ON DELETE SET NULL — re-pointed to preserve the link.
  'notifications',
] as const

/** Children guarded by UNIQUE(contact_id, <second column>). */
const GUARDED_CHILD_TABLES = [
  { table: 'contact_tags', key: 'tag_id' },
  { table: 'contact_custom_values', key: 'custom_field_id' },
] as const

/**
 * Postgres error code for "relation does not exist". Some of these tables
 * were added by later migrations, and a deployment that hasn't run them
 * must not fail the whole merge; the missing table has no rows to lose.
 */
const UNDEFINED_TABLE = '42P01'

/**
 * Move every dependent row off the orphan and onto the survivor.
 *
 * Returns null on success, or an error string. Deliberately runs BEFORE
 * the orphan is deleted, and aborts the merge on any failure, so a
 * partially-moved contact is never left behind.
 */
async function repointContactChildren(
  db: SupabaseClient,
  accountId: string,
  survivorId: string,
  orphanId: string,
): Promise<string | null> {
  for (const table of PLAIN_CHILD_TABLES) {
    const { error } = await db
      .from(table)
      .update({ contact_id: survivorId })
      .eq('contact_id', orphanId)
    if (error && error.code !== UNDEFINED_TABLE) {
      return `${table}: ${error.message}`
    }
  }

  // `flow_runs` has a partial unique index on active runs per contact, so
  // only completed runs are re-pointed. An active orphan run is left for
  // its FK's ON DELETE SET NULL — losing the link is better than colliding
  // with the survivor's own active run.
  {
    const { error } = await db
      .from('flow_runs')
      .update({ contact_id: survivorId })
      .eq('contact_id', orphanId)
      .neq('status', 'active')
    if (error && error.code !== UNDEFINED_TABLE) {
      return `flow_runs: ${error.message}`
    }
  }

  // Conflict-guarded children: a unique (contact_id, key) means the
  // survivor may already hold the same tag / custom value. The survivor's
  // own row wins; the orphan's duplicate is dropped, and only the
  // non-conflicting rows are moved.
  for (const { table, key } of GUARDED_CHILD_TABLES) {
    const { data: orphanRows, error: orphanErr } = await db
      .from(table)
      .select(`id, ${key}`)
      .eq('contact_id', orphanId)
    if (orphanErr) {
      if (orphanErr.code === UNDEFINED_TABLE) continue
      return `${table}: ${orphanErr.message}`
    }
    const rows = (orphanRows ?? []) as Array<Record<string, string>>
    if (rows.length === 0) continue

    const { data: survivorRows, error: survivorErr } = await db
      .from(table)
      .select(key)
      .eq('contact_id', survivorId)
    if (survivorErr && survivorErr.code !== UNDEFINED_TABLE) {
      return `${table}: ${survivorErr.message}`
    }
    const taken = new Set(
      ((survivorRows ?? []) as Array<Record<string, string>>).map((r) => r[key]),
    )

    const movable = rows.filter((r) => !taken.has(r[key])).map((r) => r.id)
    const duplicate = rows.filter((r) => taken.has(r[key])).map((r) => r.id)

    if (movable.length > 0) {
      const { error } = await db
        .from(table)
        .update({ contact_id: survivorId })
        .in('id', movable)
      if (error) return `${table}: ${error.message}`
    }
    if (duplicate.length > 0) {
      const { error } = await db.from(table).delete().in('id', duplicate)
      if (error) return `${table}: ${error.message}`
    }
  }

  return null
}

/** Columns read before deciding whether two rows are the same person. */
export interface MergeCandidate {
  id: string
  /**
   * Tenancy scope. Optional on the read path — the caller already scopes
   * its queries by account, and the webhook only holds the id plus the
   * identity fields when it calls in. Always verified before a merge.
   */
  account_id?: string
  phone?: string | null
  name?: string | null
  username?: string | null
  wa_user_id?: string | null
}

export interface MergeOutcome {
  merged: boolean
  /** Why no merge happened — always logged, so silence is never ambiguous. */
  reason?: string
  /** Conversations moved to the survivor. */
  conversationsMoved: number
  /** Messages moved to the survivor (they follow their conversation). */
  messagesMoved: number
  /** Identity fields written onto the survivor. */
  fieldsAbsorbed: string[]
}

const EMPTY: Omit<MergeOutcome, 'merged' | 'reason'> = {
  conversationsMoved: 0,
  messagesMoved: 0,
  fieldsAbsorbed: [],
}

/** The only key allowed to justify a merge. */
export type MergeKey = 'wa_user_id'

/**
 * Decide whether `orphan` and `survivor` are the same person.
 *
 * The ONLY evidence accepted is an identical BSUID (`wa_user_id`, or a
 * BSUID still parked in `phone` on a legacy row). Phone numbers and BSUIDs
 * are opaque identifiers Meta assigns to one person; display names and
 * @usernames are not — they are free text that two strangers can share, so
 * they never authorise a merge that would delete a row and rewrite history.
 *
 * Returns the key that justified the decision, for logging.
 */
export function mergeJustification(
  orphan: MergeCandidate,
  survivor: MergeCandidate,
): MergeKey | null {
  const orphanBsuid = normalizeMetaIdentifier(orphan.wa_user_id ?? orphan.phone)
  const survivorBsuid = normalizeMetaIdentifier(survivor.wa_user_id ?? survivor.phone)
  if (orphanBsuid && survivorBsuid && orphanBsuid === survivorBsuid) return 'wa_user_id'
  return null
}

/**
 * Find a legacy orphan contact that must be folded into `survivor`.
 *
 * A merge is only ever justified by a shared BSUID, so this searches for a
 * row that carries the survivor's BSUID — either in `wa_user_id` or, for
 * rows created before that column existed, still parked in `phone`. It
 * deliberately does NOT look at @username or the display name: those are
 * not identities, and matching on them would silently fold two different
 * phone numbers into one contact.
 *
 * Returns null when there is nothing safe to merge, which is the normal
 * case. A survivor without a real phone or without a BSUID can never
 * produce a candidate.
 */
export async function findMergeableOrphan(
  db: SupabaseClient,
  accountId: string,
  survivor: MergeCandidate,
): Promise<MergeCandidate | null> {
  // Only a survivor with a REAL phone is a candidate: the merge exists to
  // give a phone-less orphan row its number back.
  if (!toDialable(survivor.phone)) return null

  const bsuid = normalizeMetaIdentifier(survivor.wa_user_id ?? survivor.phone)
  if (!bsuid) return null

  const select = 'id, account_id, phone, name, username, wa_user_id'

  const { data } = await db
    .from('contacts')
    .select(select)
    .eq('account_id', accountId)
    .neq('id', survivor.id)
    .or(`wa_user_id.eq.${bsuid},phone.eq.${bsuid}`)
    .limit(10)

  const candidates = (data ?? []) as MergeCandidate[]
  for (const candidate of candidates) {
    // Must itself be an orphan — a row that already has a real number is a
    // genuinely different contact, not something to fold away.
    if (isDialablePhone(candidate.phone)) continue
    if (!mergeJustification(candidate, survivor)) continue
    return candidate
  }
  return null
}

/**
 * Fold `orphanId` into `survivorId`, preserving the conversation history.
 *
 * Ordering matters and is the delicate part:
 *   1. move conversations (messages follow their conversation, so they come
 *      along automatically — but we count them first for the log);
 *   2. absorb identity fields onto the survivor;
 *   3. delete the orphan.
 *
 * The survivor's row is updated BEFORE the orphan is deleted, so a failure
 * anywhere leaves the orphan intact and nothing is lost — the merge is
 * simply retried on the next inbound.
 */
export async function mergeContactInto(
  db: SupabaseClient,
  args: {
    accountId: string
    survivorId: string
    orphanId: string
  },
): Promise<MergeOutcome> {
  const { accountId, survivorId, orphanId } = args

  const { data: rows, error: readErr } = await db
    .from('contacts')
    .select('id, account_id, phone, name, username, wa_user_id')
    .eq('account_id', accountId)
    .in('id', [survivorId, orphanId])

  if (readErr) {
    return { ...EMPTY, merged: false, reason: `read failed: ${readErr.message}` }
  }

  const survivor = ((rows ?? []) as MergeCandidate[]).find((c) => c.id === survivorId)
  const orphan = ((rows ?? []) as MergeCandidate[]).find((c) => c.id === orphanId)

  if (!survivor || !orphan) {
    return { ...EMPTY, merged: false, reason: 'one of the contacts no longer exists' }
  }

  // Defence in depth: the read above was already scoped by account, but a
  // merge deletes a row and rewrites history, so the tenancy check is
  // repeated explicitly rather than trusted to the query builder.
  if (survivor.account_id !== accountId || orphan.account_id !== accountId) {
    return { ...EMPTY, merged: false, reason: 'cross-tenant merge refused' }
  }

  // Re-check the evidence here, independently of how the orphan was
  // discovered. `findMergeableOrphan` already proved it, but this function
  // is also callable directly (the phone-edit route does), and a caller
  // that hands over two rows it merely *thinks* are the same person must
  // not be able to trigger a destructive merge. Only an identical BSUID is
  // accepted — never a name or @username.
  const outcome: MergeOutcome = { merged: false, ...EMPTY }

  const justification = mergeJustification(orphan, survivor)
  if (!justification) {
    return { ...outcome, merged: false, reason: 'no shared identity (refusing to merge)' }
  }

  // --- 1. Conversations -------------------------------------------------
  const { data: orphanConversations } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', orphanId)

  const conversationIds = ((orphanConversations ?? []) as Array<{ id: string }>).map(
    (c) => c.id,
  )

  for (const conversationId of conversationIds) {
    // `messages.conversation_id` is NOT NULL with ON DELETE CASCADE, so a
    // message can never be orphaned — moving the conversation carries its
    // messages with it. Count them for the operator-facing log.
    const { count } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
    outcome.messagesMoved += count ?? 0

    // A conversation-per-contact unique index exists (migration 036), so
    // the survivor may already have one. Reassigning would violate it.
    const { data: survivorConversation } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', survivorId)
      .maybeSingle()

    if (survivorConversation) {
      // Both rows already have a thread: fold this one's messages into the
      // survivor's thread, then drop the empty conversation. Deleting it
      // cascades nothing because its messages were moved first.
      const { error: moveErr } = await db
        .from('messages')
        .update({ conversation_id: survivorConversation.id })
        .eq('conversation_id', conversationId)
      if (moveErr) {
        return {
          ...outcome,
          merged: false,
          reason: `failed to move messages from conversation ${conversationId}: ${moveErr.message}`,
        }
      }
      const { error: dropErr } = await db
        .from('conversations')
        .delete()
        .eq('id', conversationId)
        .eq('account_id', accountId)
      if (dropErr) {
        return {
          ...outcome,
          merged: false,
          reason: `failed to drop duplicate conversation ${conversationId}: ${dropErr.message}`,
        }
      }
      continue
    }

    const { error: reassignErr } = await db
      .from('conversations')
      .update({ contact_id: survivorId, updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .eq('account_id', accountId)

    if (reassignErr) {
      return {
        ...outcome,
        merged: false,
        reason: `failed to move conversation ${conversationId}: ${reassignErr.message}`,
      }
    }
    outcome.conversationsMoved += 1
  }

  // --- 2. Re-point the orphan's dependent rows -------------------------
  // Deleting the contact cascades or nulls a whole set of children
  // (contact_notes, contact_tags, contact_custom_values, deals,
  // broadcast_recipients, flow_runs, automation logs, citas). They must be
  // moved FIRST, or folding two contacts would silently destroy one side's
  // history. This mirrors the SQL in migration 022's
  // `merge_duplicate_contacts`, which exists for exactly the same reason.
  const repointErr = await repointContactChildren(db, accountId, survivorId, orphanId)
  if (repointErr) {
    return {
      ...outcome,
      merged: false,
      reason: `failed to move dependent rows off the orphan: ${repointErr}`,
    }
  }

  // --- 3. Absorb identity ---------------------------------------------
  // The BSUID is the most valuable thing the orphan has: it's the only
  // stable key for a person Meta identified without a phone number.
  const absorbed: Record<string, unknown> = {}
  const orphanBsuid = normalizeMetaIdentifier(orphan.wa_user_id ?? orphan.phone)
  if (orphanBsuid && !normalizeMetaIdentifier(survivor.wa_user_id)) {
    absorbed.wa_user_id = orphanBsuid
  }
  // Persist in the same shape the webhook writes: a single leading '@'.
  const orphanHandle = normalizeUsername(orphan.username)
  if (orphanHandle && !normalizeUsername(survivor.username)) {
    absorbed.username = `@${orphanHandle}`
  }
  // Display name only when the survivor has none — never clobber a name a
  // human chose in the CRM with one Meta supplied.
  if (!survivor.name && orphan.name) absorbed.name = orphan.name

  if (Object.keys(absorbed).length > 0) {
    const { error: absorbErr } = await db
      .from('contacts')
      .update({ ...absorbed, updated_at: new Date().toISOString() })
      .eq('id', survivorId)
      .eq('account_id', accountId)

    if (absorbErr) {
      return {
        ...outcome,
        merged: false,
        reason: `failed to absorb identity into survivor: ${absorbErr.message}`,
      }
    }
    outcome.fieldsAbsorbed = Object.keys(absorbed)
  }

  // --- 4. Drop the orphan ---------------------------------------------
  // Last, so any earlier failure leaves both rows intact.
  const { error: deleteErr } = await db
    .from('contacts')
    .delete()
    .eq('id', orphanId)
    .eq('account_id', accountId)

  if (deleteErr) {
    return {
      ...outcome,
      merged: false,
      reason: `failed to delete orphan contact: ${deleteErr.message}`,
    }
  }

  outcome.merged = true
  console.log(
    `[contact-merge] merged contact ${orphanId} into ${survivorId} (matched on ${justification}): ` +
      `${outcome.conversationsMoved} conversation(s), ${outcome.messagesMoved} message(s), absorbed [${outcome.fieldsAbsorbed.join(', ') || 'nothing'}]`,
  )
  return outcome
}