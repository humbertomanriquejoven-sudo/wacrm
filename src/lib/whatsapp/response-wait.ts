// ============================================================
// TIMER 2 — RESPONSE-WAIT TIMERS (per conversation, auto-cancelable).
// ============================================================
// While Timer 1 (`follow_ups`) is the "remind later" queue, Timer 2
// (`response_wait_timers`) counts how long the agent wants to wait after
// the last outbound message before the system nudges the customer again.
//
// This module owns ALL of Timer 2's database logic so BOTH the inbox
// (route + banner), the inbound webhook, and the outbound send core can
// share it WITHOUT a circular import (the send core is imported by the
// follow-up worker, so the wait logic must not live in the worker).
//
// RULES:
//   * ONE ACTIVE row per conversation — Set/Start, Reset, and the
//     send-triggered auto-arm all UPSERT/reuse the single ACTIVE row
//     (or insert when none is active), so a conversation can never hold
//     two overlapping countdowns and a Reset can never produce a
//     duplicated send.
//   * PURELY per-conversation: every row is bound to `conversation_id`
//     (plus denormalized contact/account), and every door is keyed on the
//     conversation. `expires_at` is persisted, so the UI renders the
//     LIVE remainder `expires_at - NOW()` — switching chats or reloading
//     the page can never reset, resume, or cross-contaminate a countdown.
//   * AUTO-CANCEL BY REPLY (critical): the moment a REAL customer message
//     lands for the conversation, the inbound webhook calls
//     `cancelResponseWaitTimers`. Independently, at dispatch time the
//     runner re-checks the thread's last message and drops the reminder
//     if the customer replied AFTER `started_at` — the race safety net.
//   * ON EXPIRY (`NOW() >= expires_at`, status still `active`,
//     customer silent): the runner generates a contextual AI follow-up
//     and sends it through the SAME core the inbox uses
//     (`sendMessageToConversation`).
//   * AUTO-ARM ON SEND: `armResponseWaitIfIdle` is called right after a
//     HUMAN agent's outbound message is persisted. It starts the countdown
//     immediately ("en cuanto enviamos un mensaje"), continues an active
//     countdown without restarting it, and re-arms with the chat's
//     last-used duration after the customer replied (or 10 min by default).
//   * Timer 2 is NOT gated by `conversations.follow_up_enabled`: that
//     switch belongs to Timer 1 (automation). The wait timer is an
//     explicit agent action and must fire even when the automation
//     switch is off. The process kill switch (`FOLLOW_UP_ENABLED=false`)
//     still wins.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

/** Terminal states that close an ACTIVE wait timer. */
export type ResponseWaitStatus = 'active' | 'completed' | 'cancelled' | 'no_response'

export interface ResponseWaitScheduleResult {
  scheduled: boolean
  reason: 'scheduled' | 'error'
  id: string | null
  expires_at: string | null
}

/**
 * Default Timer 2 duration in minutes, used when a conversation has never
 * run a wait timer (no last-used value to reuse).
 */
export const ARM_DEFAULT_MINUTES = 10

export interface ArmResponseWaitResult {
  scheduled: boolean
  reason: 'already_active' | 'armed' | 'error'
  id: string | null
  expires_at: string | null
}

/**
 * Arm (Set/Start) or re-arm (Reset) Timer 2 for a conversation.
 * UPSERTS the single ACTIVE row: an existing one is moved to the new
 * `expires_at` instead of rejected, so re-arming never stacks duplicates.
 * Never throws — the inbox shows a toast on `scheduled: false`.
 */
export async function scheduleResponseWaitTimer(
  db: SupabaseClient,
  params: {
    conversationId: string
    contactId: string
    accountId: string
    /** Whole minutes, validated by the caller. */
    delayMinutes: number
    now?: Date
  },
): Promise<ResponseWaitScheduleResult> {
  const { conversationId, contactId, accountId, delayMinutes } = params
  const now = params.now ?? new Date()
  const startedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + delayMinutes * 60_000).toISOString()

  try {
    const { data: active, error: findErr } = await db
      .from('response_wait_timers')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('status', 'active')
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!findErr && active?.id) {
      const { error: upErr } = await db
        .from('response_wait_timers')
        .update({
          delay_minutes: delayMinutes,
          started_at: startedAt,
          expires_at: expiresAt,
        })
        .eq('id', active.id as string)
        .eq('status', 'active')
      if (upErr) {
        console.error(
          `[response-wait] could not re-arm the timer for conversation ${conversationId}:`,
          upErr.message,
        )
        return { scheduled: false, reason: 'error', id: null, expires_at: null }
      }
      console.log(
        `[response-wait] timer ${active.id} re-armed for conversation ${conversationId} → ${expiresAt}.`,
      )
      return { scheduled: true, reason: 'scheduled', id: active.id as string, expires_at: expiresAt }
    }

    const { data, error: insErr } = await db
      .from('response_wait_timers')
      .insert({
        conversation_id: conversationId,
        contact_id: contactId,
        account_id: accountId,
        status: 'active',
        delay_minutes: delayMinutes,
        started_at: startedAt,
        expires_at: expiresAt,
      })
      .select('id')
      .single()
    if (insErr || !data) {
      console.error(
        `[response-wait] could not arm a timer for conversation ${conversationId}:`,
        insErr?.message ?? 'no row returned',
      )
      return { scheduled: false, reason: 'error', id: null, expires_at: null }
    }
    console.log(
      `[response-wait] timer ${data.id} armed for conversation ${conversationId} → ${expiresAt} (${delayMinutes} min).`,
    )
    return { scheduled: true, reason: 'scheduled', id: data.id as string, expires_at: expiresAt }
  } catch (err) {
    console.error(
      `[response-wait] scheduleResponseWaitTimer threw for conversation ${conversationId}:`,
      err instanceof Error ? err.message : err,
    )
    return { scheduled: false, reason: 'error', id: null, expires_at: null }
  }
}

/** Why a wait timer was cancelled (migration 065). */
export type ResponseWaitCancelReason = 'inbound' | 'anti_race' | 'manual'

/**
 * Cancel every ACTIVE response-wait timer for a conversation and record
 * WHY (one-shot bookkeeping): `inbound` (the critical rule — the customer
 * replied), `anti_race` (runner safety net), `manual` (agent action).
 *
 * Invoked by the inbound webhook the moment a REAL customer message
 * lands (the customer answered — the wait is over), and by the
 * `wait_cancel` route action. Tolerates migration 065 not yet applied by
 * retrying the legacy update without `cancelled_reason`. Never throws.
 */
export async function cancelResponseWaitTimers(
  db: SupabaseClient,
  conversationId: string,
  reason: ResponseWaitCancelReason = 'inbound',
): Promise<void> {
  try {
    const { error } = await db
      .from('response_wait_timers')
      .update({ status: 'cancelled', cancelled_reason: reason })
      .eq('conversation_id', conversationId)
      .eq('status', 'active')
    if (error) {
      // Migration 065 pending (column missing): fall back to the legacy
      // two-field update so cancels still work on an un-migrated DB.
      if (/column .* does not exist|42703|PGRST204|schema cache/i.test(error.message)) {
        const { error: legacyErr } = await db
          .from('response_wait_timers')
          .update({ status: 'cancelled' })
          .eq('conversation_id', conversationId)
          .eq('status', 'active')
        if (legacyErr) {
          console.error(
            `[response-wait] could not cancel active timers for conversation ${conversationId}:`,
            legacyErr.message,
          )
        }
        return
      }
      console.error(
        `[response-wait] could not cancel active timers for conversation ${conversationId}:`,
        error.message,
      )
      return
    }
    console.log(
      `[response-wait] cancelled active timers for conversation ${conversationId} (reason: ${reason}).`,
    )
  } catch (err) {
    console.error(
      `[response-wait] cancelResponseWaitTimers threw for conversation ${conversationId}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * AUTO-ARM ON SEND — start Timer 2 the moment an outbound HUMAN message
 * is persisted, without waiting for the agent to press ▶ Iniciar.
 *
 * Semantics ("comienza/continúa", strictly per conversation, no stacking):
 *   1. If an ACTIVE countdown already exists → DO NOTHING (continue). A
 *      second message mid-wait keeps the same countdown; it never
 *      restarts, never stacks a parallel timer.
 *   2. Otherwise arm from the chat's LAST-USED `delay_minutes` (the value
 *      the agent assigned to THIS conversation — survives reloads and chat
 *      switches) or `ARM_DEFAULT_MINUTES` if the chat never used Timer 2.
 *
 * The inbound webhook (`cancelResponseWaitTimers`) stops the countdown the
 * instant the customer replies; the next agent send re-arms it. Never
 * throws — a failure must never fail the message send itself.
 */
export async function armResponseWaitIfIdle(
  db: SupabaseClient,
  params: {
    conversationId: string
    contactId: string
    accountId: string
    now?: Date
  },
): Promise<ArmResponseWaitResult> {
  const { conversationId, contactId, accountId } = params
  const now = params.now ?? new Date()
  try {
    const { data: active } = await db
      .from('response_wait_timers')
      .select('id, expires_at')
      .eq('conversation_id', conversationId)
      .eq('status', 'active')
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (active?.id) {
      // Already counting for THIS chat — continue, never restart/duplicate.
      return {
        scheduled: false,
        reason: 'already_active',
        id: active.id as string,
        expires_at: (active.expires_at as string) ?? null,
      }
    }

    // Reuse the chat's assigned value: the most recently written row
    // (any status) carries the `delay_minutes` the agent configured.
    let minutes = ARM_DEFAULT_MINUTES
    const { data: last } = await db
      .from('response_wait_timers')
      .select('delay_minutes')
      .eq('conversation_id', conversationId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const lastMinutes = last?.delay_minutes
    if (typeof lastMinutes === 'number' && lastMinutes > 0 && lastMinutes <= 10080) {
      minutes = lastMinutes
    }

    const startedAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + minutes * 60_000).toISOString()
    const { data, error: insErr } = await db
      .from('response_wait_timers')
      .insert({
        conversation_id: conversationId,
        contact_id: contactId,
        account_id: accountId,
        status: 'active',
        delay_minutes: minutes,
        started_at: startedAt,
        expires_at: expiresAt,
      })
      .select('id')
      .single()
    if (insErr || !data) {
      console.error(
        `[response-wait] auto-arm failed for conversation ${conversationId}:`,
        insErr?.message ?? 'no row returned',
      )
      return { scheduled: false, reason: 'error', id: null, expires_at: null }
    }
    console.log(
      `[response-wait] auto-armed timer ${data.id} for conversation ${conversationId} → ${expiresAt} (${minutes} min).`,
    )
    return { scheduled: true, reason: 'armed', id: data.id as string, expires_at: expiresAt }
  } catch (err) {
    console.error(
      `[response-wait] armResponseWaitIfIdle threw for conversation ${conversationId}:`,
      err instanceof Error ? err.message : err,
    )
    return { scheduled: false, reason: 'error', id: null, expires_at: null }
  }
}