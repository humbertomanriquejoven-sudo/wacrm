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
 *   1. a dialable number on the contact row;
 *   2. a real number recovered from the contact's OWN message history;
 *   3. `wa_id` — the id Meta used as the inbound `from`;
 *   4. `wa_user_id`, or a legacy `phone` that still holds a BSUID;
 *   5. `recipient_id`;
 *   6. `username` as `@handle`.
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

  // 6. The public handle, as `@user`.
  const handle = normalizeUsername(contact.username);
  if (handle) return { to: handle, isPhone: false };

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
    .select('conversation_id, sender_phone')
    .in('conversation_id', conversationIds)
    .not('sender_phone', 'is', null)
    .order('created_at', { ascending: false })
    .limit(HISTORY_SCAN_LIMIT);

  if (msgError) {
    console.warn(
      '[broadcast] message-history lookup failed; addresses cannot be recovered',
      msgError.message,
    );
    return recovered;
  }

  // Newest-first from the query, so the first dialable hit per thread wins.
  const phoneByConversation = new Map<string, string>();
  for (const row of (msgRows ?? []) as Array<{
    conversation_id: string;
    sender_phone: string | null;
  }>) {
    if (phoneByConversation.has(row.conversation_id)) continue;
    const dialable = toDialable(row.sender_phone);
    if (dialable) phoneByConversation.set(row.conversation_id, dialable);
  }

  for (const contact of pending) {
    for (const conversationId of convIdsByContact.get(contact.id) ?? []) {
      const found = phoneByConversation.get(conversationId);
      if (found) {
        recovered.set(contact.id, found);
        break;
      }
    }
  }
  return recovered;
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
