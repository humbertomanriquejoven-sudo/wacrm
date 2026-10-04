import {
  isMetaIdentifier,
  normalizeMetaIdentifier,
  toDialable,
} from './phone-utils'
import { MetaApiError } from './meta-api'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// The phone-vs-identifier boundary is defined once, in `phone-utils`, and
// shared with the Meta payload builder so a BSUID is classified the same
// way at resolve time and at send time. Re-exported here because this
// module is the historical import site for callers and tests.
export {
  isDialablePhone,
  toDialable,
  isMetaIdentifier,
  normalizeMetaIdentifier,
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

/** Canonical form of a public handle: leading '@', no duplicate '@'. */
export function normalizeUsername(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().replace(/^@+/, '')
  if (!trimmed) return null
  if (isMetaIdentifier(trimmed)) return null
  // Handles are letters/digits/dot/underscore/hyphen. A bare digit run is
  // a number in disguise and must never be written to `username`.
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null
  if (/^\d+$/.test(trimmed)) return null
  return `@${trimmed}`
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

/**
 * Resolve the value Meta should receive in `to`, for any contact.
 *
 * Resolution order — everything comes from THIS contact (and its own
 * thread), never from another contact:
 *   1. `contact.phone`, if it is a dialable E.164 number.
 *   2. A real number recovered from this contact's OWN conversation
 *      history (`messages.sender_phone`), when `phone` still holds a BSUID.
 *   3. `wa_user_id` — Meta accepts a BSUID as the recipient for
 *      BSUID/Threads/API conversations.
 *   4. `username`, as a last resort.
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

  // 3. The BSUID is a first-class `to` value for Meta.
  const bsuid = normalizeMetaIdentifier(contact.wa_user_id ?? contact.phone)
  if (bsuid) return { to: bsuid, source: 'bsuid', isPhone: false }

  // 4. The public handle, as `@user`.
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
 * that address, re-resolve once and retry against a different identifier.
 *
 * The retry is deliberately single-shot and identity-preserving: we only
 * try again when the contact actually has another address on file, and we
 * skip addresses already attempted, so a contact with three stale values
 * can't produce a duplicate send.
 */
export async function sendWithRecipientFallback<T>(args: {
  contact: RecipientCandidate
  accountId: string
  /** The contact's thread, so recovery only ever reads its own history. */
  conversationId?: string | null
  send: (to: string) => Promise<T>
  /** Persist a recovered number so the stale value stops recurring. */
  onRecovered?: (phone: string) => void | Promise<void>
}): Promise<T> {
  const { contact, accountId, conversationId, send, onRecovered } = args
  const attempted = new Set<string>()

  const first = await resolveRecipient(contact, accountId, conversationId)
  if (!first.to) throw new Error('contact not found for this account')

  if (first.source === 'recovered' && first.isPhone && onRecovered) {
    await Promise.resolve(onRecovered(first.to)).catch(() => undefined)
  }
  attempted.add(first.to)

  try {
    return await send(first.to)
  } catch (err) {
    if (!isRecipientRejection(err)) throw err

    // The address Meta rejected. Build the list of alternatives this
    // contact still has and try each until one works.
    const alternatives: string[] = []
    const own = toDialable(contact.phone)
    if (own && !attempted.has(own)) alternatives.push(own)

    const recovered = await findRecoverablePhone(
      contact,
      accountId,
      conversationId,
    ).catch(() => null)
    if (recovered && !attempted.has(recovered.phone)) {
      alternatives.push(recovered.phone)
      if (onRecovered) {
        await Promise.resolve(onRecovered(recovered.phone)).catch(() => undefined)
      }
    }

    const bsuid = normalizeMetaIdentifier(contact.wa_user_id ?? contact.phone)
    if (bsuid && !attempted.has(bsuid)) alternatives.push(bsuid)

    const handle = normalizeUsername(contact.username)
    if (handle && !attempted.has(handle)) alternatives.push(handle)

    const storedHandle =
      contact.phone && contact.phone.trim().startsWith('@')
        ? normalizeUsername(contact.phone)
        : null
    if (storedHandle && !attempted.has(storedHandle)) alternatives.push(storedHandle)

    const recipientId = contact.recipient_id
    if (recipientId && !attempted.has(recipientId)) alternatives.push(recipientId)

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
 * The value to hand Meta for a NON-PHONE identifier, or null when unusable.
 *
 * Deliberately a PASS-THROUGH, unlike `normalizeMetaIdentifier`. That
 * function is a storage/comparison normalizer: it strips the `CO.` / `WAID.`
 * prefix and rejects anything not longer than 14 digits. That is correct for
 * comparing two rows and wrong for addressing a send — `CO.999` would come
 * back as `999`, and `999` is indistinguishable from a malformed phone
 * number, so the send would either fail or (worse) fabricate a number.
 *
 * Accepts exactly the shapes Meta reads as an identifier:
 *   - a namespaced id (`CO.…`, `WAID.…`, `LID.…`) — prefix preserved;
 *   - an all-digit run long enough not to be a truncated phone.
 *
 * A bare handle is rejected so it falls through to the `username` branch,
 * where the leading `@` is restored.
 */
function passthroughMetaId(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  // Placeholders that older rows / webhook defaults have been known to carry.
  if (/^(unknown|null|undefined|none|n\/a)$/i.test(trimmed)) return null
  // Namespaced id — keep the prefix and dot intact.
  if (/^[A-Za-z]+\.[\w.-]+$/.test(trimmed)) return trimmed
  // Bare digit run. The 6-digit floor keeps a stray fragment from being
  // mistaken for an id; there is no upper bound because a BSUID/LID is
  // routinely far longer than E.164.
  if (/^\+?\d{6,}$/.test(trimmed)) return trimmed.replace(/\D/g, '')
  return null
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