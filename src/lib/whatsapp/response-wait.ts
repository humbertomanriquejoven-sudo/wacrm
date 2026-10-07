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
//   * AUTO-ARM ON SEND — SWITCH-GATED: `armResponseWaitIfIdle` is called
//     right after ANY outbound (agent or bot/AI) message is persisted. It
//     NO-OPS while `conversations.response_wait_enabled` is OFF (the Timer
//     2 switch), so "Esperar respuesta" only auto-starts when the agent
//     left the feature ON for this chat. When ON it starts the countdown
//     immediately ("en cuanto enviamos un mensaje"), continues an active
//     countdown without restarting it, and arms with the chat's last-used
//     duration after the customer replied (or 10 min by default).
//   * ON EXPIRY — SINGLE EXECUTION (one-shot): while the customer stays
//     silent the runner sends ONE contextual follow-up and then closes the
//     row as `completed` AND flips the Timer 2 switch OFF — a finished
//     cycle strictly never re-enters a loop. The agent's ↻ Reiniciar (or
//     re-enabling the switch) is what starts a fresh cycle. The only ways
//     OUT of `active` are a customer reply (webhook cancel → `cancelled`)
//     or a nudge that failed to dispatch (`no_response`).
//   * Timer 2 is NOT gated by `conversations.follow_up_enabled`: that
//     switch belongs to Timer 1 (automation). The wait timer has its OWN
//     independent switch and must fire even when the automation switch is
//     off. The process kill switch (`FOLLOW_UP_ENABLED=false`) still wins.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { hasPublicUserHandle } from '@/lib/whatsapp/phone-utils'

/** Terminal states that close an ACTIVE wait timer. */
export type ResponseWaitStatus =
  | 'active'
  | 'processing'
  | 'completed'
  | 'cancelled'
  | 'no_response'

/**
 * Read a contact's identity fields and decide whether it has a PUBLIC user
 * handle (`@user` / `@username` / `@lid`) — the only contacts automation is
 * allowed to message.
 *
 * FAIL-CLOSED on purpose: a missing row or a read error returns `false`,
 * because the only consequence is "skip this automated send". That is the
 * safe direction when the rule is that no automated message may target a
 * non-@user contact — unlike the switch checks elsewhere in this codebase,
 * which fail OPEN because their `false` would silently disable a feature.
 * This lives HERE (not in the runner) so both the worker's schedulers and
 * the auto-arm (which the send core imports independently) can share it
 * without a circular import. Never throws.
 */
export async function contactHasPublicHandle(
  db: SupabaseClient,
  contactId: string,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('contacts')
      .select('username, phone, wa_id, wa_user_id, recipient_id')
      .eq('id', contactId)
      .maybeSingle()
    if (error || !data) {
      console.warn(
        `[response-wait] could not read contact ${contactId} identity (${error?.message ?? 'no row'}); treating as no public handle.`,
      )
      return false
    }
    return hasPublicUserHandle(data as {
      username?: string | null
      phone?: string | null
      wa_id?: string | null
      wa_user_id?: string | null
      recipient_id?: string | null
    })
  } catch (err) {
    console.warn(
      `[response-wait] contact ${contactId} identity read threw (${err instanceof Error ? err.message : err}); treating as no public handle.`,
    )
    return false
  }
}

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
  reason: 'already_active' | 'armed' | 'disabled' | 'not_handle' | 'error'
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
      .in('status', ['active', 'processing'])
    if (error) {
      // Migration 065 pending (column missing): fall back to the legacy
      // two-field update so cancels still work on an un-migrated DB.
      if (/column .* does not exist|42703|PGRST204|schema cache/i.test(error.message)) {
        const { error: legacyErr } = await db
          .from('response_wait_timers')
          .update({ status: 'cancelled' })
          .eq('conversation_id', conversationId)
          .in('status', ['active', 'processing'])
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
 * AUTO-ARM ON SEND — start Timer 2 the moment an OUTBOUND message is
 * persisted ("en cuanto enviamos un mensaje, agente o bot"), without
 * waiting for the agent to press any button. GATED by the conversation's
 * Timer 2 ON/OFF switch (`conversations.response_wait_enabled`): while it
 * is OFF the auto-arm is a strict no-op (`reason: 'disabled'`) — the
 * countdown only starts when the agent turns the "Esperar respuesta"
 * switch ON.
 *
 * Semantics ("comienza/continúa", strictly per conversation, no stacking):
 *   1. If the Timer 2 switch is OFF for this chat → DO NOTHING (disabled).
 *      A missing column (migration 066 pending) is treated as ON so an
 *      un-migrated database keeps its current behaviour.
 *   2. If an ACTIVE countdown already exists → DO NOTHING (continue). A
 *      second message mid-wait keeps the same countdown; it never
 *      restarts, never stacks a parallel timer.
 *   3. Otherwise arm from the chat's LAST-USED `delay_minutes` (the value
 *      the agent assigned to THIS conversation — survives reloads and chat
 *      switches) or `ARM_DEFAULT_MINUTES` if the chat never used Timer 2.
 *
 * The inbound webhook (`cancelResponseWaitTimers`) stops the countdown the
 * instant the customer replies; the switch stays ON and the next outbound
 * auto-arms it again. Never throws — a failure must never fail the
 * message send itself.
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
    // Timer 2 ON/OFF switch gate. Missing column (066 pending) → enabled.
    const { data: convRow } = await db
      .from('conversations')
      .select('response_wait_enabled')
      .eq('id', conversationId)
      .maybeSingle()
    const switchOn = convRow?.response_wait_enabled !== false
    if (!switchOn) {
      console.log(
        `[response-wait] auto-arm skipped for conversation ${conversationId} — "Esperar respuesta" switch is OFF.`,
      )
      return { scheduled: false, reason: 'disabled', id: null, expires_at: null }
    }

    // ONLY contacts with a public @user / @lid handle may be auto-armed:
    // the automated nudge must never target a phone-only / bare-BSUID
    // contact. FAIL-CLOSED (contactHasPublicHandle).
    if (!(await contactHasPublicHandle(db, contactId))) {
      console.log(
        `[response-wait] auto-arm skipped for conversation ${conversationId} — contact ${contactId} has no public @handle.`,
      )
      return { scheduled: false, reason: 'not_handle', id: null, expires_at: null }
    }

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