/**
 * Sanitize phone number for Meta WhatsApp API.
 * Meta requires digits only — no + prefix, no spaces, no dashes.
 * e.g. "+370 63949836" → "37063949836"
 */
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
