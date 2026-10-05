/**
 * Delivery-address resolution for broadcast recipients.
 *
 * The dashboard broadcast wizard runs in the browser, so it cannot import
 * the Inbox's own resolver (`recipient-resolver.ts` pulls in the
 * service-role client). This module is that same resolution, expressed
 * against the browser client: the identical query shape, the identical
 * column, and the identical phone-vs-identifier boundary — both sides
 * classify through `phone-utils`, so they cannot drift apart again.
 *
 * Kept as a standalone module (like `broadcast-retry`) rather than inline
 * in the hook so it can be unit-tested. That is not incidental: this logic
 * sat untested inside the hook through five consecutive patch attempts,
 * each of which changed the number-formatting and left the actual defect —
 * a query against columns that do not exist — untouched.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { isOpaqueMetaId } from './meta-api';
import {
  isDialablePhone,
  normalizeUsername,
  passthroughMetaId,
  toDialable,
} from './phone-utils'
import type { Contact } from '@/types';

/**
 * Country code assumed for a bare national number.
 *
 * Applied ONLY to a value that is already phone-shaped and exactly
 * {@link NATIONAL_NUMBER_DIGITS} long, so it can never be applied to a
 * value that already carries its own country code.
 */
export const DEFAULT_COUNTRY_CODE = '57';

/** Length of a national number with no country code (e.g. a Colombian mobile). */
export const NATIONAL_NUMBER_DIGITS = 10;

/** How many recent messages to scan when recovering an address. */
const HISTORY_SCAN_LIMIT = 200;

/**
 * Normalize a value to the digits-only address Meta expects, or null when
 * it is not a phone number at all.
 *
 * The phone-shape check runs on the WHOLE value before any digit is
 * inspected, and that ordering is the whole point: `isDialablePhone`
 * rejects anything that is not `+` / digits / spacing, so an @username
 * (`@usuario`) and a BSUID (`CO.1008477715690681`) can never be
 * digit-stripped into a plausible-looking number. Stripping first is what
 * turned a handle into 10 stray digits and aimed a campaign at a stranger.
 *
 * A value that already carries a country code is passed through untouched.
 * Returns null — never a guess — when nothing dialable is present.
 */
export function normalizeToE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!isDialablePhone(value)) return null;

  const digits = value.replace(/\D/g, '');
  if (digits.length === NATIONAL_NUMBER_DIGITS) {
    return `${DEFAULT_COUNTRY_CODE}${digits}`;
  }
  return digits;
}

/**
 * The one reason a recipient cannot be sent to, stated in full.
 *
 * Meta answers a non-numeric destination with `(#100) Invalid parameter` -
 * or worse, HTTP 200 with the message silently dropped, which marks the
 * recipient sent while nobody received it. Naming both possibilities locally
 * is what makes a failed campaign diagnosable without guessing at Meta's
 * error.
 */
export const NO_DELIVERABLE_ADDRESS =
  'No valid phone or BSUID in contact history';

/**
 * Keys Meta uses to disclose a sender's own identifier in a webhook entry.
 *
 * `wa_id`/`from`/`user_id` are the sender's address; `lid` is the
 * directory-scoped id. All are validated by `passthroughMetaId`, so a
 * display name or `phone_number_id` can never be mistaken for one of them.
 */
const RAW_PAYLOAD_ID_KEYS = ['wa_id', 'from', 'user_id', 'lid'] as const;

/**
 * Pull a deliverable numeric identifier out of a stored webhook payload.
 *
 * `messages.raw_meta_payload` (migration 052) holds the entry Meta delivered.
 * The identifiers we care about live at a handful of known keys, and the
 * depth varies by Cloud API version, so each candidate is read defensively
 * and validated through `passthroughMetaId`.
 *
 * No key is hardcoded to a specific WABA, number or account — these are the
 * documented field names Meta uses for every sender — and a payload that
 * holds nothing usable returns null rather than a guess.
 */
export function metaIdFromRawPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;

  const visit = (node: unknown, depth: number): string | null => {
    if (!node || typeof node !== 'object' || depth > 4) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = visit(item, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    const record = node as Record<string, unknown>;
    for (const key of RAW_PAYLOAD_ID_KEYS) {
      const value = record[key];
      if (typeof value === 'string') {
        const id = passthroughMetaId(value);
        if (id) return id;
      }
    }
    // `contacts[0]` is where Meta nests the sender identity; recursing covers
    // both the flat and the nested shape.
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        const hit = visit(value, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };

  return visit(payload, 0);
}

/**
 * The minimum a contact must carry to be addressed.
 *
 * Structural rather than the full `Contact` row so the server-side resume
 * path — which selects a handful of identity columns via an embedded join —
 * can call the SAME resolver the dashboard uses. One resolver, two call
 * sites; they cannot drift.
 */
export interface BroadcastIdentity {
  phone?: string | null;
  wa_id?: string | null;
  wa_user_id?: string | null;
  username?: string | null;
  recipient_id?: string | null;
}

/**
 * The real phone number already stored on the contact row, or null.
 *
 * Only genuinely numeric values are consulted, and the `'unknown'`
 * placeholder is rejected: `contacts.phone` is `NOT NULL`, so the webhook
 * writes that literal string when Meta disclosed no number, and it must
 * never read back as a number.
 *
 * This returns NUMBERS ONLY. BSUIDs and @handles are valid `to` values for
 * Meta — but they are a lower-priority fallback, so they are handled by
 * {@link resolveBroadcastAddress} rather than here. Folding them in here
 * would let an opaque id pre-empt a real number sitting further down the
 * priority list.
 */
export function contactPhone(
  contact: BroadcastIdentity | null | undefined,
): string | null {
  if (!contact) return null;
  return normalizeToE164(contact.phone) ?? normalizeToE164(contact.wa_id);
}

/** A resolved broadcast destination, and what kind of address it is. */
export interface BroadcastAddress {
  /** Value for Meta's `to` field. */
  to: string;
  /**
   * True only for a dialable E.164 number.
   *
   * Gates persistence: a BSUID or handle that Meta accepted must NOT be
   * written back into `contacts.phone`, which is a number column with a
   * UNIQUE index on its normalized form.
   */
  isPhone: boolean;
  /**
   * True when this destination is only reachable as a quoted reply.
   *
   * Set for tier C (a bare `@handle`). Meta will not accept a text handle in
   * `to` on its own — it answers `(#100) Invalid parameter`, or returns 200
   * and silently drops the message, which would mark the recipient sent
   * while nobody received it. The only supported route is a quote anchored
   * on a message the contact actually wrote, so the caller MUST resolve a
   * `contextMessageId` or mark the recipient undeliverable.
   *
   * Carried on the result rather than recomputed from the string so the
   * dashboard path and the server-side resume path cannot disagree about
   * whether a send needs an anchor.
   */
  needsQuote: boolean;
}

/**
 * Resolve the `to` value for one broadcast recipient.
 *
 * Mirrors the Inbox's `resolveBestRecipient`
 * (`recipient-resolver.ts`) step for step, in the same priority order:
 *
 * Tier A — a real number, from the contact row or recovered from the
 *   contact's OWN message history (`sender_phone`, then `raw_meta_payload`).
 *   Always deliverable on its own.
 *
 * Tier B — a numeric Meta id: `wa_id`, then `wa_user_id` (or a legacy
 *   `phone` still holding a BSUID), then `recipient_id`. These exist because
 *   a sender who has never messaged from a registered number has no phone
 *   number *anywhere* in the database — Meta discloses an identifier instead.
 *   Deliverable on its own.
 *
 * Tier C — a bare `@handle`, flagged `needsQuote`. Deliverable ONLY as a
 *   quoted reply anchored on a message the contact wrote; Meta rejects a text
 *   handle in `to` with `(#100)`.
 *
 * Tier D — nothing at all. Returned as null so the caller can record
 *   `NO_DELIVERABLE_ADDRESS` locally instead of firing a request Meta will
 *   reject (or silently drop).
 *
 * Which tier was hit is decided purely by the shape of the values present, so
 * this stays generic: no WABA-, number- or account-specific knowledge, and no
 * contact, id or parameter hardcoded.
 *
 * Steps 3-6 exist because a sender who has never messaged from a registered
 * number has no phone number *anywhere* in the database — Meta discloses a
 * BSUID instead. A previous version of this module returned null for those
 * contacts and reported them undeliverable, while the Inbox delivered to
 * the exact same contact successfully via its BSUID. `send-message.ts`
 * passes a non-dialable address straight to Meta (`variants = [address]`),
 * so the broadcast path must accept one too.
 *
 * Every branch is decided by the data present at call time: no
 * WABA-, number- or account-specific knowledge.
 */
export function resolveBroadcastAddress(
  contact: BroadcastIdentity | null | undefined,
  recovered?: string | null,
): BroadcastAddress | null {
  if (!contact) return null;

  // 1 + 2. A real number always wins, whether already on the row or dug out
  // of this contact's own thread.
  const phone = contactPhone(contact) ?? normalizeToE164(recovered);
  if (phone) return { to: phone, isPhone: true, needsQuote: false };

  // 3. wa_id — checked before the BSUID because it is the address Meta
  //    actually used to reach this contact.
  const waId = passthroughMetaId(contact.wa_id);
  if (waId) return { to: waId, isPhone: false, needsQuote: false };

  // 4. BSUID, including the legacy case of one written into `phone`.
  const bsuid =
    passthroughMetaId(contact.wa_user_id) ?? passthroughMetaId(contact.phone);
  if (bsuid) return { to: bsuid, isPhone: false, needsQuote: false };

  // 5. recipient_id — the alternative Meta identifier.
  const recipientId = passthroughMetaId(contact.recipient_id);
  if (recipientId) return { to: recipientId, isPhone: false, needsQuote: false };

  // 6. Tier C — a bare `@handle`, the last resort.
  //
  //   The handle IS returned, flagged `needsQuote`. It is a real destination
  //   for a quoted reply, but not on its own: Meta rejects a text handle in
  //   `to` with `(#100) Invalid parameter`, or worse, answers 200 and drops
  //   the message silently — which would mark the recipient sent while nobody
  //   received it.
  //
  //   So the caller must resolve a `contextMessageId` from this contact's own
  //   inbound history before sending, and mark the recipient undeliverable
  //   when there is none. Tier D (truly nothing) is decided there, with the
  //   WAMID lookup in hand — it cannot be decided from the contact row alone.
  const handle = normalizeUsername(contact.username);
  if (handle) return { to: handle, isPhone: false, needsQuote: true };

  // Tier D: no number, no Meta id, no handle. Nothing here can ever be
  // delivered to, and no amount of retrying will change that.
  return null;
}

/**
 * Recover a real phone number for contacts whose row carries none, from
 * the address those contacts actually wrote from.
 *
 * Mirrors the Inbox's resolver (`recipient-resolver.ts` →
 * `findPhoneInMessageHistory`) so a broadcast goes to exactly the address
 * the inbox would reply to: the newest `messages.sender_phone`, restricted
 * to the contact's own conversations.
 *
 * Batched: two queries per send batch rather than two per recipient. A
 * campaign is 1 000 recipients, so the per-contact shape was the slow path
 * as well as the broken one.
 */
export async function recoverAddressesFromHistory(
  db: SupabaseClient,
  contacts: Contact[],
): Promise<Map<string, string>> {
  const recovered = new Map<string, string>();
  const pending = contacts.filter(
    (c): c is Contact => Boolean(c) && !contactPhone(c),
  );
  if (pending.length === 0) return recovered;

  // `messages` has neither contact_id nor account_id: it is reached
  // through `conversations`. Scoping those ids to THIS contact is the
  // isolation boundary — another contact's thread must never be consulted,
  // or a number belonging to a different person receives the campaign.
  const { data: convRows, error: convError } = await db
    .from('conversations')
    .select('id, contact_id')
    .in(
      'contact_id',
      pending.map((c) => c.id),
    );

  // Surfaced rather than swallowed. The previous version destructured only
  // `data`, so a rejected query and a legitimately empty result were
  // indistinguishable: both looked like "no history exists". That is how a
  // whole class of lookup failure presented as a data problem.
  if (convError) {
    console.warn(
      '[broadcast] conversation lookup failed; addresses cannot be recovered',
      convError.message,
    );
    return recovered;
  }

  const convIdsByContact = new Map<string, string[]>();
  for (const row of (convRows ?? []) as Array<{
    id: string;
    contact_id: string;
  }>) {
    const list = convIdsByContact.get(row.contact_id) ?? [];
    list.push(row.id);
    convIdsByContact.set(row.contact_id, list);
  }

  const conversationIds = [...new Set([...convIdsByContact.values()].flat())];
  if (conversationIds.length === 0) return recovered;

  // `sender_phone` (migration 050) is the ONLY column on `messages` that
  // holds the address Meta used. This query previously selected `address`,
  // `whatsapp_id` and `from` — none of which exist on the table — so
  // PostgREST rejected every one of them with a 400, `data` came back
  // null, and the lookup silently resolved to nothing. That is why @user
  // recipients were reported undeliverable no matter how the number
  // formatting was tuned.
  const { data: msgRows, error: msgError } = await db
    .from('messages')
    .select('conversation_id, sender_phone, raw_meta_payload')
    .in('conversation_id', conversationIds)
    // Inbound only. `sender_phone` on an 'agent' row is OUR number, so
    // without this the newest row in the thread can resolve the recipient to
    // the sender of the broadcast itself.
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(HISTORY_SCAN_LIMIT);

  if (msgError) {
    console.warn(
      '[broadcast] message-history lookup failed; addresses cannot be recovered',
      msgError.message,
    );
    return recovered;
  }

  // Newest-first from the query, so the first usable hit per thread wins.
  //
  // A thread yields EITHER a dialable number or a numeric BSUID, and the two
  // are not interchangeable: a BSUID is not a phone number, so
  // `toDialable` alone dropped every BSUID-only thread on the floor, which
  // is exactly the contact shape this function exists to rescue. Both go
  // through `passthroughMetaId` (which demands an all-digit run of at least
  // 6 characters or a namespaced id, and returns `null` for the literal
  // 'unknown'), so no invented or truncated address can enter here.
  const addressByConversation = new Map<string, string>();
  for (const row of (msgRows ?? []) as Array<{
    conversation_id: string;
    sender_phone: string | null;
    raw_meta_payload?: unknown;
  }>) {
    if (addressByConversation.has(row.conversation_id)) continue;

    // `sender_phone` snapshots whatever Meta disclosed as the inbound
    // `from`. It is a real number for a registered sender and the BSUID for
    // an unregistered one, so both classifications are attempted.
    const fromColumn = toDialable(row.sender_phone) ?? passthroughMetaId(row.sender_phone);
    if (fromColumn) {
      addressByConversation.set(row.conversation_id, fromColumn);
      continue;
    }

    // Last resort: the ids Meta recorded inside the stored webhook payload.
    // Only consulted once the dedicated columns came up empty, so it cannot
    // pre-empt a cleaner value.
    const fromPayload = metaIdFromRawPayload(row.raw_meta_payload);
    if (fromPayload) addressByConversation.set(row.conversation_id, fromPayload);
  }

  for (const contact of pending) {
    for (const conversationId of convIdsByContact.get(contact.id) ?? []) {
      const found = addressByConversation.get(conversationId);
      if (found) {
        recovered.set(contact.id, found);
        break;
      }
    }
  }
  return recovered;
}

/**
 * True when `address` is only deliverable as a quoted reply.
 *
 * Buckets, per the classification in `meta-api.ts`:
 *   - a dialable number — addressable, no anchor needed;
 *   - an opaque Meta id (`CO.…`, `WAID.…`, or a >14-digit run) — addressable
 *     on its own, no anchor needed;
 *   - anything else (a bare `@handle`, a short digit run scraped out of an
 *     `@lid`, the literal `unknown`) — NOT a destination. Meta answers
 *     `(#100) Invalid parameter`, or 200 with the message silently dropped.
 *     The only supported route is a quote anchored on a message they wrote.
 */
export function needsQuotedAnchor(address: string | null | undefined): boolean {
  const value = (address ?? '').trim();
  if (!value) return false;
  return !isDialablePhone(value) && !isOpaqueMetaId(value);
}

/**
 * The newest inbound WhatsApp message id (`wamid`) per contact, for use as
 * a quoted-reply anchor.
 *
 * Meta does not treat a public @handle as a destination: `to`/`recipient`
 * carrying one is either rejected with `(#100) Invalid parameter` or
 * silently dropped (HTTP 200, nothing delivered). The one supported way to
 * reach such a contact is a QUOTED REPLY anchored on a message they
 * actually wrote — see the classification in `meta-api.ts`.
 *
 * `messages` has no `direction` column: an inbound message is
 * `sender_type = 'customer'` ('agent'/'bot' are ours). `message_id` holds
 * the wamid and is nullable, so rows without one are excluded rather than
 * sent as a null anchor.
 *
 * Scoped to each contact's OWN conversations, newest first — the isolation
 * boundary is the same one `recoverAddressesFromHistory` uses, so a wamid
 * belonging to a different customer is never quoted at this one.
 *
 * `accountId` is applied as a second boundary. `contactId` usually arrives
 * from the dashboard, but the public send endpoint accepts it from the
 * request body — without the account filter a caller could quote another
 * tenant's inbound message and have their template land in that thread.
 *
 * Batched: two queries for the whole send, not two per recipient.
 */
export async function recoverInboundWamids(
  db: SupabaseClient,
  contactIds: string[],
  accountId?: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const ids = [...new Set(contactIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return result;

  let convQuery = db
    .from('conversations')
    .select('id, contact_id')
    .in('contact_id', ids);

  if (accountId) convQuery = convQuery.eq('account_id', accountId);

  const { data: convRows, error: convError } = await convQuery;

  if (convError) {
    console.warn(
      '[broadcast] conversation lookup failed; no wamid can be anchored',
      convError.message,
    );
    return result;
  }

  const convIdsByContact = new Map<string, string[]>();
  for (const row of (convRows ?? []) as Array<{
    id: string;
    contact_id: string;
  }>) {
    const list = convIdsByContact.get(row.contact_id) ?? [];
    list.push(row.id);
    convIdsByContact.set(row.contact_id, list);
  }

  const conversationIds = [...new Set([...convIdsByContact.values()].flat())];
  if (conversationIds.length === 0) return result;

  const { data: msgRows, error: msgError } = await db
    .from('messages')
    .select('conversation_id, message_id')
    .in('conversation_id', conversationIds)
    .eq('sender_type', 'customer')
    .not('message_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(HISTORY_SCAN_LIMIT);

  if (msgError) {
    console.warn(
      '[broadcast] inbound-message lookup failed; no wamid can be anchored',
      msgError.message,
    );
    return result;
  }

  // Newest-first from the query, so the first wamid seen per thread wins.
  const wamidByConversation = new Map<string, string>();
  for (const row of (msgRows ?? []) as Array<{
    conversation_id: string;
    message_id: string | null;
  }>) {
    if (!row.message_id) continue;
    if (!wamidByConversation.has(row.conversation_id)) {
      wamidByConversation.set(row.conversation_id, row.message_id);
    }
  }

  for (const contactId of ids) {
    for (const conversationId of convIdsByContact.get(contactId) ?? []) {
      const wamid = wamidByConversation.get(conversationId);
      if (wamid) {
        result.set(contactId, wamid);
        break;
      }
    }
  }
  return result;
}

/**
 * Write a recovered address back to `contacts.phone` so the lookup above is
 * a one-time repair instead of a per-send cost.
 *
 * Best-effort by design: persistence is an optimisation, never a gate on
 * sending. A failure here (RLS, or a 23505 unique violation because another
 * contact in the account already owns that number) is logged and reported,
 * but the address still goes out on this send.
 *
 * Only `phone` is written, and only for a real number: `contacts.phone` is a
 * number column with a UNIQUE index on its normalized form (migration 022),
 * so persisting a BSUID there would both corrupt the column and collide with
 * the next contact that owns that id. `phone_normalized` is itself a
 * GENERATED column, so including it would make every write fail.
 */
export async function persistRecoveredAddress(
  db: SupabaseClient,
  contactId: string,
  phone: string,
): Promise<boolean> {
  const dialable = normalizeToE164(phone);
  if (!dialable) {
    console.warn(
      `[broadcast] refusing to persist non-number address "${phone}" for contact ${contactId}`,
    );
    return false;
  }

  const { error } = await db
    .from('contacts')
    .update({ phone: dialable })
    .eq('id', contactId);

  if (error) {
    console.warn(
      `[broadcast] recovered address ${dialable} for contact ${contactId} could not be persisted`,
      error.message,
    );
    return false;
  }
  return true;
}
