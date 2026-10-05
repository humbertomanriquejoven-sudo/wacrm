// ============================================================
// POST /api/whatsapp/broadcast/[id]/resume   (issue #472)
//
// "Resume" / "Retry failed". Runs the same `dispatchBroadcastDelivery` pass the
// creation endpoint runs - see that module for the claim/plan/mark/fan-out
// order and why the claim has to come first.
//
// Responds 202 as soon as the pass is claimed and planned; the fan-out runs in
// `after()`. Poll the broadcast row for progress.
// ============================================================

import { NextResponse, after } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import { dispatchBroadcastDelivery } from '@/lib/whatsapp/broadcast-dispatch';
import { RESUME_SCOPES, type ResumeScope } from '@/lib/whatsapp/broadcast-resume';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

// The fan-out below is sequential over up to 1 000 recipients.
export const maxDuration = 300;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Same gate as the send endpoint: running a broadcast is a write, and
    // viewers are read-only. Resuming is no different - it puts real messages
    // on real phones.
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(
      `broadcast-resume:${userId}`,
      RATE_LIMITS.broadcast
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const scope: ResumeScope = RESUME_SCOPES.includes(body?.scope)
      ? body.scope
      : 'pending';

    // Null means another pass holds the claim: a double click on Retry, or a
    // Retry fired while creation's own pass is still running. Both would build
    // a plan from the same rows and message everyone twice.
    const dispatch = await dispatchBroadcastDelivery(
      supabase,
      supabaseAdmin(),
      accountId,
      id,
      scope,
      after
    );

    if (!dispatch) {
      return NextResponse.json(
        {
          error:
            'A delivery pass is already running for this broadcast. Wait for it to finish before resuming again.',
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        broadcast_id: id,
        scope,
        resuming: dispatch.resuming,
        // > 0 when the backlog exceeded one pass's cap; the UI offers
        // Resume again rather than silently dropping them.
        remaining: dispatch.remaining,
        // Recipients stamped failed up front for want of a deliverable address.
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
    console.error('Error in broadcast resume POST:', error);
    return toErrorResponse(error);
  }
}
