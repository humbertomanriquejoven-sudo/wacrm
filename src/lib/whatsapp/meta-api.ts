/**
 * Meta WhatsApp Cloud API helpers.
 *
 * Every function takes a single options object (named parameters) instead
 * of positional arguments. This was a deliberate choice after the same
 * swapped-args bug was found four times in a row with the positional form
 * (e.g. `(accessToken, phoneNumberId)` vs `(phoneNumberId, accessToken)`).
 * With named params, a typo surfaces immediately as a TypeScript error
 * instead of a runtime rejection from Meta.
 */

import {
  isBsuid,
  isDialablePhone,
  isOpaqueWaId,
  isPlaceholderValue,
  isValidE164,
  normalizePhone,
} from './phone-utils'

const META_API_VERSION = 'v26.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

/**
 * Our business number (the SENDER), resolved to a value safe to put in a Graph
 * URL. Never returns the empty string or the `'unknown'` placeholder.
 *
 * `whatsapp_config.phone_number_id` is the first choice. When a row is missing
 * it — or holds the literal `'unknown'` that older webhook writes produced —
 * the process env is the mandatory fallback (`WHATSAPP_PHONE_NUMBER_ID`, then
 * `META_PHONE_NUMBER_ID`), so a background timer / worker / server that did
 * not load the DB row can still address the number it was launched with.
 */
export function resolveMetaPhoneNumberId(
  value: string | null | undefined,
): string {
  const candidates = [
    value,
    process.env.WHATSAPP_PHONE_NUMBER_ID,
    process.env.META_PHONE_NUMBER_ID,
  ]
  for (const candidate of candidates) {
    const id = (candidate ?? '').trim()
    if (id && !isPlaceholderValue(id)) return id
  }
  return ''
}

/**
 * Resolve the sender `phone_number_id` or refuse to build the URL.
 *
 * A Graph request to `/{unknown}/messages` can never be delivered and Meta
 * answers with an opaque error, so this throws a typed error BEFORE any HTTP
 * call. This is the single choke point that guarantees NO request is ever sent
 * to a path containing `/unknown/`.
 */
export function requireMetaPhoneNumberId(
  value: string | null | undefined,
): string {
  const id = resolveMetaPhoneNumberId(value)
  if (!id) {
    console.error(
      '[send] MISSING CREDENTIAL: phone_number_id resolved to ""/"unknown" and neither WHATSAPP_PHONE_NUMBER_ID nor META_PHONE_NUMBER_ID is set. Refusing to POST to /unknown/messages — no HTTP request was sent.',
    )
    throw new InvalidRecipientError(
      '',
      'phone_number_id is missing or "unknown", and no fallback env ' +
        '(WHATSAPP_PHONE_NUMBER_ID / META_PHONE_NUMBER_ID) is set. No HTTP request was sent.',
    )
  }
  return id
}

/** Graph URL for a message send, with the sender id guaranteed valid. */
function messagesUrl(phoneNumberId: string | null | undefined): string {
  return `${META_API_BASE}/${requireMetaPhoneNumberId(phoneNumberId)}/messages`
}

export interface MetaSendResult {
  messageId: string
}

export interface MetaPhoneInfo {
  id: string
  display_phone_number: string
  verified_name?: string
  quality_rating?: string
}

interface MetaErrorResponse {
  error?: {
    message?: string
    code?: number
    type?: string
    /** Sub-code carries the finer-grained reason (e.g. which parameter). */
    error_subcode?: number
    error_data?: { messaging_product?: string; details?: string }
  }
}

/**
 * A Meta API failure enriched with the details a recipient-resolution
 * retry needs: the HTTP status, Meta's numeric error code, and whether
 * the complaint was specifically about the `to` field.
 *
 * Meta's "invalid recipient" surfaces as HTTP 400 with code 131009
 * ("Recipient phone number not in allowed list"), 131026 ("Message
 * undeliverable") or 131047 ("Re-engagement message"), and the message
 * text varies by locale and surface. Matching on the numeric codes plus a
 * text probe is the only reliable way to tell "wrong address" apart from
 * "bad template", since a template error must NOT trigger a resend to a
 * different recipient.
 */
export class MetaApiError extends Error {
  readonly status: number
  readonly code: number | null
  readonly subcode: number | null
  readonly recipientInvalid: boolean
  /** The verbatim response body Meta returned ('' when none could be read). */
  readonly rawBody: string | null

  constructor(
    message: string,
    opts: {
      status: number
      code?: number | null
      subcode?: number | null
      rawBody?: string | null
    },
  ) {
    super(message)
    this.name = 'MetaApiError'
    this.status = opts.status
    this.code = opts.code ?? null
    this.subcode = opts.subcode ?? null
    this.rawBody = opts.rawBody ?? null
    this.recipientInvalid = MetaApiError.isRecipientComplaint(
      this.status,
      this.code,
      message,
    )
  }

  /** Meta error codes that specifically mean "this address is wrong". */
  private static readonly RECIPIENT_CODES = new Set([
    131009, // Recipient phone number not in allowed list
    131026, // Message undeliverable
    131047, // Re-engagement message
    131051, // Unsupported message type (wrong destination shape)
  ])

  static isRecipientComplaint(
    status: number,
    code: number | null,
    message: string,
  ): boolean {
    if (code !== null && MetaApiError.RECIPIENT_CODES.has(code)) return true
    if (status === 404) return true
    // Text probe for codes we don't know about. Scoped to recipient-ish
    // wording so unrelated 400s (template issues, ad account problems)
    // don't get mistaken for an addressable failure.
    return /invalid\s+(recipient|phone|number)|not\s+in\s+allowed\s+list|undeliverable|recipient/i.test(
      message,
    )
  }
}

/**
 * The address we were asked to deliver to is not a phone number we can dial.
 *
 * Thrown BEFORE any HTTP request leaves the process. A BSUID (or a public
 * @handle, or the literal placeholder `unknown`) placed in `to` does not
 * reliably fail: Meta has been observed to answer 200 and drop the message,
 * which is indistinguishable from a successful send in the app. Refusing to
 * make the call at all turns that silent loss into a typed error the senders
 * can act on — they park the reply and flag the conversation as needing a
 * real number.
 *
 * `recipientInvalid` is deliberately true: this IS "Meta rejected the
 * recipient", just detected locally instead of over the wire, so the
 * existing `isRecipientRejection` retry/park machinery handles it with no
 * special case. That flag is derived from the message text by
 * `MetaApiError`'s constructor, so the wording below must keep the
 * `invalid recipient` phrasing.
 */
export class InvalidRecipientError extends MetaApiError {
  /** The rejected address, verbatim, for the caller's logs. */
  readonly address: string
  /**
   * Why the address was refused. Drives the operator-facing half of the
   * message — the distinction that matters in production is "this contact
   * has no usable identity at all" versus "this contact is reachable, but
   * only by quoting the message they sent, and the caller didn't pass the
   * inbound wamid".
   */
  readonly reason: string

  constructor(address: string, reason?: string) {
    super(
      `invalid recipient "${address}": ${
        reason ??
        'expected a phone number, a BSUID (e.g. \'CO.<numeric_id>\') ' +
          'or a WhatsApp username, but got an empty or unusable value. ' +
          'No HTTP request was sent.'
      }`,
      // status 0 / no code: nothing came back from Meta, so there is no HTTP
      // status to report.
      { status: 0, code: null, subcode: null },
    )
    this.name = 'InvalidRecipientError'
    this.address = address
    this.reason = reason ?? 'unusable value'
  }
}

/**
 * Pre-flight gate every send helper runs before touching the network.
 *
 * Everything Meta can RECEIVE a message for is returned normalized:
 *   CASO A — a real E.164 number ('573044556788') → digits-only `to`.
 *   CASO B — a numeric opaque wa_id ('1486998326437295'), the canonical id a
 *            privacy-shielded sender's inbound `from` carries → digits in `to`
 *            (the caller MUST attach `context.message_id`).
 *   CASO C — a namespaced BSUID / user id (`CO.…`/`WAID.…`/`LID.…`) → the
 *            value is returned INTACT (prefix preserved) so the payload
 *            builder routes it to Meta's `recipient` field and omits `to`.
 * An `@handle` and a letter-only value are identity/display data and are
 * REFUSED: Meta answers (#100) Invalid parameter.
 */
function assertDialableRecipient(address: string): string {
  const value = (address ?? '').trim()
  if (!value) {
    console.warn('[send] blocked: empty recipient, no HTTP request was made to Meta.')
    throw new InvalidRecipientError(value)
  }
  // `contacts.phone` is NOT NULL, so the webhook stores the literal string
  // 'unknown' for a sender that disclosed no number. Sending THAT to Meta
  // is forbidden: the request would carry `to: "unknown"`, which Meta either
  // answers with an opaque (#100) or — worse — accepts with a 200 and
  // silently drops. The deliverable destination for such a contact is the
  // numeric `wa_id` the webhook persisted (see the recipient ladder in
  // `resolveRecipient`), so failing here with a typed
  // `InvalidRecipientError` (recipientInvalid = true) routes the failure
  // into the existing retry/park machinery instead of losing the message.
  if (isPlaceholderValue(value)) {
    console.warn(
      '[send] blocked: recipient is the placeholder "unknown" — send to the contact\'s stored wa_id / recipient_id instead. No HTTP request was made to Meta.',
    )
    throw new InvalidRecipientError(
      value,
      'phone holds the placeholder value "unknown": use the wa_id / ' +
        'recipient_id Meta recorded for this contact as the destination. ' +
        'No HTTP request was sent.',
    )
  }
  // A '@'-prefixed handle is display data: the destination Meta expects
  // is the bare numeric id, so strip the prefix rather than sending the
  // human-facing form.
  const bare = value.startsWith('@') ? value.slice(1).trim() : value
  if (!bare) {
    console.warn('[send] blocked: "@"-only recipient, no HTTP request made.')
    throw new InvalidRecipientError(value)
  }
  // CASO C — a namespaced BSUID (`CO.…`/`WAID.…`/`LID.…`) is a real,
  // deliverable destination, but NOT in `to`: per the official Cloud API a
  // BSUID travels in `recipient` (and `to` is omitted). Keep the prefix and
  // the value byte-for-byte; the field builder routes it.
  if (isBsuid(bare)) return bare
  if (isDialablePhone(bare)) {
    const digits = normalizePhone(bare)
    if (isValidE164(digits)) return digits
  }
  // CASO B — a numeric opaque wa_id is deliverable in `to` (with a context
  // anchor); a short digit run out of an `@lid` id is the same shape.
  if (isOpaqueWaId(bare)) return bare.replace(/[^\d+]/g, '')
  // Letters survive normalization: a bare `@handle` (or garbage). Refuse.
  throw new InvalidRecipientError(value, USERNAME_HANDLE_REFUSED)
}

/**
 * The address field(s) for one recipient, routed by the value's shape:
 * a dialable phone or a numeric opaque wa_id → `{ to }`; a namespaced BSUID /
 * user id → `{ recipient }` (with `to` omitted); an `@handle` →
 * `InvalidRecipientError`.
 */
function recipientFields(address: string): Record<string, string> {
  const bare = address.startsWith('@') ? address.slice(1).trim() : address
  return canonicalToField(bare)
}

/**
 * The address field Meta expects for one recipient:
 *
 *   A. a dialable E.164 number → stripped to digits, sent as `to`;
 *   B. a numeric opaque wa_id (`messages[0].from` for a privacy-shielded
 *      sender; also a short digit run out of an `@lid` id) → sent as `to`;
 *   C. a namespaced BSUID / user id (`CO.…`/`WAID.…`/`LID.…`) → sent as
 *      `recipient` (the official Cloud API field), with `to` omitted.
 */
export function recipientAddressField(destination: string): Record<string, string> {
  return canonicalToField(destination)
}

/**
 * The address field for a send: TEMPLATE, MEDIA, interactive, reaction and
 * text messages all share ONE canonical routing.
 *
 * CASO A — a real E.164 number travels in `to` (the numeric id with any
 * formatting removed, which is what `toMetaTargetId` produces).
 *
 * CASO B — a numeric opaque wa_id also travels in `to`: it is the canonical
 * id Meta itself used as the inbound `from`, so it is the one address most
 * likely to be accepted back. It is deliverable ONLY as a reply that QUOTES
 * one of the owner's own messages (the `context.message_id` anchor) — callers
 * resolve it from the thread; sent cold Meta answers (#131009) and drops.
 *
 * CASO C — a namespaced BSUID / user id (`CO.…`/`WAID.…`/`LID.…`) travels in
 * Meta's `recipient` field, with `recipient_type: "individual"` and `to`
 * OMITTED. Meta's `to` parameter is EXCLUSIVE to E.164 phone numbers: a BSUID
 * in `to` returns (#131009) "Parameter value is not valid". An `@handle` is
 * display data and is REFUSED with a typed `InvalidRecipientError`.
 *
 * Returns `{ to: '' }` for an empty address and for the placeholder
 * `contacts.phone` is NOT NULL forces the webhook to write ('unknown') —
 * both are undeliverable, and failing identically here lets the caller
 * raise a typed `InvalidRecipientError` instead of sending Meta a request
 * that reads like a malformed API call.
 */
export function canonicalToField(destination: string): Record<string, string> {
  const bare = cleanRecipientAddress(destination);
  if (!bare) return { to: '' };
  if (isPlaceholderValue(bare)) return { to: '' };
  // CASO C — a namespaced BSUID / user id goes in `recipient`, NEVER `to`.
  // The fields are mutually exclusive: `to` is omitted entirely.
  if (isBsuid(bare)) return { recipient: bare };
  if (!isDialablePhone(bare) && !isOpaqueWaId(bare)) {
    // Letter-only handes / garbage: `toMetaTargetId` would reduce
    // `jjuanpablo22222` to `22222` — a number invented from a display name,
    // aimed at whoever owns it. Never.
    throw new InvalidRecipientError(bare, USERNAME_HANDLE_REFUSED);
  }
  // CASO A (a real E.164 number, any formatting) and CASO B (a bare numeric
  // opaque wa_id) both travel in `to` as digits.
  const to = toMetaTargetId(bare);
  assertDeliverableDestination(to);
  return { to };
}

/**
 * Template-flavoured name for {@link canonicalToField}, kept for existing
 * callers and tests. Templates and media share one canonical routing:
 * CASO A (E.164) and CASO B (numeric wa_id) travel in `to`, and CASO C
 * (BSUID) travels in `recipient`; a handle is refused everywhere.
 */
export function templateRecipientField(destination: string): Record<string, string> {
  return canonicalToField(destination);
}

/**
 * True when `address` is a deliverable OPAQUE wa_id — a bare digit run that
 * is NOT a dialable E.164 number (16-digit privacy-shielded wa_ids, short
 * `@lid` digit runs). These travel in Meta's `to` (CASO B), but ONLY as a
 * reply that QUOTES one of the owner's own messages — the caller must attach
 * a `context.message_id` anchor.
 *
 * A namespaced BSUID (`CO.…`/`WAID.…`/`LID.…`) is NOT an opaque wa_id: it is
 * a separate destination shape (CASO C) that travels in Meta's `recipient`
 * field. An `@handle` is display data and is refused.
 */
export function isOpaqueMetaId(address: string): boolean {
  return isOpaqueWaId(address)
}

/**
 * Reduce any stored identifier to the bare numeric id Meta accepts in `to`.
 *
 *   '573044556788'                 -> '573044556788'  (already a number)
 *   '1486998326437295'             -> '1486998326437295'
 *   '123456@lid'                   -> '123456'
 *
 * An `@user` / `@lid` routing suffix is a labelling artefact, not part of
 * the address; the digits underneath are the id Meta actually issued.
 * Namespaced BSUIDs (`CO.`/`WAID.`/`LID.`) are REFUSED by the caller before
 * they ever reach this (CASO C), so nothing is invented here — if the value
 * has no digits at all the non-digit remainder is returned so the request
 * still goes out and Meta can judge it, rather than failing locally on a
 * contact we know exists.
 */
export function toMetaTargetId(address: string): string {
  const cleaned = cleanRecipientAddress(address)
  if (!cleaned) return ''
  const digits = cleaned.replace(/\D/g, '')
  if (digits) return digits
  // No digits (a bare handle): keep the letters so the shape is at least
  // well-formed and Meta's own error explains what it disliked.
  return cleaned
}

/**
 * Normalize an inbound display id (`@user`, `@lid`, `123456@lid`, …) down
 * to what Meta expects in `to`.
 *
 * WhatsApp hands us display ids whose `@user` / `@lid` suffix is a routing
 * label, not part of the address. Stripping it leaves either a real number
 * or a bare opaque id. Letters are NOT stripped from namespaced ids
 * (`CO.1008…`): running those through a digits-only filter would fabricate
 * a phone number out of them and send the reply to a stranger.
 */
export function cleanRecipientAddress(address: string): string {
  const value = (address ?? '').trim()
  if (!value) return ''
  // Drop a trailing/embedded `@user` / `@lid` routing suffix.
  const unsuffixed = value.replace(/@(lid|user|c.us)\b/gi, '').trim()
  const bare = unsuffixed.startsWith('@') ? unsuffixed.slice(1).trim() : unsuffixed
  return bare
}

/** ESCENARIO C copy — a `@username` is NEVER a deliverable destination. */
const USERNAME_HANDLE_REFUSED =
  'un @username (handle) nunca es un destinatario válido: WhatsApp no ' +
  'entrega a "@usuario" ni a identificadores con letras sin dígitos en `to` ' +
  '(ESCENARIO C). Usa un número E.164 real (CASO A) o el wa_id/recipient_id ' +
  'numérico de este contacto (CASO B). No se envió ninguna petición HTTP a ' +
  'Meta.';

/**
 * Final guard — refuses a display value (an `@handle`, a letter-only run like
 * `acme.store` / `tienda`) that is not an address at all. The deliverable
 * shapes are a numeric id (in `to`) and a namespaced BSUID / user id with a
 * numeric payload (in `recipient`); both are admitted here.
 */
function assertDeliverableDestination(fieldValue: string): void {
  const value = (fieldValue ?? '').trim()
  if (!value) return // empty is the caller's `{ to: '' }` signal
  const numeric = /^\d+$/.test(value)
  const namespaced = /^[A-Za-z]+\.[\w.-]*\d[\w.-]*$/.test(value)
  if (numeric || namespaced) return
  throw new InvalidRecipientError(value, USERNAME_HANDLE_REFUSED)
}

async function throwMetaError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  let code: number | null = null
  let subcode: number | null = null

  // Read the body ONCE as text so the exact payload Meta returned is logged
  // before it is parsed. `response.json()` consumes the stream, so logging
  // after a json() read would throw; text() + JSON.parse keeps both the raw
  // diagnostic and the structured error fields. Every send helper funnels
  // its non-2xx responses through here, so a BSUID/recipient rejection is
  // never swallowed without the verbatim cause reaching the console.
  let raw = ''
  try {
    raw = typeof response.text === 'function' ? await response.text() : ''
  } catch {
    raw = ''
  }
  console.error(
    `[Meta API] HTTP ${response.status} — ${fallback}`,
    raw || '(empty response body)',
  )
  // Producción (Easypanel): el cuerpo de la respuesta que Meta devolvió con
  // error, verbatim, bajo una etiqueta estable que se puede filtrar.
  console.error('[META_API_ERROR]', raw || '(empty response body)')

  let data: MetaErrorResponse = {}
  if (raw) {
    try {
      data = JSON.parse(raw) as MetaErrorResponse
    } catch {
      // response body wasn't JSON - keep the fallback
    }
  } else {
    // No text body available (e.g. a partial mock) - fall back to json().
    try {
      data = (await response.json()) as MetaErrorResponse
    } catch {
      // keep the fallback
    }
  }
  // Verbatim error envelope on the console, twice, under fixed tags:
  //   * `META_API_SEND_ERROR` — the raw body as one JSON string.
  //   * `META_API_REJECTED`   — the same body plus the HTTP status and the
  //     endpoint, so a failure is diagnosable from EasyPanel logs alone.
  // The earlier `[Meta API] HTTP…` line prints the body as text; these make it
  // greppable and copy-pasteable into Meta's debugger.
  console.error('META_API_SEND_ERROR:', JSON.stringify(data))
  console.error(
    'META_API_REJECTED:',
    JSON.stringify({
      status: response.status,
      endpoint: `${META_API_BASE}/${(fallback.match(/\d{6,}/) ?? ['unknown'])[0]}/messages`,
      response: data,
    }),
  )

  if (data.error?.message) message = data.error.message
  if (typeof data.error?.code === 'number') code = data.error.code
  if (typeof data.error?.error_subcode === 'number') {
    subcode = data.error.error_subcode
  }
  throw new MetaApiError(message, {
    status: response.status,
    code,
    subcode,
    rawBody: raw,
  })
}

// ============================================================
// Phone number / account
// ============================================================

export interface VerifyPhoneNumberArgs {
  phoneNumberId: string
  accessToken: string
}

/**
 * Verify a Meta phone number ID by fetching its public metadata
 * (display_phone_number, verified_name, quality_rating).
 */
export async function verifyPhoneNumber(
  args: VerifyPhoneNumberArgs
): Promise<MetaPhoneInfo> {
  const { phoneNumberId, accessToken } = args
  const url = `${META_API_BASE}/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  return response.json()
}

// ============================================================
// Cloud API registration (subscription for inbound webhooks)
// ============================================================
//
// Saving a phone_number_id + access_token to whatsapp_config is NOT
// enough to receive inbound events from Meta. Two extra calls are
// required:
//
//   POST /{phone_number_id}/register
//     Subscribes the number for THIS app's webhook. Requires a
//     6-digit 2FA PIN the user previously set in Meta WhatsApp
//     Manager → Two-step verification. Without /register, inbound
//     events are routed to whichever app last claimed the number
//     (often the one that did Embedded Signup) — so a second user
//     adding a second number under the same WABA silently loses
//     every inbound message.
//
//   POST /{waba_id}/subscribed_apps
//     Subscribes the WABA itself to this app. Required exactly
//     once per WABA, but idempotent so calling on every save is
//     safe and cheap.
//
// Both calls are no-ops when already done — Meta returns success +
// the helpers below treat that as success.

export interface RegisterPhoneNumberArgs {
  phoneNumberId: string
  accessToken: string
  /**
   * 6-digit PIN the user set in Meta WhatsApp Manager →
   * Two-step verification. If 2FA is not enabled on the number,
   * Meta rejects /register with a clear error and the user is
   * pointed at the right setting in the UI.
   */
  pin: string
}

export interface RegisterPhoneNumberResult {
  success: boolean
  /**
   * True when Meta indicated the number was already registered to
   * THIS app — same outcome as a fresh registration from the
   * caller's POV, surfaced separately for logging clarity.
   */
  alreadyRegistered: boolean
}

/**
 * Register a phone number for inbound webhook events.
 *
 * Errors that should be surfaced verbatim to the user:
 *   * Missing / wrong PIN  → "Two-step verification PIN required..."
 *   * No 2FA enabled       → "Two-factor authentication is not on..."
 *   * Number on other app  → "Number is registered to another app..."
 */
export async function registerPhoneNumber(
  args: RegisterPhoneNumberArgs
): Promise<RegisterPhoneNumberResult> {
  const { phoneNumberId, accessToken, pin } = args
  const url = `${META_API_BASE}/${phoneNumberId}/register`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  })

  if (response.ok) {
    return { success: true, alreadyRegistered: false }
  }

  // Meta returns an error envelope with a code. Code 133005 + the
  // text "already registered" appears when the number is already
  // subscribed to this app — that's success from the caller's
  // perspective, surface it as such.
  let data: { error?: { message?: string; code?: number; error_subcode?: number } } = {}
  try {
    data = await response.json()
  } catch {
    /* keep empty */
  }
  const message = data.error?.message ?? `Meta API error: ${response.status}`
  if (/already.*registered/i.test(message)) {
    return { success: true, alreadyRegistered: true }
  }
  throw new Error(message)
}

export interface SubscribeWabaToAppArgs {
  wabaId: string
  accessToken: string
}

/**
 * Subscribe the WABA to this Meta app's webhook. Idempotent — Meta
 * returns success even when the subscription already exists.
 */
export async function subscribeWabaToApp(
  args: SubscribeWabaToAppArgs
): Promise<void> {
  const { wabaId, accessToken } = args
  const url = `${META_API_BASE}/${wabaId}/subscribed_apps`
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
}

export interface GetSubscribedAppsArgs {
  wabaId: string
  accessToken: string
}

export interface SubscribedApp {
  whatsapp_business_api_data?: {
    id?: string
    name?: string
    link?: string
  }
}

/**
 * Diagnostic — fetch the list of apps currently subscribed to this
 * WABA. The UI uses this to confirm OUR app is in the list when
 * the user clicks Verify Registration.
 */
export async function getSubscribedApps(
  args: GetSubscribedAppsArgs
): Promise<SubscribedApp[]> {
  const { wabaId, accessToken } = args
  const url = `${META_API_BASE}/${wabaId}/subscribed_apps`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = (await response.json()) as { data?: SubscribedApp[] }
  return data.data ?? []
}

// ============================================================
// Sending
// ============================================================

/**
 * POST a WhatsApp message payload to `/{phone_number_id}/messages`.
 *
 * Production diagnostics (Easypanel): the EXACT JSON that leaves the process
 * is printed immediately before the fetch under a stable tag, and every
 * non-OK Meta response body is logged (echoed by `throwMetaError` under
 * `META_API_ERROR`). Both make a delivery failure diagnosable from the
 * deployment logs alone — including a recepient rejection that produced a
 * 200-but-dropped message (no response body to log) vs. a literal 4xx with a
 * body to read.
 */
async function postMessagesPayload(
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  console.log('===> [DEBUG META PAYLOAD] TO:', body.to, 'TYPE:', typeof body.to)
  console.log('[META_PAYLOAD_ENVIADO]', JSON.stringify(body, null, 2))
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
}

export interface SendTextMessageArgs {
  phoneNumberId: string
  accessToken: string
  to?: string
  recipient?: string
  text: string
  /** Meta's message_id of the message being replied to. Adds a `context` field
   *  so WhatsApp renders the new message as a reply with a quote preview. */
  contextMessageId?: string
  /**
   * Which Meta field carries the destination. Defaults to `to` — the only
   * documented field for a phone number AND for a numeric wa_id under the
   * CASO A/B/C engine. `recipientField: 'recipient'` exists only as an
   * explicit legacy RETRY: if Meta rejects the `to` form, a caller may
   * re-send with the id intact in `recipient` rather than lose the message.
   * A namespaced BSUID is routed to `recipient` automatically; a handle is
   * refused before either field is built.
   */
  recipientField?: 'to' | 'recipient'
}

/**
 * Send a free-form WhatsApp text message.
 * Only works inside the 24-hour customer service window.
 *
 * Three destination classes decide the payload:
 *
 *   1. A dialable E.164 number → `{ to: "573044556788" }`. No anchor needed:
 *      Meta addresses the number on its own (CASO A).
 *   2. A numeric opaque wa_id (a >14-digit privacy-shielded id, or a short
 *      digit run out of `@lid`) → the digits in `to` WITH
 *      `context.message_id` MANDATORY (CASO B). Sent as a cold destination
 *      such a request has been observed in production to come back as
 *      (#131009) "Recipient phone number not in allowed list" while the
 *      message is dropped — Meta accepts an opaque id only as a REPLY to a
 *      message that person wrote. Every caller therefore anchors the send to
 *      the conversation's newest customer wamid (`latestInboundAnchorId`),
 *      and an opaque destination that arrives WITHOUT an anchor is refused
 *      here, before any HTTP request.
 *   3. A namespaced BSUID / user id (`CO.…`/`WAID.…`/`LID.…`) → Meta's
 *      `recipient` field, with `recipient_type: "individual"` and `to`
 *      OMITTED. `to` is EXCLUSIVE to E.164 numbers: a BSUID there returns
 *      (#131009). No `context` anchor is required for the `recipient` form.
 *
 * Refused locally: an EMPTY address, the `unknown` placeholder, a numeric
 * opaque destination without a `contextMessageId` (the #131009 guard), and
 * ANY `@handle`. A bare `@username` can never be rescued by quoting (Meta
 * answers (#100) Invalid parameter for a handle whether or not `context` is
 * present), so it is refused here before any HTTP request and the senders
 * surface a typed 422 in place of a doomed probe.
 */
export async function sendTextMessage(
  args: SendTextMessageArgs
): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, text, contextMessageId } = args

  // CREDENTIAL AUDIT — runs for EVERY send path (manual, bot, worker
  // timers). A missing WABA credential must never be lost as a confusing
  // network 4xx from Meta (or worse, a latently misconfigured env that
  // "looks" healthy): name the exact variable and refuse loudly BEFORE any
  // HTTP request, so a background timer cannot silently never deliver.
  //
  // `requireMetaPhoneNumberId` also applies the env fallback and refuses the
  // `'unknown'` placeholder, so the request can never target /unknown/messages.
  requireMetaPhoneNumberId(phoneNumberId)
  if (!accessToken || !accessToken.trim()) {
    console.error(
      '[send] MISSING CREDENTIAL: META_ACCESS_TOKEN (or WHATSAPP_TOKEN) resolved to an empty value — no HTTP request was sent. Check the env of the process running this task (cron / worker / Next server).',
    )
    throw new InvalidRecipientError(
      '',
      'accessToken resolved to an empty value (META_ACCESS_TOKEN / WHATSAPP_TOKEN is missing in this process). No HTTP request was sent.',
    )
  }

  const recipient = cleanRecipientAddress(to ?? '')
  const address = recipient || (to ?? '').trim()
  if (!address) {
    // The ONE case that is still refused locally: there is no address at all
    // to put in the request. An empty `to` is a guaranteed 400 with no
    // possible delivery, so failing here only converts a certain error into
    // a certain error.
    throw new InvalidRecipientError(
      '',
      'no destination is available for this contact: `phone`, `wa_id`, ' +
        '`wa_user_id` and `recipient_id` are all empty or "unknown". ' +
        'No HTTP request was sent.',
    )
  }
  // The second refusal: the destination IS the webhook's 'unknown'
  // placeholder (contacts.phone is NOT NULL, so that literal is what a
  // contact with no disclosed number holds). Forwarding it puts
  // `to: "unknown"` on the wire, which Meta has been observed to ACK with
  // 200 while dropping the message — indistinguishable from success here.
  // The address for such a contact must be the `wa_id` / `recipient_id`
  // persisted by the webhook; refusing with a typed error (recipientInvalid
  // = true) hands the senders' retry/park machinery a real cause instead of
  // a silent loss.
  if (isPlaceholderValue(address)) {
    console.warn(
      '[send] blocked: recipient is the placeholder "unknown" — send to the contact\'s stored wa_id / recipient_id instead. No HTTP request was made to Meta.',
    )
    throw new InvalidRecipientError(
      address,
      'phone holds the placeholder value "unknown": use the wa_id / ' +
        'recipient_id Meta recorded for this contact as the destination. ' +
        'No HTTP request was sent.',
    )
  }

  // #131009 guard (CASO A/B/C): a numeric opaque wa_id (CASO B) is
  // deliverable ONLY as a reply that QUOTES one of the owner's own messages,
  // so without a `contextMessageId` anchor it is refused here, before any
  // HTTP request. Callers resolve the anchor from the thread
  // (`latestInboundAnchorId` / `findInboundWamid`). A namespaced BSUID
  // (CASO C) travels in `recipient` and needs NO anchor; a phone (CASO A)
  // needs none either. A bare `@handle` is refused later by
  // `canonicalToField`.
  if (!contextMessageId && !isDialablePhone(address)) {
    console.error(
      `[send] MISSING CONTEXT (#131009 guard): opaque destination "${address}" without a contextMessageId anchor — no HTTP request was sent. CASO B requires quoting one of the customer's own messages; anchor via this conversation's newest inbound wamid.`,
    )
    throw new InvalidRecipientError(
      address,
      'CASO B: an opaque wa_id is deliverable only as a reply to one of ' +
        "the customer's own messages — no inbound wamid was supplied to " +
        'quote (#131009). No HTTP request was sent.',
    )
  }
  // CASO C — a namespaced BSUID / user id must not be placed in `to`, either
  // with or without an anchor. It must travel in Meta's `recipient` field.
  // Refuse it locally so the caller routes it through `recipientField: 'recipient'`
  // or fixes the contact's address.
  if (isBsuid(address)) {
    console.error(
      '[send] blocked: namespaced BSUID in "to" field — ' +
        'BSUID must travel in Meta\'s `recipient` field, not `to`. ' +
        'No HTTP request was sent to Meta.',
    )
    throw new InvalidRecipientError(
      address,
      'namespaced BSUID (e.g. \'CO.<id>\') must be sent in the ' +
        '`recipient` field, not `to`. No HTTP request was sent.',
    )
  }

  // Destination field, routed by shape: a phone (CASO A) or numeric opaque
  // wa_id (CASO B) travels in `to`; a namespaced BSUID (CASO C) travels in
  // `recipient` with `to` omitted. `canonicalToField` refuses an `@handle`.
  // The `recipientField` override is kept only as an explicit legacy retry
  // hatch (automations) — the guards above already refused anything
  // undeliverable.
  const addressField: Record<string, string> =
    args.recipientField === 'recipient'
      ? // Explicit override: send the address in `recipient` instead of `to`.
        { recipient: address }
      : canonicalToField(address)
  const targetId = addressField.to || addressField.recipient || address
  if (!targetId) {
    // `canonicalToField` yields `{ to: '' }` only for an empty address or the
    // `unknown` placeholder — both refused above, so this is the guard that
    // keeps an empty destination off the wire.
    throw new InvalidRecipientError(
      address,
      'no destination is available for this contact after normalization. No HTTP request was sent.',
    )
  }
  assertDeliverableDestination(targetId)

  const url = messagesUrl(phoneNumberId)
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    // `addressField` carries the destination: an E.164 number or a numeric
    // opaque wa_id in `to`. A `context` quote is attached when one is
    // available and is MANDATORY for the opaque wa_id (CASO B) — the guard
    // above refuses an opaque destination without an anchor, so `context`
    // is present exactly when the destination needs it. A bare `@handle` is
    // refused before this point (ESCENARIO C).
    ...addressField,
    type: 'text',
    text: { preview_url: false, body: text },
  }
  if (contextMessageId) {
    body.context = { message_id: contextMessageId }
  }
  const response = await postMessagesPayload(url, accessToken, body)
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  // Per-attempt delivery log: the exact `to` field that reached Meta (the
  // same E.164/numeric target a manual or bot send uses), the HTTP status
  // and the wamid Meta assigned. Errors are logged verbatim by
  // `throwMetaError` (META_API_SEND_ERROR / META_API_REJECTED) above.
  console.log(
    `[OUTBOUND WHATSAPP] delivered to=${targetId} status=${response.status} wamid=${data.messages?.[0]?.id}`,
    data,
  )
  return { messageId: data.messages[0].id }
}

export type MediaKind = 'image' | 'video' | 'document' | 'audio'

export interface SendMediaMessageArgs {
  phoneNumberId: string
  accessToken: string
  to?: string
  recipient?: string
  kind: MediaKind
  /** Public URL Meta fetches at send time. */
  link: string
  /** Optional caption — Meta caps at 1024 chars. Documents + images + videos accept it; audio does NOT. */
  caption?: string
  /** Document-only. Shown in the recipient's chat as the file name. Ignored for image/video/audio. */
  filename?: string
  contextMessageId?: string
}

/**
 * Send an image, video, document, or audio (voice note) via a public URL.
 *
 * Used by the Flows engine's `send_media` node and the inbox composer's
 * agent-initiated media sends. Mirrors `sendTextMessage` — single fetch,
 * throws on non-2xx, returns Meta's message id.
 *
 * The destination is built by the SAME resolver chain as every other
 * outbound path (`resolveRecipient` upstream, then {@link canonicalToField}
 * here), so a contact identified only by an opaque wa_id is addressed
 * exactly as its text messages are: the `@user` / `@lid` routing suffix is
 * stripped and the numeric id lands in `to`.
 *
 * This used to be the one divergence in the send pipeline: media routed
 * opaque ids through Meta's alternate `recipient` field while the text
 * path put the same id in `to`. Meta rejects `recipient` for this message
 * type with "(#100) Invalid parameter", which surfaced as HTTP 502 on
 * every image/attachment sent to a `@user` contact — while text to the
 * same contact worked. One canonical `to`, both paths.
 *
 * Audio is special-cased: Meta rejects `caption` and `filename` on audio
 * messages, so we send `{ link }` only. WhatsApp auto-renders an
 * OGG/Opus file as a playable voice note (waveform) rather than a file
 * attachment.
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs,
): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, kind, link, caption, filename, contextMessageId } = args
  if (!link) throw new Error('sendMediaMessage requires a link.')

  // Refuse a destination we cannot address BEFORE any network call. The
  // typed error carries the `invalid recipient` phrasing, so the senders'
  // retry/park machinery treats it as a recipient rejection and the HTTP
  // layer answers 422 instead of letting an unresolvable contact surface
  // as a generic 502. `canonicalToField` already refuses a namespaced
  // BSUID / handle (CASO C); `{ to: '' }` covers the empty/placeholder case.
  const addressField = canonicalToField(to ?? '')
  if (!addressField.to && !addressField.recipient) {
    console.warn(
      '[send] blocked: media recipient could not be resolved, no HTTP request was made to Meta.',
    )
    throw new InvalidRecipientError(
      (to ?? '').trim(),
      'no destination is available for this contact: the resolved address is ' +
        'empty or a placeholder ("unknown"). No HTTP request was sent.',
    )
  }

  const url = messagesUrl(phoneNumberId)

  // Audio accepts neither caption nor filename per Meta's spec — adding
  // either yields a 400. image/video/document accept a caption; only
  // document accepts a filename.
  const media: Record<string, unknown> = { link }
  if (caption && kind !== 'audio') media.caption = caption
  if (kind === 'document' && filename) media.filename = filename

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...addressField,
    type: kind,
    [kind]: media,
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const response = await postMessagesPayload(url, accessToken, body)
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  console.log('[OUTBOUND WHATSAPP]', data)
  return { messageId: data.messages[0].id }
}

import type { MessageTemplate } from '@/types'
import {
  buildSendComponents,
  type SendTimeParams,
} from './template-send-builder'

export interface SendTemplateMessageArgs {
  phoneNumberId: string
  accessToken: string
  to?: string
  recipient?: string
  templateName: string
  language?: string
  /**
   * Legacy body-only params. Kept for backward compat with callers
   * that haven't migrated to the structured `template` + `messageParams`
   * pair below. New callers should pass `template` so media headers
   * and URL buttons land on the send.
   */
  params?: string[]
  /**
   * The template row from message_templates. When provided, the helper
   * builds the full components array (header + body + buttons) via
   * buildSendComponents — that's the only way image/video/document
   * headers and URL-with-variable buttons actually reach the recipient.
   */
  template?: MessageTemplate
  /**
   * Structured per-send values. Body variables go in `body`; header
   * text variables in `headerText`; media overrides in
   * `headerMediaUrl` / `headerMediaId`; URL/COPY_CODE button values
   * in `buttonParams` keyed by index.
   */
  messageParams?: SendTimeParams
  /** Meta's message_id of the message being replied to. */
  contextMessageId?: string
}

/**
 * Send a pre-approved WhatsApp message template. Required outside
 * the 24-hour window and for any first-touch messaging.
 *
 * Caller paths:
 *   - Legacy: pass `params: string[]` (body only). Same behaviour as
 *     before this helper learned about media + buttons.
 *   - Structured: pass `template` (and optionally `messageParams`).
 *     The full components array is built from the row so media
 *     headers + URL buttons land correctly.
 */
export async function sendTemplateMessage(
  args: SendTemplateMessageArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    templateName,
    language = 'en_US',
    params,
    template,
    messageParams,
    contextMessageId,
} = args
  const recipient = assertDialableRecipient(to ?? '')
  const url = messagesUrl(phoneNumberId)

  const templatePayload: Record<string, unknown> = {
    name: templateName,
    language: { code: language },
  }

  if (template) {
    const components = buildSendComponents(template, {
      // Legacy callers pass body values in `params`; fold them into
      // `messageParams.body` so the new path covers them too.
      body: messageParams?.body ?? params,
      headerText: messageParams?.headerText,
      headerMediaUrl: messageParams?.headerMediaUrl,
      headerMediaId: messageParams?.headerMediaId,
      buttonParams: messageParams?.buttonParams,
    })
    if (components.length > 0) {
      templatePayload.components = components
    }
  } else if (params && params.length > 0) {
    // Legacy body-only path — no template row available.
    templatePayload.components = [
      {
        type: 'body',
        parameters: params.map((p) => ({ type: 'text', text: String(p) })),
      },
    ]
  }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...templateRecipientField(recipient),
    type: 'template',
    template: templatePayload,
  }
  if (contextMessageId) {
    body.context = { message_id: contextMessageId }
  }

  const response = await postMessagesPayload(url, accessToken, body)
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  console.log('[OUTBOUND WHATSAPP]', data)
  return { messageId: data.messages[0].id }
}

// ============================================================
// Resumable Upload (media handles for template headers)
// ============================================================
//
// Creating a message template with a media HEADER (image/video/
// document) requires an `example.header_handle` — Meta does NOT accept
// a plain public URL at creation time. The handle comes from the
// two-step Resumable Upload API, which is keyed on the Meta APP id (not
// the phone number / WABA):
//
//   1. POST /{app_id}/uploads?file_name&file_length&file_type&access_token
//        → { id: "upload:<session>" }
//   2. POST /{id}  (Authorization: OAuth <token>, file_offset: 0, raw bytes)
//        → { h: "<handle>" }
//
// See https://developers.facebook.com/docs/graph-api/guides/upload

export interface UploadResumableMediaArgs {
  /** Meta App id (env META_APP_ID) — resumable upload is app-scoped. */
  appId: string
  accessToken: string
  fileName: string
  mimeType: string
  bytes: Uint8Array
}

/**
 * Upload a file via the Resumable Upload API and return the media
 * handle to use as `example.header_handle` when creating/editing a
 * template with a media header.
 */
export async function uploadResumableMedia(
  args: UploadResumableMediaArgs,
): Promise<{ handle: string }> {
  const { appId, accessToken, fileName, mimeType, bytes } = args

  // Step 1 — open an upload session.
  const startParams = new URLSearchParams({
    file_name: fileName,
    file_length: String(bytes.byteLength),
    file_type: mimeType,
    access_token: accessToken,
  })
  const startRes = await fetch(
    `${META_API_BASE}/${appId}/uploads?${startParams.toString()}`,
    { method: 'POST' },
  )
  if (!startRes.ok) {
    await throwMetaError(startRes, `Resumable upload start failed: ${startRes.status}`)
  }
  const startData = (await startRes.json()) as { id?: string }
  if (!startData.id) {
    throw new Error('Resumable upload did not return a session id.')
  }

  // Step 2 — upload the bytes. Note the `OAuth` auth scheme (not Bearer)
  // and the file_offset header, both required by this endpoint.
  const uploadRes = await fetch(`${META_API_BASE}/${startData.id}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${accessToken}`,
      file_offset: '0',
    },
    // Uint8Array is a valid BodyInit at runtime; cast around the
    // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
    body: bytes as unknown as BodyInit,
  })
  if (!uploadRes.ok) {
    await throwMetaError(uploadRes, `Resumable upload failed: ${uploadRes.status}`)
  }
  const uploadData = (await uploadRes.json()) as { h?: string }
  if (!uploadData.h) {
    throw new Error('Resumable upload did not return a file handle.')
  }
  return { handle: uploadData.h }
}

// ============================================================
// Template submission (Business Management API)
// ============================================================

import type { MetaTemplateSubmitPayload } from './template-components'

export interface SubmitMessageTemplateArgs {
  wabaId: string
  accessToken: string
  payload: MetaTemplateSubmitPayload
}

export interface SubmitMessageTemplateResult {
  id: string
  status: string
  category?: string
}

/**
 * Submit a message template to Meta for approval.
 *
 * Returns Meta's assigned template id + initial status (typically
 * PENDING). Caller persists `id` as `meta_template_id` so the
 * upcoming edit/delete flows can scope to this exact template (and
 * language variant) via `hsm_id`, rather than nuking every variant
 * with the same name.
 *
 * 429s from Meta (rate limit: 100 creates/hour/WABA) surface as a
 * regular `Error('Meta API error: 429')`. The route handler
 * distinguishes 429 and shows a more actionable toast.
 */
export async function submitMessageTemplate(
  args: SubmitMessageTemplateArgs
): Promise<SubmitMessageTemplateResult> {
  const { wabaId, accessToken, payload } = args
  const url = `${META_API_BASE}/${wabaId}/message_templates`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  if (!data?.id) {
    throw new Error('Meta accepted the template but returned no id.')
  }
  return {
    id: String(data.id),
    status: typeof data.status === 'string' ? data.status : 'PENDING',
    category: typeof data.category === 'string' ? data.category : undefined,
  }
}

export interface EditMessageTemplateArgs {
  /** Meta's template id (stored locally as `meta_template_id`). */
  metaTemplateId: string
  accessToken: string
  /** Send the full components array — Meta replaces, not patches. */
  components: MetaTemplateSubmitPayload['components']
  /** Optional — only certain category transitions are allowed by Meta. */
  category?: MetaTemplateSubmitPayload['category']
}

export interface EditMessageTemplateResult {
  success: boolean
}

/**
 * Edit an existing (APPROVED or REJECTED) message template.
 *
 * Meta caps edits at 10 per 30 days (and 1 per 24h for APPROVED
 * templates). Every edit re-triggers review, so the status flips
 * back to PENDING until Meta approves the new components.
 *
 * Note: PENDING / DISABLED / IN_APPEAL templates cannot be edited
 * — the route handler enforces that before calling here.
 */
export async function editMessageTemplate(
  args: EditMessageTemplateArgs
): Promise<EditMessageTemplateResult> {
  const { metaTemplateId, accessToken, components, category } = args
  const body: Record<string, unknown> = { components }
  if (category) body.category = category
  const response = await fetch(`${META_API_BASE}/${metaTemplateId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json().catch(() => ({}))
  return { success: data?.success !== false }
}

export interface DeleteMessageTemplateArgs {
  wabaId: string
  accessToken: string
  name: string
  /**
   * Without `hsm_id`, Meta deletes EVERY language variant of the
   * template with this `name`. Pass the row's `meta_template_id`
   * to scope to a single variant.
   */
  metaTemplateId?: string
}

/**
 * Delete a message template on Meta. Pass `metaTemplateId` to scope
 * to a single language variant — otherwise Meta nukes every variant
 * sharing the same `name`.
 */
export async function deleteMessageTemplate(
  args: DeleteMessageTemplateArgs
): Promise<void> {
  const { wabaId, accessToken, name, metaTemplateId } = args
  const params = new URLSearchParams({ name })
  if (metaTemplateId) params.set('hsm_id', metaTemplateId)
  const url = `${META_API_BASE}/${wabaId}/message_templates?${params.toString()}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  // Treat a 404 as a no-op — the template is already gone on Meta's
  // side, and we still want the local row removed.
  if (response.status === 404) return
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
}

// ============================================================
// Typing indicator (read receipt + "…" bubble)
// ============================================================

// Typing indicators were introduced after v21.0 (the base version used
// by the send helpers) — the official docs show this call on v24+, so
// it gets its own version constant rather than bumping every endpoint.
const TYPING_INDICATOR_API_VERSION = 'v24.0'

export interface SendTypingIndicatorArgs {
  phoneNumberId: string
  accessToken: string
  /** Meta's id of the inbound message being answered (webhook `messages[].id`). */
  messageId: string
}

/**
 * Show a WhatsApp typing indicator for a received message.
 *
 * Meta has no dedicated "composing" endpoint — the way to display the
 * typing bubble is a single message request with `status: 'read'` plus
 * a `typing_indicator` block. It marks the inbound as read (blue double
 * checks) and shows the "…" indicator on the customer's device until we
 * reply (which dismisses it automatically) or 25 seconds elapse,
 * whichever comes first. The response is `{ success: true }`, not a
 * message-id envelope.
 *
 * Best-effort by nature: callers should fire-and-forget it — a failed
 * indicator must never block webhook processing. Throws only on a
 * non-2xx from Meta (consistent with the other helpers).
 */
export async function sendTypingIndicator(
  args: SendTypingIndicatorArgs,
): Promise<void> {
  const { phoneNumberId, accessToken, messageId } = args
  const url = `https://graph.facebook.com/${TYPING_INDICATOR_API_VERSION}/${requireMetaPhoneNumberId(phoneNumberId)}/messages`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    }),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
}

// ============================================================
// Reactions
// ============================================================

export interface SendReactionMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  /** Meta's message_id of the message being reacted to. */
  targetMessageId: string
  /** Single emoji, or empty string to remove an existing reaction. */
  emoji: string
}

/**
 * Send a reaction (or removal) to a previously-exchanged message.
 * Empty `emoji` removes the reaction per Meta's spec.
 */
export async function sendReactionMessage(
  args: SendReactionMessageArgs
): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, targetMessageId, emoji } = args
  const recipient = assertDialableRecipient(to)
  const url = messagesUrl(phoneNumberId)
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...recipientFields(recipient),
    type: 'reaction',
    reaction: { message_id: targetMessageId, emoji },
  }
  const response = await postMessagesPayload(url, accessToken, body)
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  console.log('[OUTBOUND WHATSAPP]', data)
  return { messageId: data.messages[0].id }
}

// ============================================================
// Interactive (button replies + list messages)
// ============================================================
//
// Meta's two flavours of interactive message — used by the Flows
// engine to drive scripted chatbot menus. Caller passes plain
// JS values; helpers shape the Meta payload and enforce Meta's
// limits BEFORE the network call so the failure mode is a
// developer-facing error rather than a customer-facing one.

/**
 * Meta limits for interactive messages, hard-coded so violations
 * fail at build/save time rather than as a 400 from the Meta API
 * mid-conversation. See:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages
 */
export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const

export interface InteractiveButton {
  /** Stable id sent back in the webhook when tapped (≤ 256 chars). */
  id: string
  /** Visible label (≤ 20 chars per Meta). */
  title: string
}

export interface SendInteractiveButtonsArgs {
  phoneNumberId: string
  accessToken: string
  to?: string
  recipient?: string
  /** The body text — what the customer reads above the buttons. */
  bodyText: string
  /** Optional plain-text header (≤ 60 chars). */
  headerText?: string
  /** Optional grey footer line under the buttons (≤ 60 chars). */
  footerText?: string
  /** 1–3 buttons. Validated against Meta's limits before sending. */
  buttons: InteractiveButton[]
  /** Meta's message_id of the message being replied to (quote preview). */
  contextMessageId?: string
}

/**
 * Send an interactive message with up to 3 inline reply buttons. The
 * customer taps one and Meta delivers a webhook with
 * `messages[0].interactive.button_reply.id` set to the matching button.id.
 *
 * Validation throws BEFORE the network call so misconfigured flows
 * fail at save time, not during a live conversation.
 */
export async function sendInteractiveButtons(
  args: SendInteractiveButtonsArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId, accessToken, to,
    bodyText, headerText, footerText, buttons, contextMessageId,
  } = args
  const recipient = assertDialableRecipient(to ?? '')
  validateInteractiveBody(bodyText)
  validateInteractiveHeaderFooter(headerText, footerText)
  if (buttons.length < 1 || buttons.length > INTERACTIVE_LIMITS.maxButtons) {
    throw new Error(
      `Interactive button message requires 1-${INTERACTIVE_LIMITS.maxButtons} buttons (got ${buttons.length}).`
    )
  }
  const seenButtonIds = new Set<string>()
  for (const btn of buttons) {
    if (!btn.id) throw new Error('Interactive button missing id.')
    // Duplicate button ids make the tapped-button webhook ambiguous —
    // Meta rejects them, and the pre-flight validator (interactive.ts)
    // rejects them too, so guard here to keep the two paths in step.
    if (seenButtonIds.has(btn.id)) {
      throw new Error(`Interactive message has duplicate button id "${btn.id}".`)
    }
    seenButtonIds.add(btn.id)
    if (!btn.title) throw new Error(`Interactive button "${btn.id}" missing title.`)
    if (btn.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
      throw new Error(
        `Interactive button title "${btn.title}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`
      )
    }
  }

  const interactive: Record<string, unknown> = {
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: buttons.map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: b.title },
      })),
    },
  }
  if (headerText) interactive.header = { type: 'text', text: headerText }
  if (footerText) interactive.footer = { text: footerText }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...recipientFields(recipient),
    type: 'interactive',
    interactive,
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const url = messagesUrl(phoneNumberId)
  const response = await postMessagesPayload(url, accessToken, body)
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  console.log('[OUTBOUND WHATSAPP]', data)
  return { messageId: data.messages[0].id }
}

export interface InteractiveListRow {
  /** Stable id sent back in the webhook when tapped (≤ 200 chars). */
  id: string
  /** Visible row title (≤ 24 chars per Meta). */
  title: string
  /** Optional secondary line shown under the title (≤ 72 chars). */
  description?: string
}

export interface InteractiveListSection {
  /** Optional section header shown above its rows. */
  title?: string
  rows: InteractiveListRow[]
}

export interface SendInteractiveListArgs {
  phoneNumberId: string
  accessToken: string
  to?: string
  recipient?: string
  bodyText: string
  /** Label of the tap-to-expand button on the message bubble. */
  buttonLabel: string
  headerText?: string
  footerText?: string
  /**
   * 1–10 rows TOTAL across all sections. Meta caps the *total*, not
   * per-section. Validation enforces this before send.
   */
  sections: InteractiveListSection[]
  contextMessageId?: string
}

/**
 * Send an interactive message with a tap-to-expand list of selectable
 * rows. Use when there are more options than the 3-button limit allows.
 * Webhook arrives with `messages[0].interactive.list_reply.id` set to
 * the matching row.id.
 */
export async function sendInteractiveList(
  args: SendInteractiveListArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId, accessToken, to,
    bodyText, buttonLabel, headerText, footerText, sections, contextMessageId,
  } = args
  const recipient = assertDialableRecipient(to ?? '')
  validateInteractiveBody(bodyText)
  validateInteractiveHeaderFooter(headerText, footerText)
  if (!buttonLabel) throw new Error('Interactive list requires a buttonLabel.')
  if (buttonLabel.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
    throw new Error(
      `Interactive list buttonLabel "${buttonLabel}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`
    )
  }
  if (sections.length < 1 || sections.length > INTERACTIVE_LIMITS.maxListSections) {
    throw new Error(
      `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListSections} sections (got ${sections.length}).`
    )
  }
  const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0)
  if (totalRows < 1 || totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
    throw new Error(
      `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListRowsTotal} rows total across all sections (got ${totalRows}).`
    )
  }
  const seenIds = new Set<string>()
  for (const section of sections) {
    for (const row of section.rows) {
      if (!row.id) throw new Error('Interactive list row missing id.')
      if (seenIds.has(row.id)) {
        throw new Error(`Interactive list has duplicate row id "${row.id}".`)
      }
      seenIds.add(row.id)
      if (!row.title) throw new Error(`Interactive list row "${row.id}" missing title.`)
      if (row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength) {
        throw new Error(
          `Interactive list row title "${row.title}" exceeds ${INTERACTIVE_LIMITS.listRowTitleMaxLength} chars.`
        )
      }
      if (
        row.description &&
        row.description.length > INTERACTIVE_LIMITS.listRowDescriptionMaxLength
      ) {
        throw new Error(
          `Interactive list row description for "${row.id}" exceeds ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength} chars.`
        )
      }
    }
  }

  const interactive: Record<string, unknown> = {
    type: 'list',
    body: { text: bodyText },
    action: {
      button: buttonLabel,
      sections: sections.map((s) => ({
        ...(s.title ? { title: s.title } : {}),
        rows: s.rows.map((r) => ({
          id: r.id,
          title: r.title,
          ...(r.description ? { description: r.description } : {}),
        })),
      })),
    },
  }
  if (headerText) interactive.header = { type: 'text', text: headerText }
  if (footerText) interactive.footer = { text: footerText }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...recipientFields(recipient),
    type: 'interactive',
    interactive,
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const url = messagesUrl(phoneNumberId)
  const response = await postMessagesPayload(url, accessToken, body)
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  console.log('[OUTBOUND WHATSAPP]', data)
  return { messageId: data.messages[0].id }
}

function validateInteractiveBody(bodyText: string): void {
  if (!bodyText) throw new Error('Interactive message requires bodyText.')
  if (bodyText.length > INTERACTIVE_LIMITS.bodyMaxLength) {
    throw new Error(
      `Interactive bodyText exceeds ${INTERACTIVE_LIMITS.bodyMaxLength} chars.`
    )
  }
}

function validateInteractiveHeaderFooter(
  headerText: string | undefined,
  footerText: string | undefined,
): void {
  if (headerText && headerText.length > INTERACTIVE_LIMITS.headerTextMaxLength) {
    throw new Error(
      `Interactive headerText exceeds ${INTERACTIVE_LIMITS.headerTextMaxLength} chars.`
    )
  }
  if (footerText && footerText.length > INTERACTIVE_LIMITS.footerMaxLength) {
    throw new Error(
      `Interactive footerText exceeds ${INTERACTIVE_LIMITS.footerMaxLength} chars.`
    )
  }
}

// ============================================================
// Media
// ============================================================

export interface GetMediaUrlArgs {
  mediaId: string
  accessToken: string
}

/**
 * Resolve a media ID to Meta's (short-lived, authenticated) CDN URL
 * plus the MIME type. Step one of the media-proxy flow.
 *
 * `fileSize` is Meta's `file_size` (bytes) and is what lets the
 * inbound mirror (issue #466) reject a file the `chat-media` bucket
 * would refuse WITHOUT downloading it first — a 90 MB document costs
 * nothing to skip here and a full transfer to skip after the fact.
 * Null when Meta omits the field or sends something non-numeric.
 */
export async function getMediaUrl(
  args: GetMediaUrlArgs
): Promise<{ url: string; mimeType: string; fileSize: number | null }> {
  const { mediaId, accessToken } = args
  const response = await fetch(`${META_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    // Strict ceiling — a stuck Meta call must not block the webhook's
    // `after()` pipeline (which feeds the AI reply).
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    await throwMetaError(response, `Media fetch failed: ${response.status}`)
  }
  const data = await response.json()
  if (!data.url) throw new Error('Media URL not found in Meta response')
  // Meta documents file_size as a number but has been observed sending
  // it as a numeric string; Number() handles both and NaN-guards junk.
  const size = Number(data.file_size)
  return {
    url: data.url,
    mimeType: data.mime_type || 'application/octet-stream',
    fileSize: Number.isFinite(size) && size >= 0 ? size : null,
  }
}

export interface DownloadMediaArgs {
  downloadUrl: string
  accessToken: string
}

/**
 * Fetch the binary bytes for a media URL obtained from getMediaUrl.
 * Step two of the media-proxy flow.
 */
export async function downloadMedia(
  args: DownloadMediaArgs
): Promise<{ buffer: Buffer; contentType: string }> {
  const { downloadUrl, accessToken } = args
  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Media download failed: ${response.status} ${detail.slice(0, 300)}`)
  }
  const contentType =
    response.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await response.arrayBuffer())
  return { buffer, contentType }
}