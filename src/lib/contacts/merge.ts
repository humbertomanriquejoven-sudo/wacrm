import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isDialablePhone,
  normalizeMetaIdentifier,
  normalizeUsername,
  toDialable,
} from '@/lib/whatsapp/recipient-resolver'

/**
 * Automatic merge of two rows that describe the same person.
 *
 * Meta identifies a sender three different ways, and the identity a person
 * uses changes over time: a first message from an unregistered number
 * arrives with only a BSUID, creating a contact whose `phone` holds that
 * opaque id. Their next message from a registered number carries the real
 * phone, and the webhook can match it against a DIFFERENT row. Two rows,
 * one person, one split thread.
 *
 * This module folds the orphan into the real contact:
 *   1. every conversation moves across, and so do its messages;
 *   2. identity fields the survivor lacks are absorbed from the orphan
 *      (the BSUID is the whole point — it's the only stable key we have);
 *   3. the orphan row is deleted.
 *
 * Destructive by design, and only ever called once the caller has proven
 * both rows are the same person. Everything is scoped by `account_id`, so
 * a merge can never cross tenants.
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

/** Fold keys, most to least trustworthy. */
export type MergeKey = 'wa_user_id' | 'username' | 'name'

/**
 * Compare display names for the name-only fallback.
 *
 * Case-, accent- and whitespace-insensitive, because Meta decorates the
 * same person's name differently across messages ("José Ruiz",
 * "jose ruiz", "Jose  Ruiz ") and a strict equality test would miss all
 * three as one person.
 */
function sameDisplayName(a?: string | null, b?: string | null): boolean {
  const fold = (value?: string | null) =>
    (value ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  const left = fold(a)
  return left.length > 0 && left === fold(b)
}

/**
 * Decide whether `orphan` and `survivor` are the same person.
 *
 * Ordered strongest-evidence-first. A merge deletes a row and rewrites
 * history, so each tier has to earn its risk:
 *
 *   1. `wa_user_id` — a per-WABA identity, stable across renames and
 *      number changes. Unambiguous.
 *   2. `username` — a global handle, likewise stable.
 *   3. `name` — a *display string*, and the weakest evidence there is:
 *      WhatsApp names are not unique and are freely chosen. Accepted only
 *      because the caller has already proven the name is unambiguous within
 *      the account (see `findMergeableOrphan`), which is why this function
 *      does not check it. Never call this standalone to authorise a merge.
 *
 * Returns the key that justified the decision, for logging.
 */
export function mergeJustification(
  orphan: MergeCandidate,
  survivor: MergeCandidate,
  options: { allowNameMatch?: boolean } = {},
): MergeKey | null {
  const orphanBsuid = normalizeMetaIdentifier(orphan.wa_user_id ?? orphan.phone)
  const survivorBsuid = normalizeMetaIdentifier(survivor.wa_user_id ?? survivor.phone)
  if (orphanBsuid && survivorBsuid && orphanBsuid === survivorBsuid) return 'wa_user_id'

  const orphanHandle = normalizeUsername(orphan.username)
  const survivorHandle = normalizeUsername(survivor.username)
  if (orphanHandle && survivorHandle && orphanHandle === survivorHandle) return 'username'

  // Opt-in only: the caller must have established the name is unique in
  // this account, otherwise two strangers sharing a name get merged.
  if (options.allowNameMatch && sameDisplayName(orphan.name, survivor.name)) return 'name'

  return null
}

/**
 * Find an orphan contact that should be folded into `survivor`.
 *
 * An orphan is a row whose `phone` is not dialable — either empty or still
 * holding a BSUID — that plausibly belongs to `survivor`. Returns null when
 * there is nothing to merge, which is the overwhelmingly common case and
 * must stay cheap: one indexed read, and nothing else when no orphan exists.
 *
 * Matching widens progressively. A shared BSUID or @handle settles it. When
 * the survivor has neither — Meta gave a real number with no other
 * identifier — the search falls back to the display name, and that fallback
 * only fires when the name identifies exactly ONE other row in the account.
 * Two people called "Ana" therefore never merge, while the single "Ana"
 * with a BSUID-only row does.
 */
export async function findMergeableOrphan(
  db: SupabaseClient,
  accountId: string,
  survivor: MergeCandidate,
): Promise<MergeCandidate | null> {
  // Only a survivor with a REAL phone is a merge candidate: merging two
  // identifier-only rows would gain nothing and could lose data.
  if (!toDialable(survivor.phone)) return null

  const stable: string[] = []
  const bsuid = normalizeMetaIdentifier(survivor.wa_user_id)
  if (bsuid) stable.push(`wa_user_id.eq.${bsuid}`)
  // Stored usernames keep the leading '@' (see the webhook), so the
  // PostgREST filter has to reproduce that exact shape or the lookup
  // silently misses every row.
  const handle = normalizeUsername(survivor.username)
  if (handle) stable.push(`username.eq.@${handle}`)

  const select =
    'id, account_id, phone, name, username, wa_user_id'

  if (stable.length > 0) {
    const { data } = await db
      .from('contacts')
      .select(select)
      .eq('account_id', accountId)
      .neq('id', survivor.id)
      .or(stable.join(','))
      .limit(10)

    const candidates = (data ?? []) as MergeCandidate[]
    for (const candidate of candidates) {
      // Must itself be an orphan — a row with a real number is a different
      // situation (two registered numbers), not something to fold away.
      if (isDialablePhone(candidate.phone)) continue
      if (!mergeJustification(candidate, survivor)) continue
      return candidate
    }
    return null
  }

  // --- Name fallback ----------------------------------------------------
  // No stable identifier on the survivor. Before trusting a display name we
  // count how many rows in this account carry it: one is a match, two or
  // more is an ambiguity we refuse rather than guess at. The count is over
  // orphans only, so a same-named contact that does have a real number
  // cannot mask a genuine match.
  const name = survivor.name?.trim()
  if (!name) return null

  const { data: nameMatches } = await db
    .from('contacts')
    .select(select)
    .eq('account_id', accountId)
    .eq('name', name)
    .neq('id', survivor.id)
    .limit(10)

  const byName = ((nameMatches ?? []) as MergeCandidate[]).filter(
    (c) => !isDialablePhone(c.phone),
  )

  if (byName.length !== 1) {
    if (byName.length > 1) {
      console.warn(
        `[contact-merge] ${survivor.id}: name "${name}" matches ${byName.length} orphan contacts — refusing to guess which one is the same person`,
      )
    }
    return null
  }

  // The `.eq('name', …)` filter is an exact match, but the caller's own
  // name may differ in case or accents from what Meta stored, so the
  // comparison is redone with the folding rules.
  const candidate = byName[0]
  if (!mergeJustification(candidate, survivor, { allowNameMatch: true })) return null

  console.log(
    `[contact-merge] ${survivor.id}: no BSUID or username, falling back to the unique name match "${name}" with orphan ${candidate.id}`,
  )
  return candidate
}

/**
 * Is a display-name match safe to act on for this pair?
 *
 * True only when the two rows share no stable identity (nothing better to
 * go on), their names match, and exactly one orphan in the account carries
 * that name. Re-queries rather than trusting a flag threaded in from the
 * caller, because by the time `mergeContactInto` runs, rows may have moved.
 */
async function isNameUnambiguous(
  db: SupabaseClient,
  accountId: string,
  survivor: MergeCandidate,
  orphan: MergeCandidate,
): Promise<boolean> {
  // A stable identity shared by both rows already settles it; the name
  // check is irrelevant and would only add a pointless query.
  if (mergeJustification(orphan, survivor)) return false

  const name = survivor.name?.trim()
  if (!name || !orphan.name?.trim()) return false

  const { count } = await db
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('name', name)
    .neq('id', survivor.id)

  return count === 1
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
  // not be able to trigger a destructive merge. A name match requires the
  // caller to have established uniqueness via `findMergeableOrphan`.
  const outcome: MergeOutcome = { merged: false, ...EMPTY }

  const allowNameMatch = await isNameUnambiguous(db, accountId, survivor, orphan)
  const justification = mergeJustification(orphan, survivor, { allowNameMatch })
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