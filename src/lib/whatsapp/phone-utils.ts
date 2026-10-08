/**
 * Sanitize phone number for Meta WhatsApp API.
 * Meta requires digits only — no + prefix, no spaces, no dashes.
 * e.g. "+370 63949836" → "37063949836"
 */
export function cleanPhoneNumber(rawPhone: string): string | null {
  const v = (rawPhone ?? '').trim().toLowerCase()
  if (!v || v === 'unknown') return null
  const digits = v.replace(/\D/g, '')
  if (!digits) return null
  return digits
}

export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Normalize phone number by removing all non-digit characters.
 * Used for comparing phone numbers in different formats.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Compare two phone numbers accounting for trunk prefix differences.
 * e.g. "370063949836" (with trunk 0) matches "37063949836" (without trunk 0)
 * by comparing the last 8 digits.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1)
  const n2 = normalizePhone(phone2)
  if (n1 === n2) return true
  if (n1.length >= 8 && n2.length >= 8) {
    return n1.slice(-8) === n2.slice(-8)
  }
  return false
}

/**
 * Validate phone number is E.164-like format (7-15 digits starting with non-zero).
 * Accepts with or without + prefix.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone)
}

// -------------------------------------------------------------------
// Recipient classification (phone number vs. opaque Meta identifier)
// -------------------------------------------------------------------
//
// Meta's Cloud API takes a phone number in `to`, but a Business-Scoped
// User ID (BSUID) must go in `recipient` (with recipient_type
// "individual"). A BSUID placed in `to` returns HTTP 200 yet is silently
// dropped: Meta strips the namespace prefix, treats the rest as a phone
// number that never resolves, and surfaces no error. The split therefore
// has to be decided from the value's shape, and it has to be decided the
// same way everywhere — hence these live beside the other phone helpers.

/** Meta's namespace prefix on a BSUID. */
const BSUID_PREFIX_RE = /^(CO|WAID)\./i
/** E.164 in practice: 7–13 digits. Above 13 a value cannot be a number. */
const E164_MIN_DIGITS = 7
const E164_MAX_DIGITS = 13

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
 * Pull a phone number the customer TYPED out of their own message text.
 *
 * Needed for the senders Meta gives us no number for: the bot asks for their
 * number, they type it back, and nobody should have to retype it into the CRM
 * by hand. Only called when the contact has no dialable address already, so
 * it can only ever fill a blank — never overwrite a good number.
 *
 * Deliberately conservative, because the alternative is writing a wrong
 * number into `phone` and silently redirecting the conversation. Two accepted
 * shapes, in priority order:
 *
 *   1. An explicit international prefix — '+57 300 123 4567'. Unambiguous, so
 *      it wins over anything else in the message.
 *   2. A bare 11–13 digit run — '573001234567'. Long enough to carry a country
 *      code on its own, and bounded so a 15–17 digit BSUID never matches.
 *
 * A bare 10-digit number is NOT accepted: without a country code it can't be
 * told apart from an order/invoice/document number, and guessing the country
 * would send the customer's messages to a stranger. The bot is instructed to
 * ask for the number WITH its country code for exactly this reason.
 *
 * Returns the digits-only form, or null when nothing plausible was found.
 */
export function extractPhoneFromText(text: string | null | undefined): string | null {
  if (!text) return null
  // Long enough for any real answer, short enough that a pasted data dump
  // can't cost a full scan.
  const value = text.slice(0, 2000)

  const accepted = (digits: string): boolean =>
    digits.length >= 8 &&
    digits.length <= E164_MAX_DIGITS &&
    isValidE164(digits)

  // Pass 1 — explicit '+'. A window is taken from each '+' and then trimmed
  // to the longest leading phone-shaped run, so trailing prose ("+57 300 123
  // 4567. Hola") can't be glued onto the digits and invalidate a number that
  // was right there.
  let cursor = value.indexOf('+')
  while (cursor !== -1) {
    const window = value.slice(cursor, cursor + 30)
    const match = /^\+\s*\d[\d\s().-]*/.exec(window)
    if (match) {
      const digits = normalizePhone(match[0])
      if (accepted(digits)) return digits
    }
    cursor = value.indexOf('+', cursor + 1)
  }

  // Pass 2 — bare runs that already carry a country code. The lookarounds
  // keep a longer run from being sliced down into a fake 13-digit match.
  for (const run of value.match(/(?<!\d)\d{11,13}(?!\d)/g) ?? []) {
    if (accepted(run)) return run
  }

  return null
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

/** The address field(s) Meta's Messages API expects for one recipient. */
export interface MetaRecipientFields {
  /** A phone number goes here. Omitted when the address is a BSUID/handle. */
  to?: string
  /** A BSUID (or parent BSUID) goes here. Omitted for phone numbers. */
  recipient?: string
}

/**
 * Route an outbound address to the field Meta actually reads.
 *
 * A dialable number keeps going in `to` exactly as before. Anything else —
 * a BSUID, or a public @handle as a last resort — is opaque to Meta's
 * number rules and must travel in `recipient`, with `recipient_type`
 * already set to "individual" by the caller.
 *
 * Both fields are supported by the API, but when both are present `to`
 * wins. So the two are mutually exclusive here: sending a BSUID in `to`
 * is the silent-drop bug this exists to prevent.
 */
export function metaRecipientFields(address: string): MetaRecipientFields {
  const value = (address ?? '').trim()
  if (!value) return { to: '' }
  if (isDialablePhone(value)) return { to: value }
  return { recipient: value }
}

/**
 * Generate plausible phone number variants for retry when Meta's
 * sandbox rejects a number with error #131030 ("not in allowed list").
 *
 * Many countries use a "trunk prefix" 0 for domestic dialing that is
 * meant to be dropped in international format (e.g. Lithuanian
 * "+370 063 949 836" domestically → "+370 63 949 836" international).
 * But some sandboxes register the number with the trunk 0 included,
 * causing sends to the correct international format to fail.
 *
 * This helper yields up to 3 variants:
 *   1. The original sanitized number (first attempt)
 *   2. With a trunk 0 inserted after the country code
 *   3. With a trunk 0 removed after the country code
 *
 * Country-code lengths of 1, 2, and 3 digits are tried because we
 * don't know the user's country ahead of time.
 *
 * @param sanitized - digits-only phone number (from sanitizePhoneForMeta)
 * @returns deduplicated list of variants, original first
 */
export function phoneVariants(sanitized: string): string[] {
  if (!sanitized) return []
  const seen = new Set<string>()
  const push = (v: string) => {
    if (v && !seen.has(v)) seen.add(v)
  }

  // 1. Original
  push(sanitized)

  // 2. Insert a 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (!rest.startsWith('0')) {
      push(cc + '0' + rest)
    }
  }

  // 3. Remove a leading 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen + 1) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (rest.startsWith('0')) {
      push(cc + rest.slice(1))
    }
  }

  return [...seen]
}

/**
 * Returns true when the Meta API error indicates the recipient
 * phone number isn't in the allowed list (sandbox restriction).
 * Detected via error code 131030 or the standard error text.
 */
export function isRecipientNotAllowedError(message: string): boolean {
  return /131030|not in allowed list|not in the allowed list/i.test(message)
}

/**
 * Placeholder values that older rows and webhook defaults are known to carry.
 *
 * `contacts.phone` is `NOT NULL` (migration 001), so a contact whose sender
 * never disclosed a number cannot store null — the webhook writes the literal
 * string `'unknown'` instead. Every reader must therefore treat it as the
 * absence of a value, never as a phone number.
 *
 * The phone path already rejects these structurally (`isDialablePhone` only
 * admits digits and punctuation), but the identifier paths do not: `'unknown'`
 * is an all-letter string that would sail past a naive shape check.
 */
export function isPlaceholderValue(value: string | null | undefined): boolean {
  if (!value) return true
  return /^(unknown|null|undefined|none|n\/?a)$/i.test(value.trim())
}

/** Canonical form of a public handle: leading '@', no duplicate '@'. */
export function normalizeUsername(value: string | null | undefined): string | null {
  if (!value) return null
  if (isPlaceholderValue(value)) return null
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
 * True when a contact carries a PUBLIC user handle — the only kind of
 * contact the automatic follow-up system is allowed to message.
 *
 * The operator signals "handle contact" in three ways:
 *   1. `username` holds the canonical handle (`'@anaruiz'`), which the
 *      inbound webhook writes from Meta's `profile.username`;
 *   2. `phone` (legacy) still holds a bare handle (`'@tienda'`) — migration
 *      051 moves those into `username`, but an un-migrated row may carry
 *      one;
 *   3. `wa_id` / `wa_user_id` / `recipient_id` is a Meta display id tagged
 *      with its routing suffix (`'1486998326437295@user'`, `'…@lid'`),
 *      which is the delivery form of a user-scoped contact.
 *
 * Anything else — a dialable number, a bare BSUID, a placeholder like
 * `'unknown'` — has NO public handle, so automation must not target it.
 * Deliberately conservative: the caller treats a `false` as "do not send".
 */
export function hasPublicUserHandle(contact: {
  username?: string | null
  phone?: string | null
  wa_id?: string | null
  wa_user_id?: string | null
  recipient_id?: string | null
}): boolean {
  if (normalizeUsername(contact.username)) return true
  if (normalizeUsername(contact.phone)) return true
  return [contact.wa_id, contact.wa_user_id, contact.recipient_id].some(
    (value) => typeof value === 'string' && /@(user|lid)\b/i.test(value),
  )
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
export function passthroughMetaId(
  value: string | null | undefined,
): string | null {
  if (!value) return null
  if (isPlaceholderValue(value)) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  // Namespaced id — keep the prefix and dot intact.
  if (/^[A-Za-z]+\.[\w.-]+$/.test(trimmed)) return trimmed
  // Bare digit run. The 6-digit floor keeps a stray fragment from being
  // mistaken for an id; there is no upper bound because a BSUID/LID is
  // routinely far longer than E.164.
  if (/^\+?\d{6,}$/.test(trimmed)) return trimmed.replace(/\D/g, '')
  return null
}

/**
 * The address forms to try for one recipient, in order.
 *
 * A dialable number is sanitized and expanded into its trunk-prefix variants
 * (the sandbox's `#131030` quirk). An opaque Meta identifier — a BSUID, a
 * `WAID.`/`LID.` id, or an `@handle` — has exactly ONE form and must be
 * forwarded byte-for-byte.
 *
 * This mirrors the decision in the Inbox send core (`send-message.ts`).
 * Having it here as a tested function is what keeps the two from drifting:
 * the broadcast sender once gated on `isValidE164(sanitizePhoneForMeta(x))`
 * and so rejected every opaque id, while the Inbox delivered to the same
 * contacts fine. Worse, judging the SANITIZED value meant `CO.1008477715690681`
 * was assessed as `1008477715690681` and `@user1234567` as `1234567` — a
 * well-formed 7-digit number that passed the gate and would have aimed a
 * campaign at a stranger.
 *
 * An empty/blank address yields `[]`: there is nothing to send to, and that
 * is the ONLY condition under which a recipient is undeliverable.
 */
export function recipientAddressVariants(address: string | null | undefined): string[] {
  const trimmed = (address ?? '').trim()
  if (!trimmed) return []
  return isDialablePhone(trimmed)
    ? phoneVariants(sanitizePhoneForMeta(trimmed))
    : [trimmed]
}
