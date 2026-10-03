import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { findMergeableOrphan, mergeContactInto } from '@/lib/contacts/merge';
import {
  AWAITING_PHONE_NOTICE,
  flushPendingReplies,
} from '@/lib/whatsapp/pending-reply';
import { toDialable } from '@/lib/whatsapp/recipient-resolver';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';

/**
 * Record a contact's real phone number.
 *
 * Exists because the whole "bot can't answer" failure ends here. When Meta
 * identifies a sender only by BSUID, the contact has no usable address and
 * every reply is rejected; the reply is parked on the conversation with a
 * visible notice. This endpoint is where an operator supplies the missing
 * number, and it does three things in one call:
 *
 *   1. writes the number (normalised to digits so it matches whatever
 *      Meta sends next time);
 *   2. folds in any orphan contact that belonged to the same person, so
 *      the BSUID and the thread history land on this row;
 *   3. immediately delivers every reply that was parked waiting for it.
 *
 * Step 3 is why this is a server route rather than a direct client-side
 * Supabase update like the other contact editors use: delivering the reply
 * goes through Meta, so the flush has to run in a request that can resolve
 * the account's credentials, and a client-side write could never trigger it.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // 'agent', matching the other contact-write endpoints and the manual
    // send endpoint whose core this reuses for the deferred flush.
    const ctx = await requireRole('agent');
    const { id: contactId } = await params;

    const body = (await request.json().catch(() => null)) as {
      phone?: unknown;
    } | null;
    const rawPhone = typeof body?.phone === 'string' ? body.phone.trim() : '';

    if (!rawPhone) {
      return NextResponse.json({ error: 'phone is required' }, { status: 400 });
    }

    // Normalise to digits. A stored '+57 312…' would never equal the
    // digits Meta sends on the next inbound, so the contact would look
    // unmatched and a second row would appear.
    const phone = toDialable(rawPhone);
    if (!phone) {
      return NextResponse.json(
        { error: 'phone must be a valid E.164 number (7-13 digits)' },
        { status: 400 }
      );
    }

    // Load before writing so the merge helpers have the identity fields.
    const { data: existing, error: readErr } = await ctx.supabase
      .from('contacts')
      .select('id, account_id, phone, name, username, wa_user_id')
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (readErr) {
      return NextResponse.json({ error: readErr.message }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: 'contact not found' }, { status: 404 });
    }

    const previousPhone = existing.phone ?? null;
    if (toDialable(previousPhone) === phone) {
      // Same number in a different format. Nothing to do, but still flush:
      // the operator may be resolving a stuck notice, and the deferred
      // reply is exactly what they expect to go out.
      return NextResponse.json({
        ok: true,
        phone,
        changed: false,
        ...(await deliverParkedReplies(ctx.supabase, ctx.accountId, contactId, phone)),
      });
    }

    const { error: updateErr } = await ctx.supabase
      .from('contacts')
      .update({ phone, updated_at: new Date().toISOString() })
      .eq('id', contactId)
      .eq('account_id', ctx.accountId);

    if (updateErr) {
      // The per-account unique index on phone_normalized (migration 022)
      // is the backstop against two contacts sharing a number.
      if (isUniqueViolation(updateErr)) {
        return NextResponse.json(
          {
            error:
              'Another contact in this account already uses that phone number',
          },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // Re-read so the merge sees the number we just wrote.
    const { data: updated } = await ctx.supabase
      .from('contacts')
      .select('id, account_id, phone, name, username, wa_user_id')
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    let merged = false;
    if (updated) {
      const orphan = await findMergeableOrphan(
        ctx.supabase,
        ctx.accountId,
        updated as Parameters<typeof findMergeableOrphan>[2]
      );
      if (orphan) {
        const outcome = await mergeContactInto(ctx.supabase, {
          accountId: ctx.accountId,
          survivorId: contactId,
          orphanId: orphan.id,
        });
        merged = outcome.merged;
        if (!outcome.merged && outcome.reason) {
          console.warn(
            `[contacts/${contactId}] phone saved but the merge did not run:`,
            outcome.reason
          );
        }
      }
    }

    console.log(
      `[contacts/${contactId}] phone updated ${previousPhone ?? '(none)'} → ${phone}` +
        (merged ? ' (orphan contact merged in)' : '')
    );

    return NextResponse.json({
      ok: true,
      phone,
      changed: true,
      merged,
      ...(await deliverParkedReplies(ctx.supabase, ctx.accountId, contactId, phone)),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Send everything that was parked for this contact, now that it has a
 * real number.
 *
 * Failures are reported rather than thrown: the phone save already
 * succeeded, and answering 500 would make the UI claim the number was not
 * saved. A failed flush leaves the reply parked for the next attempt.
 */
async function deliverParkedReplies(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  phone: string
) {
  const result = await flushPendingReplies({
    db,
    accountId,
    contactId,
    phone,
    send: async (conversationId, text) => {
      // Reuses the same core as the manual send endpoint, so a deferred
      // reply is persisted, flow-paused and rendered exactly like one an
      // agent typed by hand.
      await sendMessageToConversation(db, accountId, {
        conversationId,
        messageType: 'text',
        contentText: text,
      });
    },
  });

  if (result.sent > 0) {
    console.log(
      `[contacts/${contactId}] delivered ${result.sent} deferred repl${result.sent === 1 ? 'y' : 'ies'} to ${phone}`
    );
  } else if (result.failed > 0) {
    console.warn(
      `[contacts/${contactId}] ${result.failed} deferred repl${result.failed === 1 ? 'y' : 'ies'} still undeliverable to ${phone}`
    );
  }

  return {
    pending_replies_sent: result.sent,
    pending_replies_failed: result.failed,
    pending_conversations: result.conversations,
    notice: AWAITING_PHONE_NOTICE,
  };
}