import {
  isDialablePhone,
  normalizeMetaIdentifier,
  normalizeUsername,
  passthroughMetaId,
  toDialable,
} from './phone-utils'
import { metaIdFromRawPayload } from './broadcast-address'
import { InvalidRecipientError, MetaApiError } from './meta-api'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import type { SupabaseClient } from '@supabase/supabase-js'

// The phone-vs-identifier boundary is defined once, in `phone-utils`, and
// shared with the Meta payload builder so a BSUID is classified the same
// way at resolve time and at send time. Re-exported here because this
// module is the historical import site for callers and tests.
export {
  isDialablePhone,
  toDialable,
  isMetaIdentifier,
  normalizeMetaIdentifier,
  normalizeUsername,
  passthroughMetaId,
} from './phone-utils'

/**
 * Dynamic recipient resolution.
 *
 * Every outbound path needs the same question answered: given a contact
 * row, what address goes in Meta's `to` field? The answer is not
 * derivable from the row alone, because a contact can be identified by a
 * phone number, by a BSUID (sender on an unregistered number), or by a
 * public @username — and the row we hold is frequently a mix of a stale
 * value and a good one.
 *
 * This module is deliberately free of any account-, number- or id-specific
 * knowledge. It reads whatever is in the database at call time, so the
 * same code path serves every WABA, every contact and every future
 * Meta identifier shape.
 */

/** The identity fields a contact can be addressed by. */
export interface RecipientCandidate {
  id?: string | null
  account_id?: string | null
  phone?: string | null
  wa_user_id?: string | null
  username?: string | null
  name?: string | null
  recipient_id?: string | null
  /** Numeric id Meta used as the inbound `from`. */
  wa_id?: string | null
  /** The contact's stored `metadata` bag (may hold a `wa_id` / `bsuid`). */
  metadata?: unknown
}

/** Where the chosen address came from — useful for logging and tests. */
export type RecipientSource =
  | 'phone' // a real number was already on the contact
  | 'recovered' // dug out of another row sharing this contact's identity
  | 'bsuid' // no number anywhere; Meta accepts the BSUID as `to`
  | 'username' // last resort: the public handle

export interface ResolvedRecipient {
  /** Value to place in Meta's `to`. Empty when nothing was resolvable. */
  to: string
  source: RecipientSource
  /** True when `to` is a dialable E.164 number rather than an opaque id. */
  isPhone: boolean
  /**
   * Set when `to` came from a DIFFERENT row than the contact we started
   * from. Callers persist this back so the stale value stops recurring.
   */
  recoveredFrom?: { contactId?: string | null; field?: 'phone' | 'wa_user_id' }
}

/**
 * The identity keys a contact can be looked up by, in the order we trust
 * them. Used to build the PostgREST `.or(...)` filter, so a single query
 * covers phone and BSUID at once.
 *
 * @username is deliberately NOT part of this set: it is not an identifier,
 * and including it would let a handle match pull a second, different phone
 * number into the same contact.
 */
export function identityFilterParts(contact: RecipientCandidate): string[] {
  const parts: string[] = []
  const phone = toDialable(contact.phone)
  if (phone) parts.push(`phone.eq.${phone}`)
  const bsuid = normalizeMetaIdentifier(contact.wa_user_id ?? contact.phone)
  if (bsuid) parts.push(`wa_user_id.eq.${bsuid}`)
  return parts
}

/**
 * Recover a real phone number for `contact` from its OWN conversation
 * history only.
 *
 * The bot must answer the exact address the customer wrote from. A number
 * found on any OTHER contact row is out of bounds — it may belong to a
 * different phone number/profile, and using it would deliver the reply to
 * the wrong person. So this never queries sibling contacts.
 *
 * Resolution order:
 *   1. the contact's own `phone`, when it is already dialable (a stale
 *      read-through rather than a recovery);
 *   2. the newest dialable `sender_phone` recorded on messages of THIS
 *      contact's conversation. When `conversationId` is given, the search
 *      is confined to that single thread.
 *
 * Returns null when nothing has a number: we never fabricate one.
 */
export async function findRecoverablePhone(
  contact: RecipientCandidate,
  accountId: string,
  conversationId?: string | null,
): Promise<{ phone: string; fromContactId: string | null } | null> {
  const own = toDialable(contact.phone)
  if (own) return { phone: own, fromContactId: contact.id ?? null }
  if (!contact.id) return null

  const fromHistory = await findPhoneInMessageHistory(
    contact.id,
    accountId,
    conversationId,
  ).catch(() => null)
  if (fromHistory) return { phone: fromHistory, fromContactId: null }
  return null
}

/**
 * The newest real number Meta ever used on this contact's own messages.
 *
 * Scoped to this contact's conversations — and, when `conversationId` is
 * given, to that single conversation — so a number that belongs to a
 * different contact can never be picked up. Only E.164 values are
 * considered: a stored BSUID is exactly the thing we're trying to get past.
 *
 * Best-effort by design — any failure yields null and the caller falls
 * through to the identifier branches.
 */
async function findPhoneInMessageHistory(
  contactId: string,
  accountId: string,
  conversationId?: string | null,
): Promise<string | null> {
  const db = supabaseAdmin()

  // `messages` has no account_id, so the conversation ids are resolved
  // first and scoped to this contact. This is the isolation boundary:
  // another contact's thread must never be consulted.
  let ids: string[]
  if (conversationId) {
    const { data: conversation } = await db
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .maybeSingle()
    if (!conversation) return null
    ids = [(conversation as { id: string }).id]
  } else {
    const { data: conversations } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .limit(20)
    ids = ((conversations ?? []) as Array<{ id: string }>).map((c) => c.id)
  }
  if (ids.length === 0) return null

  // Newest first: a number the customer used recently is far likelier to
  // be the current one than something from months ago.
  const { data } = await db
    .from('messages')
    .select('sender_phone')
    .in('conversation_id', ids)
    .not('sender_phone', 'is', null)
    .order('created_at', { ascending: false })
    .limit(50)

  for (const row of (data ?? []) as Array<{
    sender_phone?: string | null;
  }>) {
    const dialable = toDialable(row.sender_phone ?? null)
    if (dialable) {
      console.log(
        `[recipient-resolver] recovered a valid number for contact ${contactId}${
          conversationId ? ` in conversation ${conversationId}` : ''
        } from its message history: ${dialable}`,
      )
      return dialable
    }
  }
  return null
}

/** First value in `values` that Meta accepts as an id/number, or null. */
function firstDeliverableIdentifier(values: readonly unknown[]): string | null {
  for (const value of values) {
    const id = passthroughMetaId(typeof value === 'string' ? value : null)
    if (id) return id
  }
  return null
}

/**
 * The newest deliverable Meta identifier this contact has ever been addressed
 * by, from its OWN thread: the id Meta itself attached to the customer's
 * inbound message.
 *
 * `findRecoverablePhone` only surfaces a real NUMBER and only reads
 * `messages.sender_phone`. A privacy-redacted sender (`@user` / `@lid`) has no
 * number anywhere, and Meta records their numeric id in
 * `messages.raw_meta_payload` (`{ message, contact }`) instead. A contact
 * reachable ONLY through that id was therefore invisible to the shared ladder
 * while the send core's waterfall could still see it — so a follow-up timer
 * closed a row the core would have delivered. This reads the SAME sources the
 * waterfall reads (the conversation-level `wa_id` / `channel_id`, the newest
 * inbound `sender_phone`, and the stored payload), so every sender resolves
 * the same address.
 *
 * Best-effort by design: any failure yields null and the caller falls through
 * to the username branch. Never reads another contact's thread.
 */
export async function findRecoverableIdentifier(
  contact: RecipientCandidate,
  accountId: string,
  conversationId?: string | null,
): Promise<string | null> {
  if (!contact.id) return null

  // The contact row's own `metadata` bag can carry the id when it never made
  // it into a dedicated column.
  const meta =
    contact.metadata && typeof contact.metadata === 'object'
      ? (contact.metadata as Record<string, unknown>)
      : null
  const fromContactMeta = firstDeliverableIdentifier([
    meta?.wa_id,
    meta?.bsuid,
    meta?.channel_id,
  ])
  if (fromContactMeta) return fromContactMeta

  const db = supabaseAdmin()

  let ids: string[]
  if (conversationId) {
    const { data: conversation } = await db
      .from('conversations')
      .select('id, wa_id, channel_id, metadata')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .maybeSingle()
    if (!conversation) return null
    const convo = conversation as {
      id: string
      wa_id?: string | null
      channel_id?: string | null
      metadata?: Record<string, unknown> | null
    }
    const fromConversation = firstDeliverableIdentifier([
      convo.wa_id,
      convo.channel_id,
      convo.metadata?.wa_id,
      convo.metadata?.bsuid,
      convo.metadata?.channel_id,
    ])
    if (fromConversation) return fromConversation
    ids = [convo.id]
  } else {
    const { data: conversations } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .limit(20)
    ids = ((conversations ?? []) as Array<{ id: string }>).map((c) => c.id)
  }
  if (ids.length === 0) return null

  const { data } = await db
    .from('messages')
    .select('sender_phone, raw_meta_payload')
    .in('conversation_id', ids)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(50)

  for (const row of (data ?? []) as Array<{
    sender_phone?: string | null
    raw_meta_payload?: unknown
  }>) {
    const id = firstDeliverableIdentifier([
      row.sender_phone,
      metaIdFromRawPayload(row.raw_meta_payload),
    ])
    if (id) return id
  }
  return null
}

/**
 * Resolve the value Meta should receive in `to`, for any contact.
 *
 * Resolution order — everything comes from THIS contact (and its own
 * thread), never from another contact:
 *   1. `contact.phone`, if it is a dialable E.164 number.
 *   2. A real number recovered from this contact's OWN conversation
 *      history (`messages.sender_phone`), when `phone` still holds a BSUID.
 *   3. `wa_id` — the numeric id Meta used as the inbound `from`, i.e. the
 *      address that demonstrably reached us, so the one most likely to be
 *      accepted back.
 *   4. `wa_user_id` — the BSUID. Meta accepts a BSUID as the recipient for
 *      BSUID/Threads/API conversations.
 *   5. `recipient_id` — the alternative Meta identifier.
 *   5b. A numeric id recovered from THIS contact's own inbound message
 *      (`sender_phone` / `raw_meta_payload`) or its conversation row — the
 *      trace a `@user`/`@lid` sender leaves without ever touching a column.
 *   6. `username`, as a last resort.
 *
 * `wa_id` and `recipient_id` used to be consulted only by `resolveBestRecipient`,
 * so the AI reply and the INBOX manual send could disagree about the same
 * contact: the automation engine could reach someone the bot could not. One
 * ladder, consulted identically by every sender.
 *
 * Nothing here is specific to a WABA, a number or an identifier: every
 * branch is decided by the data present at call time.
 */
export async function resolveRecipient(
  contact: RecipientCandidate | null | undefined,
  accountId: string,
  conversationId?: string | null,
): Promise<ResolvedRecipient> {
  if (!contact) return { to: '', source: 'bsuid', isPhone: false }

  // 1. The canonical case: a number we can dial.
  const own = toDialable(contact.phone)
  if (own) return { to: own, source: 'phone', isPhone: true }

  // 2. `phone` is missing or holds an identifier — look for a real number
  //    in this contact's own thread before giving up.
  const recovered = await findRecoverablePhone(contact, accountId, conversationId).catch(
    () => null,
  )
  if (recovered) {
    return {
      to: recovered.phone,
      source: 'recovered',
      isPhone: true,
      recoveredFrom: { contactId: recovered.fromContactId, field: 'phone' },
    }
  }

  // 3. `wa_id` — what Meta itself addressed us with on the inbound message.
  const waId = passthroughMetaId(contact.wa_id)
  if (waId) return { to: waId, source: 'bsuid', isPhone: false }

  // 4. The BSUID is a first-class `to` value for Meta.
  const bsuid = normalizeMetaIdentifier(contact.wa_user_id ?? contact.phone)
  if (bsuid) return { to: bsuid, source: 'bsuid', isPhone: false }

  // 5. `recipient_id` — the alternative Meta identifier.
  const recipientId = passthroughMetaId(contact.recipient_id)
  if (recipientId) return { to: recipientId, source: 'bsuid', isPhone: false }

  // 5b. The id Meta left on this contact's OWN inbound message — the only
  //     trace a privacy-redacted `@user`/`@lid` sender leaves when it never
  //     made it onto the contact row. Same sources as the send core's
  //     waterfall, so a timer never closes a row dispatch could deliver.
  const recoveredId = await findRecoverableIdentifier(
    contact,
    accountId,
    conversationId,
  ).catch(() => null)
  if (recoveredId) {
    return { to: recoveredId, source: 'bsuid', isPhone: false }
  }

  // 6. The public handle, as `@user`.
  const storedHandle =
    contact.phone && contact.phone.trim().startsWith('@')
      ? normalizeUsername(contact.phone)
      : null
  if (storedHandle) return { to: storedHandle, source: 'username', isPhone: false }

  const handle = normalizeUsername(contact.username)
  if (handle) return { to: handle, source: 'username', isPhone: false }

  return { to: '', source: 'bsuid', isPhone: false }
}

/**
 * Every address this contact could legitimately be reached at, best first.
 *
 * THE single retry list for all outbound paths. It used to exist twice: a
 * hand-rolled copy inside `sendWithRecipientFallback` (manual INBOX send) and
 * `recipientAddressQueue` in `flows/meta-send` (AI reply, flows). They drifted
 * in the one way that mattered — the AI copy gated every candidate through
 * `isDialablePhone`, so it could never retry a BSUID, a `@handle` or a
 * `recipient_id`. Opaque identifiers are exactly the addresses that get
 * rejected, so that gate made the AI retry useless for the contacts least
 * likely to be reachable. One permissive list, both paths.
 *
 * `primary` comes first and is de-duplicated, so an unchanged contact yields a
 * single-entry queue and behaves exactly as before.
 *
 * Every entry comes from THIS contact or its own thread. Nothing here reads a
 * sibling contact's rows: an address found elsewhere may belong to a different
 * person, and delivering to it would send the message to a stranger.
 */
export async function recipientAddressQueue(
  contact: RecipientCandidate | null | undefined,
  accountId: string,
  primary: string,
  conversationId?: string | null,
  options?: {
    /**
     * Invoked when a dialable number is dug out of the contact's own history.
     * Callers persist it so the stale identifier stops recurring on every send
     * — without it, a contact whose `phone` still holds a BSUID re-runs the
     * lookup forever.
     */
    onRecovered?: (phone: string) => void | Promise<void>
  },
): Promise<string[]> {
  const queue: string[] = []
  const push = (value: string | null | undefined) => {
    if (value && !queue.includes(value)) queue.push(value)
  }

  push(primary)
  if (!contact) return queue

  // A number Meta actually used on THIS contact's own thread — the usual
  // outcome when `phone` still holds a BSUID but the person has messaged
  // from a registered number before. Never reads another contact's rows.
  const recovered = await findRecoverablePhone(
    contact,
    accountId,
    conversationId,
  ).catch(() => null)
  if (recovered?.phone && !queue.includes(recovered.phone)) {
    queue.push(recovered.phone)
    if (options?.onRecovered && toDialable(contact.phone) !== recovered.phone) {
      await Promise.resolve(options.onRecovered(recovered.phone)).catch(
        () => undefined,
      )
    }
  }

  // An opaque id recovered from this contact's own inbound payload — the
  // privacy-redacted `@user` case, where no number exists anywhere.
  const recoveredId = await findRecoverableIdentifier(
    contact,
    accountId,
    conversationId,
  ).catch(() => null)
  push(recoveredId)

  push(toDialable(contact.phone))
  push(passthroughMetaId(contact.wa_id))
  push(normalizeMetaIdentifier(contact.wa_user_id ?? contact.phone))
  push(passthroughMetaId(contact.recipient_id))
  push(
    contact.phone && contact.phone.trim().startsWith('@')
      ? normalizeUsername(contact.phone)
      : null,
  )
  push(normalizeUsername(contact.username))

  return queue
}

/**
 * The newest inbound wamid in a conversation, to be used as Meta's
 * `context.message_id` anchor.
 *
 * WHY THIS EXISTS — the actual cause of "the AI answers these contacts but the
 * INBOX can't send to them":
 *
 * A contact we can only identify by an opaque id (a `@user` display id, a
 * BSUID, a `WAID.`/`LID.` id) cannot be addressed directly in `to`. WhatsApp
 * will only accept such a message as a QUOTE of one of that person's own
 * messages. The AI path always passed its inbound wamid along
 * (`engineSendAiReply` -> `contextMessageId: args.composeMessageId`), so its
 * replies landed. The manual INBOX path only set `contextMessageId` when the
 * operator explicitly hit "Reply" on a specific bubble, so a plain new message
 * to the same contact went out unanchored and was silently dropped by Meta
 * despite a 200 response.
 *
 * Scoped to customer-sent messages in this one conversation: the anchor must be
 * a message the recipient actually wrote, and must never come from another
 * thread.
 */
export async function latestInboundAnchorId(
  db: Pick<SupabaseClient, 'from'>,
  conversationId: string | null | undefined,
): Promise<string | null> {
  if (!conversationId) return null

  // The anchor lookup must never take the send down. Callers should hand a
  // service-role client (`supabaseAdmin()`), but even a broken or
  // RLS-blocked client is handled here: whatever fails, we degrade to null
  // and the caller addresses the contact directly or refuses locally.
  let row: { message_id?: string | null } | undefined
  try {
    const { data, error } = await db
      .from('messages')
      .select('message_id')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .not('message_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)

    if (error) {
      // Best-effort: an anchor we cannot read must not fail the send. The caller
      // falls back to addressing the contact directly.
      console.warn(
        '[recipient-resolver] could not read an inbound anchor for conversation',
        conversationId,
        '-',
        error.message,
      )
      return null
    }
    row = (data ?? [])[0] as { message_id?: string | null } | undefined
  } catch (err) {
    console.warn(
      '[recipient-resolver] inbound anchor lookup for conversation',
      conversationId,
      'failed:',
      err instanceof Error ? err.message : err,
    )
    return null
  }

  return row?.message_id ?? null
}

/**
 * Per-attempt `context.message_id` resolution for senders that walk
 * `recipientAddressQueue`.
 *
 * WHY per-attempt and not one anchor resolved up front: the queue can
 * CHANGE identity mid-walk. REGLA 1 puts a dialable `phone` first (no
 * anchor needed), and only after Meta rejects that number does the queue
 * escalate to an opaque id — `wa_id` / BSUID / `@handle`. THAT is the
 * escalation where #131009 bites: the opaque id sent cold, because the
 * phone-first resolution decided no anchor would ever be needed. So the
 * anchor FOLLOWS the address actually being attempted: a dialable number
 * gets none, an opaque id gets the thread's newest customer wamid,
 * looked up lazily on first use and memoized for the rest of the send
 * (an all-phone send never touches `messages`).
 *
 * `fixed` — an explicit reply quote, or the anchor already resolved for
 * an opaque-first send — always wins: it is the message this send is
 * answering.
 */
export function createAnchorResolver(
  db: Pick<SupabaseClient, 'from'>,
  conversationId: string | null | undefined,
  fixed?: string | null,
): (address: string) => Promise<string | undefined> {
  let cached: string | null | undefined
  return async (address: string): Promise<string | undefined> => {
    if (fixed) return fixed
    if (isDialablePhone(address)) return undefined
    if (cached === undefined) {
      cached = await latestInboundAnchorId(db, conversationId)
    }
    return cached ?? undefined
  }
}

/**
 * True when a send failure means "Meta rejected this address", as opposed
 * to a template, permission or network problem. Only these justify trying
 * a different recipient — resending on a template error would double-send.
 */
export function isRecipientRejection(err: unknown): boolean {
  if (err instanceof MetaApiError) return err.recipientInvalid
  const message = err instanceof Error ? err.message : String(err)
  return /invalid\s+(recipient|phone|number)|not\s+in\s+allowed\s+list|undeliverable|131009|131026|131047|131030/i.test(
    message,
  )
}

/**
 * Run `send` against the best address for `contact`, and if Meta rejects
 * that address, walk the shared `recipientAddressQueue` until one works.
 *
 * The retry is identity-preserving: addresses already attempted are skipped,
 * so a contact with three stale values cannot produce a duplicate send.
 */
export async function sendWithRecipientFallback<T>(args: {
  contact: RecipientCandidate
  accountId: string
  /** The contact's thread, so recovery only ever reads its own history. */
  conversationId?: string | null
  send: (to: string) => Promise<T>
  /** Persist a recovered number so the stale value stops recurring. */
  onRecovered?: (phone: string) => void | Promise<void>
  /**
   * The address this send starts from, when an external resolver (the
   * destination cascade) already chose it. Without it, the queue head is
   * resolved from the contact row by `resolveRecipient`. Provided, it skips
   * the ladder and sends to this value FIRST — the retry queue is otherwise
   * identical — which lets a conversational source the contact row does not
   * carry (a `conversations.wa_id`, a channel BSUID, the last inbound
   * `from`) become the leading destination.
   */
  first?: ResolvedRecipient
}): Promise<T> {
  const { contact, accountId, conversationId, send, onRecovered, first } = args

  const head =
    first ?? (await resolveRecipient(contact, accountId, conversationId))
  // A contact the ladder cannot resolve at all — no dialable number, no
  // wa_id/BSUID/recipient_id, no handle. TYPED rather than a bare Error so
  // the HTTP layer maps it to a 422 explaining the contact has no usable
  // address, instead of collapsing into a generic 502 that looks like a
  // Meta outage. Still `recipientInvalid`, so any retry/park machinery
  // downstream treats it as "this address does not work".
  if (!head.to) {
    throw new InvalidRecipientError(
      '',
      'the contact has no dialable number, wa_id, wa_user_id, recipient_id ' +
        'or username to address the message to. No HTTP request was sent.',
    )
  }

  if (head.source === 'recovered' && head.isPhone && onRecovered) {
    await Promise.resolve(onRecovered(head.to)).catch(() => undefined)
  }

  // One list, shared with the AI reply path. It used to be rebuilt inline here,
  // which is how the manual sender and the bot ended up with different ideas of
  // which addresses this contact can be reached at.
  const queue = await recipientAddressQueue(
    contact,
    accountId,
    head.to,
    conversationId,
    { onRecovered },
  )
  // Everything after the address we already tried.
  const alternatives = queue.filter((to) => to !== head.to)

  try {
    return await send(head.to)
  } catch (err) {
    if (!isRecipientRejection(err)) throw err
    if (alternatives.length === 0) throw err

    let lastError: unknown = err
    for (const to of alternatives) {
      try {
        return await send(to)
      } catch (retryErr) {
        lastError = retryErr
        if (!isRecipientRejection(retryErr)) throw retryErr
      }
    }
    throw lastError
  }
}

/**
 * Resolve the best recipient identifier for a contact, in strict priority
 * order, with NO account- or destination-specific knowledge:
 *
 *   1. `phone`, when it is a dialable E.164 number (a `+` or spaces are
 *      normalized away by `toDialable`).
 *   2. `wa_id` — the numeric id Meta used as the inbound `from`. This is the
 *      field that carries a `@lid` / `@user` sender's underlying id.
 *   3. `wa_user_id` — the BSUID.
 *   4. `recipient_id` — the alternative Meta identifier.
 *   5. `username` — the public handle.
 *
 * When `accountId` is supplied it also consults `resolveRecipient`, which can
 * recover a real number from this contact's own conversation history — a
 * contact whose `phone` still holds an identifier but who has messaged from a
 * registered number before.
 *
 * `accountId` is optional so callers holding a bare identifier set (the
 * automation engine, which selects a subset of columns) can use this without
 * widening the query or casting.
 */
export async function resolveBestRecipient(
  contact: RecipientCandidate | null | undefined,
  accountId?: string | null,
  conversationId?: string | null,
): Promise<ResolvedRecipient> {
  if (!contact) return { to: '', source: 'bsuid', isPhone: false }

  // 1. Phone — a real number always wins.
  const phone = toDialable(contact.phone)
  if (phone) return { to: phone, source: 'phone', isPhone: true }

  // 2. wa_id — the numeric id from the inbound message's `from`. Checked
  //    before the BSUID because it is the address Meta actually used to reach
  //    this contact, so it is the one most likely to be accepted back.
  const waId = passthroughMetaId(contact.wa_id)
  if (waId) return { to: waId, source: 'bsuid', isPhone: false }

  // 3. BSUID. Also covers the legacy case where a BSUID was written into
  //    `phone` before the two concepts were separated.
  const bsuid = passthroughMetaId(contact.wa_user_id) ?? passthroughMetaId(contact.phone)
  if (bsuid) return { to: bsuid, source: 'bsuid', isPhone: false }

  // 4. recipient_id — alternative Meta identifier.
  const recipientId = passthroughMetaId(contact.recipient_id)
  if (recipientId) return { to: recipientId, source: 'bsuid', isPhone: false }

  // 5. Username.
  const handle = normalizeUsername(contact.username)
  if (handle) return { to: handle, source: 'username', isPhone: false }

  // Optional deeper pass: recover a number from this contact's own thread.
  if (accountId) {
    const fallback = await resolveRecipient(contact, accountId, conversationId)
    if (fallback.to) return fallback
  }

  return { to: '', source: 'bsuid', isPhone: false }
}