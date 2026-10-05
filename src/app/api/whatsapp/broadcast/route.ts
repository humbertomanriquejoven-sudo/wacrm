// ============================================================
// POST /api/whatsapp/broadcast   (the dashboard wizard)
//
// Creates a campaign and hands delivery to the server. It does NOT send
// anything itself: `persistBroadcast` commits the campaign with every
// recipient `pending`, then `dispatchBroadcastDelivery` runs the very same
// pass "Retry failed" runs. Answers 202 immediately; the fan-out continues in
// `after()` and the UI polls the broadcast row for progress.
//
// This used to fan out from the browser tab. Two consequences are gone with it:
// a closed tab no longer strands recipients in `pending`, and the first
// attempt can no longer resolve an address differently than a retry does -
// there is only one implementation of that decision now.
//
// Recipients are `contact_id`s, not phone numbers. The wizard's audience
// includes contacts whose number is hidden behind a BSUID, and a number-shaped
// `to` would reject exactly those.
// ============================================================

import { NextResponse, after } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { BroadcastError, persistBroadcast } from '@/lib/whatsapp/broadcast-core';
import { dispatchBroadcastDelivery } from '@/lib/whatsapp/broadcast-dispatch';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

// The fan-out below is sequential over up to 1 000 recipients.
export const maxDuration = 300;

interface CreateBody {
  name?: string | null;
  template_name?: string;
  template_language?: string | null;
  template_variables?: Record<string, unknown> | null;
  audience_filter?: Record<string, unknown> | null;
  recipients?: Array<{ contact_id?: string; params?: string[] }>;
}

export async function POST(request: Request) {
  try {
    // Sending is a write, and viewers are read-only.
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(
      `broadcast-send:${userId}`,
      RATE_LIMITS.broadcast
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => ({}))) as CreateBody;

    const { broadcastId, total, duplicates } = await persistBroadcast(
      supabase,
      accountId,
      userId,
      {
        name: body?.name ?? null,
        templateName: body?.template_name ?? '',
        templateLanguage: body?.template_language ?? null,
        templateVariables: body?.template_variables ?? null,
        audienceFilter: body?.audience_filter ?? null,
        recipients: (body?.recipients ?? []).map((r) => ({
          contactId: r?.contact_id ?? '',
          params: r?.params,
        })),
      }
    );

    // Everything above is committed by the time this runs, so the planner
    // reads rows that already exist - the race the browser-driven flow had.
    const dispatch = await dispatchBroadcastDelivery(
      supabase,
      supabaseAdmin(),
      accountId,
      broadcastId,
      'pending',
      after
    );

    if (!dispatch) {
      return NextResponse.json(
        {
          error:
            'A delivery pass is already running for this broadcast. Wait for it to finish before sending again.',
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        broadcast_id: broadcastId,
        total,
        // Contacts the audience listed twice; they were collapsed so nobody is
        // messaged twice. Surfaced rather than hidden.
        duplicates,
        resuming: dispatch.resuming,
        remaining: dispatch.remaining,
        unsendable: dispatch.unsendable,
      },
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof BroadcastError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    console.error('Error in broadcast POST:', error);
    return toErrorResponse(error);
  }
}
