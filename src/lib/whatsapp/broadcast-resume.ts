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
import { recipientAddressVariants } from '@/lib/whatsapp/phone-utils';
import {
  NO_DELIVERABLE_ADDRESS,
  recoverInboundWamids,
  resolveBroadcastAddress,
  type BroadcastAddress,
  type BroadcastIdentity,
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
        phone?: string | null;
        wa_id?: string | null;
        wa_user_id?: string | null;
        username?: string | null;
        recipient_id?: string | null;
      }
    | Array<{
        phone?: string | null;
        wa_id?: string | null;
        wa_user_id?: string | null;
        username?: string | null;
        recipient_id?: string | null;
      }>
    | null;
}

/** Supabase renders an embedded to-one join as an object or a 1-array. */
function contactIdentity(row: RecipientRow): BroadcastIdentity | null {
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
 */
function resolveRowAddress(row: RecipientRow): BroadcastAddress | null {
  return resolveBroadcastAddress(contactIdentity(row));
}

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
export async function planBroadcastResume(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  scope: ResumeScope
): Promise<ResumePlan> {
  const { data: broadcast, error: bcError } = await db
    .from('broadcasts')
    .select('id, template_name, template_language')
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (bcError || !broadcast) {
    throw new BroadcastError('not_found', 'Broadcast not found', 404);
  }

  const statuses = scopeStatuses(scope);
  const { data: rawRows, error: recError } = await db
    .from('broadcast_recipients')
    .select(
      'id, template_params, contact_id, contact:contacts(phone, wa_id, wa_user_id, username, recipient_id)'
    )
    .eq('broadcast_id', broadcastId)
    .in('status', statuses)
    // Oldest first, so repeated capped passes chew through the backlog
    // in a stable order instead of re-picking the same slice.
    .order('created_at', { ascending: true });

  if (recError) {
    console.error('[broadcast-resume] recipient load failed:', recError.message);
    throw new BroadcastError('internal', 'Failed to load recipients', 500);
  }

  const rows = (rawRows ?? []) as RecipientRow[];

  // Resolve each row once: the result decides both deliverability and
  // whether the send needs a quoted anchor.
  const resolvedById = new Map<string, BroadcastAddress>();
  for (const row of rows) {
    const resolved = resolveRowAddress(row);
    if (resolved) resolvedById.set(row.id, resolved);
  }

  // Tier C anchors, one batched lookup for the whole pass. A bare @handle is
  // deliverable only as a quoted reply, so without an inbound message from
  // this contact there is no way to reach them. Resolved here rather than in
  // the send loop so an unanchorable handle is stamped failed up front
  // instead of firing a request Meta answers with "(#100) Invalid parameter".
  const quoteIds = rows
    .filter((row) => resolvedById.get(row.id)?.needsQuote)
    .map((row) => row.contact_id);
  const wamids = await recoverInboundWamids(db, quoteIds, accountId);
  const contextByRow = new Map<string, string>();
  for (const row of rows) {
    if (!resolvedById.get(row.id)?.needsQuote) continue;
    const wamid = wamids.get(row.contact_id);
    if (wamid) contextByRow.set(row.id, wamid);
  }

  // A recipient with nothing to send to can never send. Stamp it failed now:
  // leaving it 'pending' would keep the broadcast in 'sending' forever, which
  // is the very symptom being fixed.
  const sendable: RecipientRow[] = [];
  const unsendable: string[] = [];
  for (const row of rows) {
    const resolved = resolvedById.get(row.id);
    const deliverable =
      resolved !== undefined &&
      recipientAddressVariants(resolved.to).length > 0 &&
      (!resolved.needsQuote || contextByRow.has(row.id));
    if (deliverable) sendable.push(row);
    else unsendable.push(row.id);
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

  const plan: BroadcastPlan = {
    broadcastId,
    templateName: broadcast.template_name,
    templateLanguage: resolvedTemplate.language,
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
    accountId,
    templateRow: resolvedTemplate.row,
    planned: slice.map((row) => ({
      recipientRowId: row.id,
      contactId: row.contact_id,
      // null for tiers A and B; the anchor for a tier-C handle.
      contextMessageId: contextByRow.get(row.id) ?? null,
      // Forwarded verbatim. `sanitizePhoneForMeta` used to be applied here,
      // which stripped a BSUID to bare digits and an @handle to whatever few
      // digits it contained — addressing a different recipient than the one
      // resolved, or an invalid parameter to Meta.
      phone: resolveRowAddress(row)?.to ?? '',
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
