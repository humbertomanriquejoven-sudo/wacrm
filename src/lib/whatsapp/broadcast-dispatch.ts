// ============================================================
// The single delivery pass for a broadcast.
//
// Both entry points call this and nothing else:
//
//   - the creation endpoint, right after `persistBroadcast` commits the
//     campaign and its `pending` recipients;
//   - "Resume" / "Retry failed" on an existing campaign.
//
// They used to be separate code paths, which is how a campaign could fail on
// its first attempt and then go through on every retry: the two passes
// resolved addresses differently. Here they cannot, because there is only one
// pass to run.
//
// Order matters and is not incidental:
//
//   claim -> plan -> mark 'sending' -> fan out in after()
//
// The claim is a single conditional UPDATE, so two callers - a double click on
// Retry, or a Retry fired while creation's own pass is still running - cannot
// both build a plan from the same `pending` rows. Without it they would each
// message everyone, and a WhatsApp message cannot be recalled.
//
// The fan-out is handed to `run` (Next's `after()`) rather than awaited, so the
// caller can answer immediately and the browser polls for progress. `run` is
// injected for exactly that reason: tests pass a synchronous executor and get a
// deterministic pass with no serverless lifecycle involved.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  deliverBroadcast,
  finalizeBroadcastStatus,
  type BroadcastPlan,
} from './broadcast-core';
import {
  claimBroadcastDelivery,
  markBroadcastSending,
  planBroadcastResume,
  releaseBroadcastDelivery,
  type ResumeScope,
} from './broadcast-resume';

export interface BroadcastDispatchResult {
  broadcastId: string;
  scope: ResumeScope;
  /** Recipients this pass will attempt. */
  resuming: number;
  /** Recipients left for a further pass, because the pass hit its cap. */
  remaining: number;
  /** Recipients stamped failed up front for want of a deliverable address. */
  unsendable: number;
}

/**
 * Claim, plan and schedule one delivery pass.
 *
 * `scoped` is the caller's account-scoped client: it is what proves the
 * broadcast belongs to the caller before anything is planned. `admin` is the
 * service-role client, used only for the fan-out itself, which outlives the
 * request and must not depend on the user's session.
 *
 * Returns `null` when another pass already holds the claim, which callers
 * surface as 409 rather than starting a second fan-out.
 */
export async function dispatchBroadcastDelivery(
  scoped: SupabaseClient,
  admin: SupabaseClient,
  accountId: string,
  broadcastId: string,
  scope: ResumeScope,
  run: (task: () => Promise<void>) => void
): Promise<BroadcastDispatchResult | null> {
  const claimed = await claimBroadcastDelivery(scoped, accountId, broadcastId);
  if (!claimed) return null;

  let plan: BroadcastPlan;
  let result: Omit<BroadcastDispatchResult, 'broadcastId' | 'scope'>;
  try {
    const planned = await planBroadcastResume(
      scoped,
      accountId,
      broadcastId,
      scope
    );
    plan = planned.plan;
    result = {
      resuming: planned.plan.planned.length,
      remaining: planned.remaining,
      unsendable: planned.unsendable,
    };
  } catch (error) {
    // Planning failed after the claim: release it, or the campaign stays
    // locked out of delivering until the staleness window expires.
    await releaseBroadcastDelivery(scoped, broadcastId).catch(() => {});
    throw error;
  }

  // Only now, with a plan in hand and the rows known-good, does the campaign
  // read as in-flight. Nothing before this point reports progress.
  await markBroadcastSending(scoped, broadcastId);

  run(async () => {
    try {
      await deliverBroadcast(admin, plan);
    } catch (error) {
      console.error(
        '[broadcast-dispatch] delivery threw:',
        error instanceof Error ? error.message : error
      );
      // Do not leave it mid-flight - settle whatever did land.
      await finalizeBroadcastStatus(admin, broadcastId).catch(() => {});
    } finally {
      await releaseBroadcastDelivery(admin, broadcastId);
    }
  });

  return { broadcastId, scope, ...result };
}
