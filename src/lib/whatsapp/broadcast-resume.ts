// ============================================================
// Broadcast resume / retry (issue #472).
//
// The dashboard wizard drives its own send loop from the browser tab
// that started the campaign, so closing the tab abandons the campaign
// mid-flight: the remaining recipients stay 'pending' and the
// broadcast sits in 'sending' forever. This module is the recovery —
// and the same machinery answers the reporter's other two asks,
// "reprocess pending" and "reprocess failed".
//
// It deliberately reuses `deliverBroadcast` rather than growing a
// second fan-out loop: same phone-variant retry, same per-recipient
// stamping, same trigger-owned counts.
//
// What it does NOT do is move the *initial* send server-side. The
// wizard still owns that; this makes an abandoned one recoverable.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { BroadcastError, type BroadcastPlan } from '@/lib/whatsapp/broadcast-core';
import { decrypt } from '@/lib/whatsapp/encryption';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import {
  NO_DELIVERABLE_ADDRESS,
  resolveRecipientAddresses,
  recoverContextMessageIds,
  type BroadcastIdentity,
  type RecoverableContact,
} from '@/lib/whatsapp/broadcast-address';

/** Which recipients a resume pass picks up. */
export type ResumeScope = 'pending' | 'failed' | 'all';

export const RESUME_SCOPES: readonly ResumeScope[] = [
  'pending',
  'failed',
  'all',
];

/**
 * Recipients delivered per resume request. One pass runs inside
 * `after()`, so it is bounded by the host's function timeout — the cap
 * keeps a 5 000-recipient backlog from being one un-completable unit
 * of work. Whatever is left stays 'pending' and the caller is told how
 * many, so the UI can offer Resume again. Matches the public API's
 * per-request recipient cap.
 */
export const RESUME_MAX_PER_REQUEST = 1000;

/**
 * How long a `delivery_locked_at` stamp is honoured before it is read
 * as abandoned. Long enough that a legitimately slow pass is never
 * stolen from, short enough that a crashed one doesn't wedge the
 * campaign until someone touches the database.
 */
export const DELIVERY_LOCK_STALE_MS = 30 * 60 * 1000;

function scopeStatuses(scope: ResumeScope): string[] {
  if (scope === 'pending') return ['pending'];
  if (scope === 'failed') return ['failed'];
  return ['pending', 'failed'];
}

/**
 * Take the delivery lock for a broadcast.
 *
 * One conditional UPDATE, so the claim is atomic: a concurrent caller's
 * WHERE no longer matches and it gets `false`. Returns false when the
 * broadcast doesn't exist on this account, too — the caller treats both
 * as "not yours to run".
 */
export async function claimBroadcastDelivery(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  now: Date = new Date()
): Promise<boolean> {
  const staleCutoff = new Date(
    now.getTime() - DELIVERY_LOCK_STALE_MS
  ).toISOString();

  const { data, error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: now.toISOString() })
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .or(`delivery_locked_at.is.null,delivery_locked_at.lt.${staleCutoff}`)
    .select('id');

  if (error) {
    console.error('[broadcast-resume] claim failed:', error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/** Release the delivery lock. Best-effort; a stale lock self-expires. */
export async function releaseBroadcastDelivery(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const { error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: null })
    .eq('id', broadcastId);
  if (error) {
    console.error('[broadcast-resume] release failed:', error.message);
  }
}

export interface ResumePlan {
  plan: BroadcastPlan;
  /** In-scope recipients left over after the per-request cap. */
  remaining: number;
  /**
   * In-scope rows that can never send because their contact has no
   * usable phone. Stamped 'failed' by {@link planBroadcastResume} so
   * they stop blocking the broadcast's terminal status.
   */
  unsendable: number;
}

interface RecipientRow {
  id: string;
  template_params: unknown;
  /** Needed to mirror each send into the right Inbox thread. */
  contact_id: string;
  contact:
    | {
        id?: string;
        phone?: string | null;
        wa_id?: string | null;
        wa_user_id?: string | null;
        username?: string | null;
        recipient_id?: string | null;
      }
    | Array<{
        id?: string;
        phone?: string | null;
        wa_id?: string | null;
        wa_user_id?: string | null;
        username?: string | null;
        recipient_id?: string | null;
      }>
    | null;
}

/**
 * Supabase renders an embedded to-one join as an object or a 1-array.
 *
 * `id` is kept: the history fallback keys recovered addresses by contact id,
 * so a projected row without it could not be recovered.
 */
function contactIdentity(
  row: RecipientRow,
): (BroadcastIdentity & { id?: string }) | null {
  const c = Array.isArray(row.contact) ? row.contact[0] : row.contact;
  return c ?? null;
}

/**
 * The address this recipient should be sent to, resolved exactly as the
 * dashboard resolves it.
 *
 * Resume used to read only `contacts.phone` and gate it on `isValidE164`,
 * so a BSUID or @handle recipient was stamped failed with 'No valid phone
 * number on contact' — a campaign could go out on the first pass and then
 * silently lose every identifier recipient on resume.
 *
 * `recovered` carries the id dug out of the recipient's own inbound thread
 * (see {@link recoverAddressesFromHistory}). Without it resume could only
 * see the identity COLUMNS, so a contact whose id exists solely in
 * `messages.sender_phone` / `raw_meta_payload` resolved on the first pass
 * and then failed on every resume — the two passes disagreed about the same
 * contact. Mirrors `use-broadcast-sending`, which already passed it.
 */

/**
 * Build a {@link BroadcastPlan} for the recipients of an existing
 * broadcast that still need sending.
 *
 * Params come off the recipient rows (frozen at plan time by migration
 * 038) rather than being re-resolved from contact data, so a resume
 * sends what the original pass would have sent even if the contact has
 * been edited since.
 *
 * Throws {@link BroadcastError}; the route maps it.
 */
/** Columns needed to resolve a destination, newest-schema-first. */
const RECIPIENT_SELECT_FULL =
  'id, template_params, contact_id, contact:contacts(id, phone, wa_id, wa_user_id, username, recipient_id)';

/** Same projection without `recipient_id` (migration 057), for older databases. */
const RECIPIENT_SELECT_LEGACY =
  'id, template_params, contact_id, contact:contacts(id, phone, wa_id, wa_user_id, username)';

/**
 * PostgREST rejects the WHOLE query with `42703 column ... does not exist` when
 * any selected column is missing, so an unapplied migration 057 turned every
 * resume into `500 Failed to load recipients` — the endpoint looked broken
 * rather than un-migrated.
 *
 * Retried once without `recipient_id`. Resolution then falls back to
 * `wa_id` / `wa_user_id` / history, so the pass still delivers; the only loss
 * is the alternative-identifier tier.
 *
 * The retry is gated on the error actually being a missing-column error, so a
 * genuine failure (bad filter, network, RLS) is still reported rather than
 * silently retried and re-reported as the same 500.
 */
async function loadRecipients(
  db: SupabaseClient,
  broadcastId: string,
  statuses: readonly string[],
): Promise<{
  data: unknown[] | null;
  error: { message: string } | null;
}> {
  const query = (select: string) =>
    db
      .from('broadcast_recipients')
      .select(select)
      .eq('broadcast_id', broadcastId)
      .in('status', statuses as string[])
      // Oldest first, so repeated capped passes chew through the backlog
      // in a stable order instead of re-picking the same slice.
      .order('created_at', { ascending: true });

  const first = await query(RECIPIENT_SELECT_FULL);

  const isMissingColumn = (message: string) =>
    /column .* does not exist|42703|PGRST204|schema cache/i.test(message);

  if (!first.error || !isMissingColumn(first.error.message)) {
    return {
      data: (first.data ?? null) as unknown[] | null,
      error: first.error ? { message: first.error.message } : null,
    };
  }

  console.warn(
    '[broadcast-resume] contacts.recipient_id is absent; retrying without it. Apply migration 057.',
    first.error.message,
  );

  const retry = await query(RECIPIENT_SELECT_LEGACY);
  return {
    data: (retry.data ?? null) as unknown[] | null,
    error: retry.error ? { message: retry.error.message } : null,
  };
}

export async function planBroadcastResume(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  scope: ResumeScope
): Promise<ResumePlan> {
  const { data: broadcast, error: bcError } = await db
    .from('broadcasts')
    // `user_id` is the campaign's creator. `conversations.user_id` is NOT NULL,
    // so a thread opened by the Inbox mirror needs an audit user — the person
    // who ran the campaign is the correct one, and it is already on this row.
    .select('id, template_name, template_language, user_id')
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (bcError || !broadcast) {
    throw new BroadcastError('not_found', 'Broadcast not found', 404);
  }

  const statuses = scopeStatuses(scope);
  const { data: rawRows, error: recError } = await loadRecipients(
    db,
    broadcastId,
    statuses,
  );

  if (recError) {
    console.error('[broadcast-resume] recipient load failed:', recError.message);
    throw new BroadcastError('internal', 'Failed to load recipients', 500);
  }

  const rows = (rawRows ?? []) as RecipientRow[];

// A recipient with nothing to send to can never send. Stamp it failed now:
// leaving it 'pending' would keep the broadcast in 'sending' forever, which
// is the very symptom being fixed.
  const sendable: RecipientRow[] = [];
  const unsendable: string[] = [];
  /** Recipient row id -> the exact destination approved for it. */
  const addressByRowId = new Map<string, string>();

  // The single resolution pipeline, shared verbatim with the creation
  // endpoint. Phases: identity columns, then a batched fallback to each
  // contact's own inbound history, then the deliverability check - awaited
  // before any recipient is dispatched.
  const addressByContactId = await resolveRecipientAddresses(
    db,
    rows
      .map((row): RecoverableContact | null => {
        const c = contactIdentity(row);
        // `id` is taken from the RECIPIENT's own `contact_id`, not from the
        // projected contact. The history fallback scopes its read by contact
        // id, so that is the key it must be handed; relying on the projection
        // to carry a matching `id` silently dropped every recipient whose
        // contact object arrived without one, which reads as "no address"
        // and fails the whole campaign.
        return c ? { ...c, id: row.contact_id } : null;
      })
      .filter((c): c is RecoverableContact => Boolean(c?.id)),
  );

  // Newest inbound wamid per contact on this page, for the same per-recipient
  // quote anchor a fresh broadcast uses. A wamid belongs to one conversation,
  // so this is keyed by contact and never shared across recipients.
  const anchors = await recoverContextMessageIds(
    db,
    rows
      .map((row) => contactIdentity(row)?.id)
      .filter((id): id is string => Boolean(id)),
  ).catch(() => new Map<string, string>());

  for (const row of rows) {
    const address = row.contact_id
      ? addressByContactId.get(row.contact_id) ?? null
      : null;
    if (address) {
      sendable.push(row);
      // Kept so the plan below cannot resolve a different destination than
      // the one this gate approved.
      addressByRowId.set(row.id, address.to);
    } else unsendable.push(row.id);
  }
  if (unsendable.length > 0) {
    await db
      .from('broadcast_recipients')
      .update({
        status: 'failed',
        error_message: NO_DELIVERABLE_ADDRESS,
      })
      .in('id', unsendable);
  }

  const slice = sendable.slice(0, RESUME_MAX_PER_REQUEST);
  const remaining = sendable.length - slice.length;

  if (slice.length === 0) {
    throw new BroadcastError(
      'nothing_to_resume',
      scope === 'failed'
        ? 'This broadcast has no failed recipients to retry'
        : 'This broadcast has no recipients left to send',
      400
    );
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();
  if (configError || !config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    broadcast.template_name,
    broadcast.template_language
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before resuming.',
      500
    );
  }

  // `broadcasts.user_id` is NOT NULL (migration 001), so this is always a real
  // owner. Coerced rather than defaulted: a missing one would have to become
  // `conversations.user_id = NULL` on a thread this pass is about to open,
  // and the mirror would then drop the delivered message.
  const auditUserId = String(
    (broadcast as { user_id?: string | null }).user_id ?? '',
  );
  if (!auditUserId) {
    throw new Error(
      `Broadcast ${broadcastId} has no user_id; cannot resume without a thread owner`,
    );
  }

  const plan: BroadcastPlan = {
      broadcastId,
      templateName: broadcast.template_name,
      templateLanguage: resolvedTemplate.language,
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      accountId,
      auditUserId,
      templateRow: resolvedTemplate.row,
    planned: slice.map((row) => ({
      recipientRowId: row.id,
      contactId: row.contact_id,
      // Forwarded verbatim. `sanitizePhoneForMeta` used to be applied here,
      // which stripped a BSUID to bare digits and an @handle to whatever few
      // digits it contained — addressing a different recipient than the one
      // resolved, or an invalid parameter to Meta.
      //
      // Read back from the map computed during the sendable gate instead of
      // re-resolving: this call had no `recovered`, so a recipient admitted by
      // the history tier was then handed an EMPTY destination here and the
      // send targeted nobody while still being marked sent.
      phone: addressByRowId.get(row.id) ?? '',
      // Same anchor a fresh broadcast carries, so a resumed campaign does not
      // quietly change how the message renders halfway through.
      ...(anchors.get(row.contact_id)
        ? { contextMessageId: anchors.get(row.contact_id)! }
        : {}),
      params: Array.isArray(row.template_params)
        ? row.template_params.filter((p): p is string => typeof p === 'string')
        : [],
    })),
    rejected: 0,
  };

  return { plan, remaining, unsendable: unsendable.length };
}

/**
 * Put the broadcast back into `sending` for the duration of the pass,
 * so the detail page reads as in-flight rather than as a finished
 * campaign that is quietly still working.
 */
export async function markBroadcastSending(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  await db
    .from('broadcasts')
    .update({ status: 'sending', updated_at: new Date().toISOString() })
    .eq('id', broadcastId);
}
