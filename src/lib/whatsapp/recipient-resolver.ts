import { normalizePhone } from './phone-utils'
import { MetaApiError } from './meta-api'
import { supabaseAdmin } from '@/lib/flows/admin-client'

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

/** E.164 in practice: 7–13 digits. Above 13 a value cannot be a number. */
const E164_MAX_DIGITS = 13
const E164_MIN_DIGITS = 7
/** Meta's namespace prefix on a BSUID. */
const BSUID_PREFIX_RE = /^(CO|WAID)\./i

/** The identity fields a contact can be addressed by. */
export interface RecipientCandidate {
  id?: string | null
  account_id?: string | null
  phone?: string | null
  wa_user_id?: string | null
  username?: string | null
  name?: string | null
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
 * True when `value` is a real, dialable E.164 phone number.
 *
 * The length ceiling is the load-bearing part. Meta's BSUIDs are 15–17
 * digits, and `normalizePhone` strips every non-digit, so both
 * 'CO.1008477715690681' and a bare '1008477715690681' reduce to the same
 * 16 digits — any "is it just digits?" test accepts them as a phone
 * number. Rejecting the namespace marker and anything past 13 digits is
 * what actually separates a number from an identifier.
 */
export function isDialablePhone(value: string | null | undefined): boolean {
  if (!value) return false
  const trimmed = value.trim()
  if (!trimmed) return false
  if (BSUID_PREFIX_RE.test(trimmed)) return false
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return false
  const digits = normalizePhone(trimmed).length
  return digits >= E164_MIN_DIGITS && digits <= E164_MAX_DIGITS
}

/** Digits-only form of `value`, or null when it isn't a phone number. */
export function toDialable(value: string | null | undefined): string | null {
  if (!value || !isDialablePhone(value)) return null
  return normalizePhone(value.trim()) || null
}

/**
 * True when `value` is a Meta identifier rather than a phone number:
 * explicitly namespaced, or simply too long to be E.164.
 */
export function isMetaIdentifier(value: string | null | undefined): boolean {
  if (!value) return false
  const trimmed = value.trim()
  if (!trimmed) return false
  if (BSUID_PREFIX_RE.test(trimmed)) return true
  return /^\d+$/.test(trimmed) && trimmed.length > E164_MAX_DIGITS
}

/** Normalize a Meta identifier for storage/comparison (drop the prefix). */
export function normalizeMetaIdentifier(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (BSUID_PREFIX_RE.test(trimmed)) return trimmed.replace(BSUID_PREFIX_RE, '').trim() || null
  return isMetaIdentifier(trimmed) ? trimmed : null
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
 * covers phone, BSUID and handle at once.
 */
export function identityFilterParts(contact: RecipientCandidate): string[] {
  const parts: string[] = []
  const phone = toDialable(contact.phone)
  if (phone) parts.push(`phone.eq.${phone}`)
  const bsuid = normalizeMetaIdentifier(contact.wa_user_id ?? contact.phone)
  if (bsuid) parts.push(`wa_user_id.eq.${bsuid}`)
  const handle = normalizeUsername(contact.username)
  if (handle) parts.push(`username.eq.${handle}`)
  return parts
}

/**
 * Search for a real phone number belonging to the same person as
 * `contact`, using only identity we already trust for that person.
 *
 * Runs when the contact's own `phone` is not dialable — typically because
 * it holds a BSUID left behind by an older handler. We look for a sibling
 * row (same account, same BSUID / handle / exact display name) that DOES
 * carry a number, which is the common shape after a person first wrote
 * from a registered number and later from an unregistered one.
 *
 * Returns null when no sibling has a number: we never fabricate one.
 */
export async function findRecoverablePhone(
  contact: RecipientCandidate,
  accountId: string,
): Promise<{ phone: string; fromContactId: string | null } | null> {
  const parts = identityFilterParts(contact)
  if (parts.length === 0) return null

  // Display name is the weakest key, so only use it when the row carries
  // nothing stronger — a fuzzy/shared name must not attach a stranger's
  // number to this contact.
  if (!parts.some((p) => p.startsWith('wa_user_id.') || p.startsWith('username.'))) {
    if (contact.name) parts.push(`name.eq.${contact.name.replace(/[,()]/g, '')}`)
  }

  const db = supabaseAdmin()
  const { data } = await db
    .from('contacts')
    .select('id, phone')
    .eq('account_id', accountId)
    .or(parts.join(','))
    .limit(25)

  let fallback: { phone: string; fromContactId: string | null } | null = null
  for (const row of (data ?? []) as Array<{ id: string; phone: string }>) {
    const dialable = toDialable(row.phone)
    if (!dialable) continue
    // Prefer the contact's OWN row: if it has a number we simply read
    // through a stale snapshot rather than merging another identity.
    if (row.id === contact.id) return { phone: dialable, fromContactId: row.id }
    if (!fallback) fallback = { phone: dialable, fromContactId: row.id }
  }
  return fallback
}

/**
 * Resolve the value Meta should receive in `to`, for any contact.
 *
 * Resolution order:
 *   1. `contact.phone`, if it is a dialable E.164 number.
 *   2. A real number recovered from a sibling row sharing this contact's
 *      identity — the case where `phone` still holds a BSUID.
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
): Promise<ResolvedRecipient> {
  if (!contact) return { to: '', source: 'bsuid', isPhone: false }

  // 1. The canonical case: a number we can dial.
  const own = toDialable(contact.phone)
  if (own) return { to: own, source: 'phone', isPhone: true }

  // 2. `phone` is missing or holds an identifier — look for a real number
  //    under the same identity before giving up.
  const recovered = await findRecoverablePhone(contact, accountId).catch(() => null)
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

  // 4. Whatever handle we have.
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
  send: (to: string) => Promise<T>
  /** Persist a recovered number so the stale value stops recurring. */
  onRecovered?: (phone: string) => void | Promise<void>
}): Promise<T> {
  const { contact, accountId, send, onRecovered } = args
  const attempted = new Set<string>()

  const first = await resolveRecipient(contact, accountId)
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

    const recovered = await findRecoverablePhone(contact, accountId).catch(() => null)
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