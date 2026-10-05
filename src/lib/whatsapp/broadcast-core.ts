// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template via Meta
//                        (phone-variant retry), stamp each recipient
//                        row + the aggregate counts, finalize status.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { recoverContextMessageIds } from '@/lib/whatsapp/broadcast-address';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  recipientAddressVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import {
  resolveTemplateRow,
  templateContentText,
} from '@/lib/whatsapp/template-body';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { findOrCreateConversation } from '@/lib/conversations/get-or-create';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
  /**
   * The contact this recipient row belongs to. Carried so the fan-out can
   * mirror each send into that contact's conversation in the Inbox, and so a
   * history lookup stays scoped to the recipient's own thread.
   */
  contactId: string;
  /**
   * Newest inbound `wamid` from THIS contact, forwarded as
   * `context.message_id` so the template renders as a quoted reply. Absent
   * when the contact has never written in.
   */
  contextMessageId?: string;
}

export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  /** Owning account. Used to scope the Inbox mirror to the right thread. */
  accountId: string;
  /**
   * Creator of the campaign, stamped on any Inbox thread the mirror has to
   * open (`conversations.user_id` is NOT NULL, so the row cannot be created
   * without one). Required rather than optional so a plan that would open a
   * thread anonymously is a compile error instead of a runtime insert
   * failure that silently drops the delivered message.
   */
  auditUserId: string;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // Config (fail fast + provides the audit trail owner already resolved
  // by the caller). Meta send needs phone_number_id + decrypted token.
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
  const accessToken = decrypt(config.access_token);

  // Template row (once) for header/button components; guard a
  // malformed local row rather than N identical opaque failures.
  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    templateName,
    params.templateLanguage
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = resolvedTemplate.row;

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '');
    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: sanitized,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  // Insert the parent broadcast and its recipient rows in ONE transaction
  // (migration 037's create_broadcast_with_recipients). Previously these
  // were two separate inserts: if the recipient insert failed, the parent
  // was already persisted with status 'sending' and no recipients, leaving
  // an orphaned campaign that looked like it was sending but had no
  // delivery plan (issue #370). The function body is atomic, so a recipient
  // failure now rolls the parent back and nothing orphaned survives.
  const { data: createdRows, error: createErr } = await db.rpc(
    'create_broadcast_with_recipients',
    {
      p_account_id: accountId,
      p_user_id: auditUserId,
      p_name: name || `API broadcast (${templateName})`,
      p_template_name: templateName,
      p_template_language: resolvedTemplate.language,
      p_total_recipients: deduped.length,
      p_contact_ids: deduped.map((r) => r.contactId),
      // Frozen per-recipient params (migration 038) — without them a
      // resume of this broadcast has no way to reconstruct {{1}}.
      p_template_params: deduped.map((r) => r.params),
    }
  );
  if (createErr || !createdRows || createdRows.length === 0) {
    console.error('[broadcast-core] create broadcast error:', createErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const broadcastId = createdRows[0].broadcast_id as string;

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));

  // Newest inbound wamid per contact, so each template can be anchored to the
  // message its own recipient wrote. Best-effort: a failure here costs the
  // quote preview, not the delivery, so it must never fail the broadcast.
  const anchors = await recoverContextMessageIds(
    db,
    createdRows.map((r: { contact_id: string }) => r.contact_id),
  ).catch(() => new Map<string, string>());

  const planned: PlannedRecipient[] = createdRows.map(
    (row: { recipient_id: string; contact_id: string }) => {
      const r = byContact.get(row.contact_id)!;
      const contextMessageId = anchors.get(row.contact_id);
      return {
        recipientRowId: row.recipient_id,
        phone: r.phone,
        params: r.params,
        contactId: row.contact_id,
        ...(contextMessageId ? { contextMessageId } : {}),
      };
    }
  );

  return {
    broadcastId,
    templateName,
    templateLanguage: resolvedTemplate.language,
    phoneNumberId: config.phone_number_id,
    accessToken,
    accountId,
    // The campaign's creator owns any thread this campaign opens.
    auditUserId,
    templateRow,
    planned,
    rejected,
  };
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * (phone-variant retry) and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one failure never aborts the rest.
 * Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later Meta delivery/read
 * webhooks keep advancing them. We therefore never write those columns
 * here — only the terminal `status` — otherwise a manual value would
 * race and clobber the trigger-maintained counts.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan
): Promise<void> {
  for (const recipient of plan.planned) {
    // NOT `phoneVariants`: that helper assumes a bare number and, fed an
    // opaque id, manufactures neighbours like 'CO.01008477715690681' by
    // injecting trunk zeros. An id has exactly one form and must be sent
    // verbatim.
const variants = recipientAddressVariants(recipient.phone);
      if (variants.length === 0) continue;
      let sentMessageId: string | null = null;
      let lastError: string | null = null;

      for (const variant of variants) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: plan.phoneNumberId,
            accessToken: plan.accessToken,
            to: variant,
            templateName: plan.templateName,
            language: plan.templateLanguage,
            template: plan.templateRow ?? undefined,
            params: recipient.params,
            // Anchor the template to the newest message THIS contact wrote, so
            // the send renders as a quoted reply the way an Inbox answer does.
            // Strictly per recipient: a wamid belongs to one conversation, and
            // reusing another recipient's would put a stranger's message in
            // this chat. Omitted when the contact has never written in, which
            // is the normal case for a cold list — the send then proceeds
            // unquoted, since the anchor is presentational.
            contextMessageId: recipient.contextMessageId,
          });
        sentMessageId = result.messageId;
        lastError = null;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        lastError = message;
        // Only a "recipient not allowed" error is worth another variant.
        if (!isRecipientNotAllowedError(message)) break;
      }
    }

    if (sentMessageId) {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: sentMessageId,
          error_message: null,
        })
        .eq('id', recipient.recipientRowId);

      await mirrorBroadcastSendToInbox(db, plan, recipient, sentMessageId);
    } else {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: lastError || 'Unknown error',
        })
        .eq('id', recipient.recipientRowId);
    }
  }

  await finalizeBroadcastStatus(db, plan.broadcastId);
}

/**
 * Mirror one successful broadcast send into the recipient's own conversation,
 * so the campaign shows up in the Inbox like any other message.
 *
 * Generic by construction: nothing here is keyed to a particular contact,
 * number or identifier. The conversation is located by `contact_id`, which
 * is what makes it work for a BSUID recipient and an E.164 recipient alike —
 * their only difference is the string handed to Meta, already resolved by
 * `resolveBroadcastAddress` before this runs.
 *
 * Best-effort, like the rest of the fan-out: Meta already accepted the
 * message, so a DB failure here must never be reported as a send failure or
 * re-queued for a duplicate send. The row is written under the campaign's
 * own (account_id, contact_id) pairing, so a replayed resume cannot write a
 * second copy into another account's thread.
 */
async function mirrorBroadcastSendToInbox(
  db: SupabaseClient,
  plan: BroadcastPlan,
  recipient: PlannedRecipient,
  sentMessageId: string
): Promise<void> {
  try {
    // Find the thread, or OPEN one.
    //
    // This used to look the conversation up and, when there was none, log a
    // warning and return without mirroring. That is exactly the cold-start
    // case a campaign is made of: contacts who have never written in have no
    // thread, so every one of them delivered successfully on WhatsApp and then
    // vanished from the Inbox. The campaign was invisible in the product that
    // manages it.
    //
    // Keyed by `contact_id`, so a contact known only by an `@user` handle or a
    // BSUID gets a thread exactly like a dialable one - a missing phone number
    // must never abort the mirror.
    const found = await findOrCreateConversation(db, {
      accountId: plan.accountId,
      ownerUserId: plan.auditUserId,
      contactId: recipient.contactId,
    });

    if (!found) {
      // Only reachable when the thread can be neither found nor opened —
      // `conversations.user_id` is NOT NULL, so a campaign with no resolvable
      // audit user cannot create one. An existing thread always resolves.
      console.error(
        `[broadcast] sent to Meta but no conversation could be resolved or created for contact ${recipient.contactId}; not mirrored`,
      );
      return;
    }

    if (found.created) {
      console.log(
        `[broadcast] opened a conversation for contact ${recipient.contactId} (campaign ${plan.broadcastId}) so the send appears in the Inbox`,
      );
    }

    const conversationId = found.conversation.id;

    // The template body is rendered with THIS recipient's frozen params, so
    // the Inbox shows the message the contact actually received.
    const contentText =
      templateContentText(plan.templateRow, recipient.params) ??
      `[template:${plan.templateName}]`;

    const sentAt = new Date().toISOString();

    // `direction` and `metadata` are NOT columns on `messages`: inbound vs
    // outbound is `sender_type`, and the template's components have no
    // column of their own. Naming either here would make PostgREST reject
    // the insert with 42703 and silently unmirror every send.
    //
    // Upserted on (conversation_id, message_id) - the same conflict target the
    // inbound webhook uses. A plain insert violated
    // `idx_messages_conversation_message_id` whenever a resumed campaign
    // re-sent the same wamid, failing the whole mirror on a replay.
    const { error } = await db
      .from('messages')
      .upsert(
        {
          conversation_id: conversationId,
          sender_type: 'agent',
          content_type: 'template',
          content_text: contentText,
          template_name: plan.templateName,
          message_id: sentMessageId,
          status: 'sent',
          // The send instant, so the campaign bubble sorts against inbound
          // messages by when it actually happened rather than by when this
          // mirror row happened to be written. The inbound path does the same
          // with Meta's timestamp.
          created_at: sentAt,
        },
        { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
      );

    if (error) {
      console.error(
        `[broadcast] sent to Meta but Inbox insert failed for contact ${recipient.contactId}:`,
        error.message,
      );
      return;
    }

    await db
      .from('conversations')
      .update({
        last_message_text: contentText,
        last_message_at: sentAt,
        updated_at: sentAt,
      })
      .eq('id', conversationId);
  } catch (error) {
    console.error(
      '[broadcast] Inbox mirror threw after a successful send:',
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 *
 * Derived from the recipient rows rather than from a counter local to
 * one delivery pass: a resume (issue #472) delivers only the leftovers,
 * so "nothing sent *this* pass" must not mark a campaign failed when
 * 800 of its 1 000 recipients went out earlier. `failed` means every
 * single recipient failed; anything else that reached Meta is `sent`,
 * with the per-recipient failures visible in `failed_count`.
 *
 * Per-status counts stay trigger-owned (migrations 003/005) — only the
 * terminal `status` is written here.
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const countWhere = async (status: string): Promise<number> => {
    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', status);
    return count ?? 0;
  };

  // Still work outstanding (a capped resume pass) — leave it 'sending'
  // so the UI keeps offering Resume.
  if ((await countWhere('pending')) > 0) return;

  const failed = await countWhere('failed');
  const { count: total } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);

  await db
    .from('broadcasts')
    .update({
      status: failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId);
}

/**
 * Persist a campaign and its recipients WITHOUT sending anything.
 *
 * This is the wizard's new first phase. It exists because the previous flow
 * drove the fan-out from the browser tab: the campaign rows were committed by
 * the client and the sends ran in the same tab, so a closed tab left rows
 * `pending` with no record of what should have been sent, and the only remedy
 * was a manual "Retry failed".
 *
 * Recipients are keyed by `contact_id`, not by a phone number. `createBroadcast`
 * above cannot be reused for this: it validates every `to` with `isValidE164`
 * and drops anything else, which is exactly the population this wizard targets
 * - contacts whose number is hidden behind a BSUID.
 *
 * Everything is written as `pending` (recipients) and `draft` (campaign). No
 * status here claims any progress: `pending` is the honest state of a message
 * nobody has asked Meta to send yet, and `deliverBroadcast` is what advances
 * it to `sent`, and only after Meta returns a wamid.
 */
export async function persistBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: PersistBroadcastParams
): Promise<{ broadcastId: string; total: number; duplicates: number }> {
  const {
    name,
    templateName,
    templateLanguage,
    templateVariables,
    audienceFilter,
    recipients,
  } = params;

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { contact_id, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // A contact repeated in the audience would be messaged twice, and a
  // WhatsApp message cannot be recalled. Collapse on contact id, keeping the
  // first occurrence so its params win.
  const byContact = new Map<string, string[]>();
  let duplicates = 0;
  for (const r of recipients) {
    const contactId =
      typeof r?.contactId === 'string' ? r.contactId.trim() : '';
    if (!contactId) {
      throw new BroadcastError(
        'bad_request',
        'every recipient needs a contact_id',
        400
      );
    }
    if (byContact.has(contactId)) {
      duplicates++;
      continue;
    }
    byContact.set(
      contactId,
      Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : []
    );
  }

  const { data: broadcast, error: broadcastError } = await db
    .from('broadcasts')
    .insert({
      user_id: auditUserId,
      account_id: accountId,
      name: name ?? null,
      template_name: templateName,
      template_language: templateLanguage ?? 'en_US',
      // The mapping the wizard was built with. The resolved values live in
      // each recipient's `template_params`; this keeps how they were derived.
      template_variables: templateVariables ?? null,
      audience_filter: audienceFilter ?? null,
      // `draft`, not `sending`: nothing has been dispatched yet, and the
      // dispatch pass moves this to `sending` once it holds the lock.
      status: 'draft',
      total_recipients: byContact.size,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    })
    .select('id')
    .single();

  if (broadcastError || !broadcast) {
    throw new BroadcastError(
      'persist_failed',
      `Could not create the broadcast: ${broadcastError?.message ?? 'unknown error'}`,
      500
    );
  }

  const broadcastId = broadcast.id as string;
  const rows = [...byContact.entries()].map(([contactId, params]) => ({
    broadcast_id: broadcastId,
    contact_id: contactId,
    status: 'pending' as const,
    template_params: params,
  }));

  for (let i = 0; i < rows.length; i += MAX_RECIPIENTS) {
    const { error } = await db
      .from('broadcast_recipients')
      .insert(rows.slice(i, i + MAX_RECIPIENTS));
    if (error) {
      // Do not leave a campaign with no recipients behind: it would render as
      // an empty campaign and be resumable forever.
      await db
        .from('broadcasts')
        .delete()
        .eq('id', broadcastId)
        .eq('account_id', accountId);
      throw new BroadcastError(
        'persist_failed',
        `Could not save the recipient list: ${error.message}`,
        500
      );
    }
  }

  return { broadcastId, total: byContact.size, duplicates };
}

export interface PersistBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  /** The wizard's placeholder mapping, kept for the record. */
  templateVariables?: Record<string, unknown> | null;
  audienceFilter?: Record<string, unknown> | null;
  recipients: Array<{ contactId: string; params?: string[] }>;
}