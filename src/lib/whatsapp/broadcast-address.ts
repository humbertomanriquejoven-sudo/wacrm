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

import {
  isDialablePhone,
  passthroughMetaId,
  toDialable,
} from './phone-utils'

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
const RAW_PAYLOAD_ID_KEYS = [
  'wa_id',
  'wa_user_id',
  'from',
  // Meta sends the message-level BSUID here for a sender on a number that is
  // not registered on WhatsApp. It is NOT the same field as `from` (which is
  // the literal string 'unknown' in exactly the case we care about), so it
  // needs its own key to be reachable.
  'from_user_id',
  'user_id',
  'lid',
] as const;

/**
 * How deep to walk a stored webhook payload.
 *
 * A Cloud API entry nests as
 * `entry[] . changes[] . value . messages[] . { from }`, so the id-bearing
 * node sits at depth 5. The previous cap of 4 stopped one level short, which
 * meant a real payload never yielded anything and a handle contact stayed
 * undeliverable — while the flat-shape unit tests, which reach the id at
 * depth 1, kept passing.
 */
const MAX_PAYLOAD_DEPTH = 8;

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
    if (!node || typeof node !== 'object' || depth > MAX_PAYLOAD_DEPTH) return null;
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
 * Tier C — the numerical Meta id carried by the contact's OWN inbound
 *   message (`sender_phone`, or `wa_id`/`wa_user_id` inside
 *   `raw_meta_payload`), passed in as `recovered`. This is how a contact who
 *   is publicly `@somehandle` but has never messaged from a registered number
 *   gets reached: Meta will not accept the text handle in `to`, but it does
 *   accept the id it attached to their message.
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
  if (phone) return { to: phone, isPhone: true };

  // The id recovered from the inbound history, tried as a Meta id.
  //
  // This is the tier-C destination. For a contact known only by
  // `@handle`, Meta's webhook still carried a numerical identifier on the
  // message they wrote (`sender_phone`, or `wa_id`/`wa_user_id` inside
  // `raw_meta_payload`). That identifier — NOT the handle — is what Meta
  // accepts in `to`.
  //
  // `recovered` used to be fed only through `normalizeToE164`, which
  // discards a 15-digit BSUID as "not a phone number". So the recovered id
  // was thrown away and resolution fell through to the handle, which is
  // precisely the value Meta rejects.
  const recoveredId = passthroughMetaId(recovered);
  if (recoveredId) return { to: recoveredId, isPhone: false };

  // 3. wa_id — checked before the BSUID because it is the address Meta
  //    actually used to reach this contact.
  const waId = passthroughMetaId(contact.wa_id);
  if (waId) return { to: waId, isPhone: false };

  // 4. BSUID, including the legacy case of one written into `phone`.
  const bsuid =
    passthroughMetaId(contact.wa_user_id) ?? passthroughMetaId(contact.phone);
  if (bsuid) return { to: bsuid, isPhone: false };

  // 5. recipient_id — the alternative Meta identifier.
  const recipientId = passthroughMetaId(contact.recipient_id);
  if (recipientId) return { to: recipientId, isPhone: false };

  // 6. Tier D — nothing numerical anywhere.
  //
  //   `contacts.username` is deliberately NOT used as a fallback. Meta rejects
  //   a text `@handle` in `to` with `(#100) Invalid parameter`, and adding
  //   `context.message_id` does not change that: quoting makes the send a
  //   reply, it does not make the handle addressable. Sending one risks a
  //   200 with the message silently dropped, which marks the recipient sent
  //   while nobody received it.
  //
  //   A handle contact is therefore only reachable through the numerical
  //   identifier Meta put on their inbound message — handled above, via
  //   `recovered`. If that is missing too, there is no address at all and the
  //   caller records NO_DELIVERABLE_ADDRESS rather than firing a request that
  //   cannot succeed.
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
 *
 * Typed to what it actually reads — `id` plus the identity columns — so a
 * caller holding a projected row (a broadcast recipient's nested `contacts`
 * object, for instance) does not have to widen it to a full `Contact`. A full
 * `Contact` still satisfies this structurally.
 */
export type RecoverableContact = { id: string } & BroadcastIdentity;

export async function recoverAddressesFromHistory(
  db: SupabaseClient,
  contacts: ReadonlyArray<RecoverableContact | null | undefined>,
): Promise<Map<string, string>> {
  const recovered = new Map<string, string>();
  const pending = contacts.filter(
    (c): c is RecoverableContact => Boolean(c?.id) && !contactPhone(c),
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
 * The newest inbound `wamid` each of these contacts wrote, keyed by contact id.
 *
 * Used to anchor a broadcast send as a quoted reply (`context.message_id`),
 * mirroring what the Inbox does when it answers a customer. Meta renders the
 * anchor, so this is presentational — it is NOT what makes an id-only contact
 * reachable. `resolveBroadcastAddress` still has to produce a real `to`;
 * quoting an inbound message does not make a bare `@handle` addressable, and
 * Meta answers (#100) Invalid parameter for one either way.
 *
 * PER CONTACT, never one shared value. A wamid belongs to one conversation:
 * anchoring recipient B's template to recipient A's inbound message would put
 * a stranger's message in B's chat, which is both a privacy incident and a
 * message Meta may reject outright. The `contact_id` join through
 * `conversations` is what keeps each id on its own thread.
 *
 * Batched, two queries total, mirroring {@link recoverAddressesFromHistory}.
 * Inbound only — an `agent` row carries OUR message_id, and quoting ourselves
 * would anchor every send to our own outbound.
 */
export async function recoverContextMessageIds(
  db: SupabaseClient,
  contactIds: readonly string[],
): Promise<Map<string, string>> {
  const anchors = new Map<string, string>();
  const ids = [...new Set(contactIds.filter(Boolean))];
  if (ids.length === 0) return anchors;

  const { data: convRows, error: convError } = await db
    .from('conversations')
    .select('id, contact_id')
    .in('contact_id', ids);

  if (convError) {
    // Not fatal: the send still works, it just is not quoted. Reported so a
    // silent loss of the anchor is distinguishable from "no anchor existed".
    console.warn(
      '[broadcast] conversation lookup failed; replies will not be quoted',
      convError.message,
    );
    return anchors;
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
  if (conversationIds.length === 0) return anchors;

  const { data: msgRows, error: msgError } = await db
    .from('messages')
    .select('conversation_id, message_id')
    .in('conversation_id', conversationIds)
    .eq('sender_type', 'customer')
    .not('message_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1000);

  if (msgError) {
    console.warn(
      '[broadcast] message lookup failed; replies will not be quoted',
      msgError.message,
    );
    return anchors;
  }

  // Newest wins. The rows arrive newest-first, so the first hit per contact is
  // the anchor; later rows for the same contact are older and ignored.
  for (const row of (msgRows ?? []) as Array<{
    conversation_id: string;
    message_id: string | null;
  }>) {
    if (!row.message_id) continue;
    const contactId = (convRows as Array<{ id: string; contact_id: string }>).find(
      (c) => c.id === row.conversation_id,
    )?.contact_id;
    if (contactId && !anchors.has(contactId)) {
      anchors.set(contactId, row.message_id);
    }
  }
  return anchors;
}

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
