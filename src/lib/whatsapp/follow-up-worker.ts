import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { cleanRecipientAddress, getRecipientAddress } from '@/lib/whatsapp/meta-api'
import { isPlaceholderValue } from '@/lib/whatsapp/phone-utils'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply, stripInternalReasoning } from '@/lib/ai/generate'
import { buildConversationContext } from '@/lib/ai/context'
import { ARM_DEFAULT_MINUTES, cancelResponseWaitTimers } from './response-wait'

/**
 * Timer 2 (`response_wait_timers`) logic — arming, re-arming, auto-arm on
 * send, and cancel-by-reply — lives in `./response-wait` so the outbound
 * send core can auto-arm without importing this worker (no cycle). The
 * inbox route keeps importing these from here.
 */
export {
  armResponseWaitIfIdle,
  ARM_DEFAULT_MINUTES,
  cancelResponseWaitTimers,
  type ArmResponseWaitResult,
  type ResponseWaitCancelReason,
  type ResponseWaitScheduleResult,
  type ResponseWaitStatus,
} from './response-wait'

// `scheduleResponseWaitTimer` now points at the robust `rearmResponseWaitTimer`
// implementation below (an ARRAY read that always wins with the NEWEST ACTIVE
// row) instead of response-wait's `.maybeSingle()` read — so a stale duplicate
// ACTIVE row can never surface the "Could not start the 'Esperar respuesta'
// timer (error)" toast path again. Callers/tests keep the stable import name.
export const scheduleResponseWaitTimer = rearmResponseWaitTimer

/**
 * Militant re-arm for "Esperar respuesta" (Timer 2), shared by the inbox
 * route (`wait_schedule` / `wait_reset`) and the inbound-webhook reset.
 *
 * Unlike `scheduleResponseWaitTimer` (response-wait.ts) — which reads the
 * active row with `.maybeSingle()` and STOPS re-arming as soon as the same
 * conversation accumulates TWO active rows (a PostgREST "multiple (or no)
 * rows" error → `scheduled:false` → the agent sees
 * "Could not start the 'Esperar respuesta' timer (error)") — this walks the
 * NEWEST active row through an ARRAY read (`.order().limit(1)` + `[0]`), so
 * the current countdown is always the winner and a stale duplicate can never
 * wedge the endpoint again. The single-active-row invariant still holds
 * because an eventual re-arm UPDATES one exact row id.
 *
 * Never throws; every DB failure degrades to a logged `scheduled:false`.
 */
export interface RearmResponseWaitResult {
  scheduled: boolean
  reason: 'scheduled' | 'error'
  id: string | null
  expires_at: string | null
}

export async function rearmResponseWaitTimer(
  db: SupabaseClient,
  params: {
    conversationId: string
    contactId: string
    accountId: string
    /** Whole minutes (1..max), validated by the caller. */
    delayMinutes: number
    now?: Date
  },
): Promise<RearmResponseWaitResult> {
  const { conversationId, contactId, accountId, delayMinutes } = params
  const now = params.now ?? new Date()
  const startedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + delayMinutes * 60_000).toISOString()

  try {
    // NEWEST active row via an ARRAY read — a `maybeSingle` here would turn
    // a stale duplicate row into a hard, permanent `scheduled:false`.
    const { data: rows, error: findErr } = await db
      .from('response_wait_timers')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('status', 'active')
      .order('expires_at', { ascending: false })
      .limit(1)

    if (findErr) {
      console.error(
        `[response-wait] could not find the active timer for conversation ${conversationId}:`,
        findErr.message,
      )
      return { scheduled: false, reason: 'error', id: null, expires_at: null }
    }

    const newest = rows?.[0] as { id: string } | undefined
    if (newest) {
      const { error: upErr } = await db
        .from('response_wait_timers')
        .update({
          delay_minutes: delayMinutes,
          started_at: startedAt,
          expires_at: expiresAt,
        })
        .eq('id', newest.id)
        .eq('status', 'active')
      if (upErr) {
        console.error(
          `[response-wait] could not re-arm the timer for conversation ${conversationId}:`,
          upErr.message,
        )
        return { scheduled: false, reason: 'error', id: null, expires_at: null }
      }
      console.log(
        `[response-wait] timer ${newest.id} re-armed for conversation ${conversationId} → ${expiresAt} (${delayMinutes} min).`,
      )
      return {
        scheduled: true,
        reason: 'scheduled',
        id: newest.id,
        expires_at: expiresAt,
      }
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
    return {
      scheduled: true,
      reason: 'scheduled',
      id: data.id,
      expires_at: expiresAt,
    }
  } catch (err) {
    console.error(
      `[response-wait] rearmResponseWaitTimer threw for conversation ${conversationId}:`,
      err instanceof Error ? err.message : err,
    )
    return { scheduled: false, reason: 'error', id: null, expires_at: null }
  }
}

/**
 * Inbound-webhook reset (Timer 2): a fresh message the CUSTOMER writes
 * RESETS the countdown — the ACTIVE timer is re-armed from
 * `NOW() + N minutes` using the chat's last-used duration (or the 10-minute
 * default). A customer who keeps replying DURING an active wait never hits
 * 00:00 (the nudge waits until they truly go quiet).
 *
 * Gated on the per-chat switch (`conversations.response_wait_enabled`):
 *   - enabled  → reset/re-arm the current countdown.
 *   - disabled → the feature is OFF for the chat (either the agent turned
 *                it off OR a one-shot cycle already completed and the runner
 *                flipped the switch OFF): no reset AND any stray ACTIVE row
 *                is cancelled, so a detached timer never nudges. The cycle
 *                restarts only when the agent presses ↻ Reiniciar.
 *
 * Never throws; an unreadable row degrades to a logged no-op so the inbound
 * message itself is never blocked by a wait-timer hiccup.
 */
export async function resetResponseWaitOnInbound(
  db: SupabaseClient,
  conversationId: string,
  now?: Date,
): Promise<{ reset: boolean; reason: string; expires_at: string | null }> {
  const MISSING =
    /column .* does not exist|42703|PGRST204|schema cache|does not exist/i
  try {
    const { data, error } = await db
      .from('conversations')
      .select('id, contact_id, account_id, response_wait_enabled')
      .eq('id', conversationId)
      .maybeSingle()
    let row = (data as Record<string, unknown> | null) ?? null
    if (error && MISSING.test(error.message)) {
      // Migration for `response_wait_enabled` not applied → treat as enabled.
      const legacy = await db
        .from('conversations')
        .select('id, contact_id, account_id')
        .eq('id', conversationId)
        .maybeSingle()
      if (!legacy.error) {
        row = (legacy.data as Record<string, unknown> | null) ?? null
      }
    } else if (error) {
      console.error(
        `[response-wait] could not read conversation ${conversationId} for the inbound reset:`,
        error.message,
      )
      return { reset: false, reason: 'unreadable', expires_at: null }
    }
    if (!row) return { reset: false, reason: 'no_conversation', expires_at: null }

    const enabled =
      (row as { response_wait_enabled?: boolean }).response_wait_enabled !== false
    if (!enabled) {
      await cancelResponseWaitTimers(db, conversationId, 'manual')
      return { reset: false, reason: 'disabled', expires_at: null }
    }

    // Duration to re-arm from: the chat's last-used minutes (any prior row
    // carries the assigned value) or the shared 10-minute default.
    const last = await db
      .from('response_wait_timers')
      .select('delay_minutes')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(1)
    let delayMinutes = ARM_DEFAULT_MINUTES
    const lastRow = last.error
      ? null
      : (last.data as { delay_minutes?: number }[] | null)?.[0]
    if (
      lastRow &&
      typeof lastRow.delay_minutes === 'number' &&
      lastRow.delay_minutes > 0
    ) {
      delayMinutes = Math.floor(lastRow.delay_minutes)
    }

    const res = await rearmResponseWaitTimer(db, {
      conversationId,
      contactId: row.contact_id as string,
      accountId: row.account_id as string,
      delayMinutes,
      now,
    })
    return { reset: res.scheduled, reason: res.reason, expires_at: res.expires_at }
  } catch (err) {
    console.error(
      `[response-wait] resetResponseWaitOnInbound threw for conversation ${conversationId}:`,
      err instanceof Error ? err.message : err,
    )
    return { reset: false, reason: 'error', expires_at: null }
  }
}

/**
 * ============================================================
 * TIMED AUTO FOLLOW-UPS — 10 minutes AND 24 hours, once per stage.
 * ============================================================
 * When the auto-reply answers an inbound, `scheduleFollowUp` stores a
 * `10m` row that is due 10 minutes later. A runner (`runDueFollowUps`)
 * checks the queue on a cadence and, for each due row, applies the
 * ANTI-RACE guard: the customer must NOT have written AFTER the reminder
 * was queued. That check is time-aware (`created_at` comparison) so a
 * manual timer scheduled from the inbox still fires even though the
 * customer's message is the last one. It then reads that conversation's
 * own transcript, generates a natural follow-up with the account's AI
 * provider, and sends it through the SAME core the inbox uses for a
 * manual message (`sendMessageToConversation`), which resolves the
 * destination dynamically from the conversation's contact.
 *
 * The runner is triggered by BOTH (a) the `/api/cron/follow-ups` (or
 * legacy `/api/whatsapp/follow-ups/cron`) endpoint for external cron
 * pingers and (b) an in-process `setInterval` started by
 * `src/instrumentation.ts`, ON by default (60s) so the platform works
 * without provisioning an external scheduler. Opt out with
 * `FOLLOW_UP_WORKER_DISABLED=true` or tune with
 * `FOLLOW_UP_WORKER_INTERVAL_SECONDS`. The frontend countdown is
 * display-only and never triggers a send.
 *
 * After a 10m reminder is delivered, the runner schedules the second
 * stage: a `24h` reminder. The hard rule is ONE historical follow-up per
 * contact PER TYPE — once a contact has a `completed`/`no_response` row
 * for a given type, that type is never scheduled again. So a customer is
 * chased at most twice (10 minutes, then a day later), and only if they
 * stayed silent.
 *
 * Kill switches, checked in order: `FOLLOW_UP_ENABLED=false` (process),
 * `ai_configs.follow_up_enabled` (account), and
 * `conversations.follow_up_enabled` (per chat, NULL = inherit). Any read
 * failure fails OPEN (reminders stay on) so a missing migration or a
 * transient DB error never silently disables the feature. See
 * `isFollowUpEnabled`.
 *
 * All writes run under the service-role client (this code has no
 * `auth.uid()`), and every step is best-effort: a failing provider must
 * never take down the webhook that scheduled the follow-up, or the cron
 * that drains the queue.
 */

/** The two reminder stages, in the order they fire. */
export type FollowUpType = '10m' | '24h'

/** How far in the future the first (10-minute) stage is born. */
export const FOLLOW_UP_DELAY_MS = 10 * 60 * 1000
/** How far in the future the second (24-hour) stage is born. */
export const FOLLOW_UP_24H_DELAY_MS = 24 * 60 * 60 * 1000
/** Default cadence of the optional in-process runner (ms). */
export const FOLLOW_UP_INTERVAL_DEFAULT_MS = 60 * 1000

/** Delay for a given stage. */
export function followUpDelayMs(type: FollowUpType): number {
  return type === '24h' ? FOLLOW_UP_24H_DELAY_MS : FOLLOW_UP_DELAY_MS
}

/**
 * Terminal states that permanently close a contact's budget FOR A TYPE.
 * Once a row in one of these states exists for a type, `scheduleFollowUp`
 * refuses to schedule that type again.
 */
const TERMINAL_NO_SCHEDULE: Array<'completed' | 'no_response'> = [
  'completed',
  'no_response',
]

export interface ScheduleFollowUpResult {
  scheduled: boolean
  reason:
    | 'scheduled'
    | 'already_followed_up'
    | 'duplicate_pending'
    | 'disabled'
    | 'error'
  id: string | null
}

/**
 * Resolve whether follow-ups are enabled for a conversation.
 *
 * Precedence: the process-wide kill switch (`FOLLOW_UP_ENABLED=false`)
 * wins, then the account switch (`ai_configs.follow_up_enabled`), then
 * the per-chat override (`conversations.follow_up_enabled`, NULL =
 * inherit the account switch).
 *
 * Fail-open: any read error — including migration 063 not yet applied,
 * when the column does not exist — leaves reminders ON, preserving the
 * pre-063 behaviour. This function never throws.
 */
export async function isFollowUpEnabled(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<boolean> {
  if (process.env.FOLLOW_UP_ENABLED === 'false') return false

  try {
    const { data, error } = await db
      .from('ai_configs')
      .select('follow_up_enabled')
      .eq('account_id', accountId)
      .maybeSingle()
    if (
      !error &&
      data &&
      (data as { follow_up_enabled?: boolean | null }).follow_up_enabled === false
    ) {
      return false
    }
  } catch (err) {
    console.error(
      `[follow-up] could not read the account switch for ${accountId} (defaulting to enabled):`,
      err instanceof Error ? err.message : err,
    )
  }

  try {
    const { data, error } = await db
      .from('conversations')
      .select('follow_up_enabled')
      .eq('id', conversationId)
      .maybeSingle()
    if (
      !error &&
      data &&
      (data as { follow_up_enabled?: boolean | null }).follow_up_enabled === false
    ) {
      return false
    }
  } catch (err) {
    console.error(
      `[follow-up] could not read the per-chat switch for ${conversationId} (defaulting to enabled):`,
      err instanceof Error ? err.message : err,
    )
  }

  return true
}

/**
 * Schedule a follow-up stage for a conversation — the AUTOMATIC path of
 * Timer 1 ("Seguimiento automático").
 *
 * Timer 1 is MANUAL-ONLY: it is armed EXCLUSIVELY by the inbox
 * "+ Programar" button through `scheduleManualFollowUp` (the `schedule`
 * action). This function only ever returns `{ reason: 'disabled' }` unless
 * `force` is passed, so the AI auto-reply that answers an inbound and the
 * 10m → 24h escalation can never arm it — an inbound message must light up
 * the "Esperar respuesta" timer, never plus "Seguimiento automático".
 *
 * Never throws: this runs from inside the auto-reply path, where a
 * database hiccup on the INSERT must not surface after the customer
 * already got their answer.
 */
export async function scheduleFollowUp(
  db: SupabaseClient,
  params: {
    conversationId: string
    contactId: string
    accountId: string
    /** Reminder stage; defaults to the first one ('10m'). */
    type?: FollowUpType
    /** Override for tests; defaults to the stage's delay. */
    delayMs?: number
    now?: Date
    /**
     * Escape hatch used ONLY by tests: a forced call skips the manual-only
     * gate and drives the real scheduling internals below. The
     * account/process switch is STILL enforced, as are the historic and
     * duplicate-pending limits. Production never passes `force` — the inbox
     * "+ Programar" button arms Timer 1 through `scheduleManualFollowUp`.
     */
    force?: boolean
  },
): Promise<ScheduleFollowUpResult> {
  const { conversationId, contactId, accountId } = params
  const type: FollowUpType = params.type ?? '10m'
  const delayMs = params.delayMs ?? followUpDelayMs(type)
  const now = params.now ?? new Date()

  try {
    // TIMER 1 IS MANUAL-ONLY: it may be armed EXCLUSIVELY by the inbox
    // "+ Programar" button — which goes through `scheduleManualFollowUp`
    // (the `schedule` action), NOT this function. The automatic path that
    // answers an inbound (the AI auto-reply) and the 10m → 24h escalation
    // must NEVER arm it, or a single inbound would light up BOTH timers at
    // once. `force` is the only escape hatch, used exclusively by tests to
    // exercise the shared internals — production arms via
    // `scheduleManualFollowUp` instead.
    if (!params.force) {
      console.log(
        `[follow-up] automatic ${type} stage skipped for conversation ${conversationId} — Timer 1 is manual-only (arm via "+ Programar").`,
      )
      return { scheduled: false, reason: 'disabled', id: null }
    }

    if (!(await isFollowUpEnabled(db, accountId, conversationId))) {
      console.log(
        `[follow-up] reminders disabled for conversation ${conversationId} — not scheduling the ${type} stage.`,
      )
      return { scheduled: false, reason: 'disabled', id: null }
    }

    // A timed follow-up is a BOT message the system sends later without
    // the agent re-confirming, so it must work for ANY registered contact
    // — a phone, a `wa_id`/BSUID, a hidden id or an `@username` — because
    // the destination is resolved at SEND time by the shared ladder
    // (phone → recovered → wa_id → wa_user_id → recipient_id → username).
    // There is deliberately NO public-@handle requirement here: identity
    // lives in the contact's own row, not in a cosmetic `@user`.

    // LA REGLA: a contact who already got a follow-up OF THIS TYPE is
    // never chased again for that type — regardless of which conversation
    // it happened in. The other stage is unaffected.
    const { data: historic, error: historicErr } = await db
      .from('follow_ups')
      .select('id')
      .eq('contact_id', contactId)
      .eq('type', type)
      .in('status', [...TERMINAL_NO_SCHEDULE])
      .limit(1)
      .maybeSingle()
    if (historicErr) {
      console.error(
        `[follow-up] could not check the historic limit for contact ${contactId}:`,
        historicErr.message,
      )
      return { scheduled: false, reason: 'already_followed_up', id: null }
    }
    if (historic) {
      console.log(
        `[follow-up] contact ${contactId} already had the ${type} follow-up — refusing to schedule another of that type.`,
      )
      return { scheduled: false, reason: 'already_followed_up', id: null }
    }

    // Don't stack: one PENDING per conversation. If the customer is being
    // chased and types again meanwhile, the old pending is cancelled by
    // the webhook and this fresh message schedules the next one. A row
    // being claimed by the runner (`processing`) counts as busy too, so a
    // sweep in flight never lines up a second sender.
    const { data: pending, error: pendingErr } = await db
      .from('follow_ups')
      .select('id')
      .eq('conversation_id', conversationId)
      .in('status', ['pending', 'processing'])
      .limit(1)
      .maybeSingle()
    if (pendingErr) {
      console.error(
        `[follow-up] could not check for a pending follow-up in conversation ${conversationId}:`,
        pendingErr.message,
      )
      return { scheduled: false, reason: 'duplicate_pending', id: null }
    }
    if (pending) {
      console.log(
        `[follow-up] conversation ${conversationId} already has a pending follow-up — not scheduling another.`,
      )
      return { scheduled: false, reason: 'duplicate_pending', id: null }
    }

    const { data, error } = await db
      .from('follow_ups')
      .insert({
        conversation_id: conversationId,
        contact_id: contactId,
        account_id: accountId,
        type,
        status: 'pending',
        execute_at: new Date(now.getTime() + delayMs).toISOString(),
      })
      .select('id')
      .single()
    if (error) {
      console.error(
        `[follow-up] could not schedule the ${type} follow-up for conversation ${conversationId}:`,
        error.message,
      )
      return { scheduled: false, reason: 'duplicate_pending', id: null }
    }

    console.log(
      `[follow-up] scheduled ${type} follow-up ${data?.id} for conversation ${conversationId} in ${delayMs / 1000}s.`,
    )
    return { scheduled: true, reason: 'scheduled', id: data?.id ?? null }
  } catch (err) {
    // If the schema/database itself is unreachable (e.g. the follow_ups
    // table is missing) the reply must survive: never throw to the
    // auto-reply caller, and never treat a DB failure as a hard stop.
    console.error(
      `[follow-up] scheduleFollowUp threw for conversation ${conversationId}:`,
      err instanceof Error ? err.message : err,
    )
    return { scheduled: false, reason: 'error', id: null }
  }
}

/**
 * Whether THIS conversation may receive reminders, judged by the per-chat
 * switch ALONE (plus the process kill switch). Unlike `isFollowUpEnabled`,
 * it deliberately ignores the account-wide `ai_configs.follow_up_enabled`:
 * that switch governs AUTOMATION, while a manual timer scheduled from the
 * inbox must keep working for an agent who turned automation off globally.
 * Fail-open (missing column / read error ⇒ enabled). Never throws.
 */
export async function isConversationFollowUpEnabled(
  db: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  if (process.env.FOLLOW_UP_ENABLED === 'false') return false
  try {
    const { data, error } = await db
      .from('conversations')
      .select('follow_up_enabled')
      .eq('id', conversationId)
      .maybeSingle()
    if (
      !error &&
      data &&
      (data as { follow_up_enabled?: boolean | null }).follow_up_enabled === false
    ) {
      return false
    }
  } catch (err) {
    console.error(
      `[follow-up] could not read the per-chat switch for ${conversationId} (defaulting to enabled):`,
      err instanceof Error ? err.message : err,
    )
  }
  return true
}

/**
 * Queue or move a MANUAL reminder for a conversation, on behalf of an agent.
 *
 * Differences from `scheduleFollowUp` (the automatic path), and why they
 * matter:
 *   * It does NOT enforce the per-type historic budget. That "one per
 *     contact per type" rule exists to stop the BOT from chasing someone
 *     twice; applying it to manual schedules is exactly what produced
 *     "Couldn't schedule a follow-up for this contact" — a contact who
 *     already got its automatic reminder could never be chased by hand.
 *   * It UPSERTS: an existing PENDING row is moved to the new `execute_at`
 *     instead of rejected as `duplicate_pending`. So re-Scheduling is
 *     idempotent — one pending row per conversation, no stacking, no
 *     duplicates.
 *   * It binds purely to the conversation id, so an `@username`, a hidden
 *     / BSUID contact or any channel shape is scheduled identically. The
 *     destination is resolved later, at send time, by the shared sender.
 *
 * Never throws: the inbox shows a toast on `scheduled: false`.
 */
export async function scheduleManualFollowUp(
  db: SupabaseClient,
  params: {
    conversationId: string
    contactId: string
    accountId: string
    type?: FollowUpType
    /** Exact delay in ms; defaults to the stage's own cadence. */
    delayMs?: number
    now?: Date
  },
): Promise<ScheduleFollowUpResult> {
  const { conversationId, contactId, accountId } = params
  const type: FollowUpType = params.type ?? '10m'
  const delayMs = params.delayMs ?? followUpDelayMs(type)
  const now = params.now ?? new Date()
  const executeAt = new Date(now.getTime() + delayMs).toISOString()

  try {
    // Reuse the single pending row for this conversation, if any.
    const { data: pending, error: pendingErr } = await db
      .from('follow_ups')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .order('execute_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (!pendingErr && pending?.id) {
      const { error: upErr } = await db
        .from('follow_ups')
        .update({ execute_at: executeAt, type })
        .eq('id', pending.id as string)
        .eq('status', 'pending')
      if (upErr) {
        console.error(
          `[follow-up] could not move the pending reminder for conversation ${conversationId}:`,
          upErr.message,
        )
        return { scheduled: false, reason: 'error', id: null }
      }
      console.log(
        `[follow-up] manual reminder for conversation ${conversationId} moved to ${executeAt}.`,
      )
      return { scheduled: true, reason: 'scheduled', id: pending.id as string }
    }

    // No pending row ⇒ insert, bypassing the automatic historic budget.
    const { data, error } = await db
      .from('follow_ups')
      .insert({
        conversation_id: conversationId,
        contact_id: contactId,
        account_id: accountId,
        type,
        status: 'pending',
        execute_at: executeAt,
      })
      .select('id')
      .single()
    if (error) {
      console.error(
        `[follow-up] could not schedule a manual reminder for conversation ${conversationId}:`,
        error.message,
      )
      return { scheduled: false, reason: 'error', id: null }
    }
    console.log(
      `[follow-up] manual ${type} reminder ${data?.id} scheduled for conversation ${conversationId} in ${delayMs / 1000}s.`,
    )
    return { scheduled: true, reason: 'scheduled', id: data?.id ?? null }
  } catch (err) {
    console.error(
      `[follow-up] scheduleManualFollowUp threw for conversation ${conversationId}:`,
      err instanceof Error ? err.message : err,
    )
    return { scheduled: false, reason: 'error', id: null }
  }
}

/**
 * Cancel every PENDING follow-up for a conversation.
 *
 * Invoked by the inbound webhook the moment a REAL customer message
 * lands: the customer just answered (or re-raised the topic), so any
 * "are you still there?" reminder for that thread is moot — and the
 * conversation's next bot reply schedules a fresh one.
 *
 * Never throws: a cancel failure must not block inbound processing.
 */
export async function cancelPendingFollowUps(
  db: SupabaseClient,
  conversationId: string,
): Promise<void> {
  try {
    const { error } = await db
      .from('follow_ups')
      .update({ status: 'cancelled' })
      .eq('conversation_id', conversationId)
      .in('status', ['pending', 'processing'])
    if (error) {
      console.error(
        `[follow-up] could not cancel pending follow-ups for conversation ${conversationId}:`,
        error.message,
      )
      return
    }
    console.log(
      `[follow-up] cancelled pending follow-ups for conversation ${conversationId}.`,
    )
  } catch (err) {
    // Never throws to the caller: a cancel failure must not block inbound
    // processing (and some mocks/DB hosts throw on unknown tables).
    console.error(
      `[follow-up] cancelPendingFollowUps threw for conversation ${conversationId}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * A canned, factual nudge used when the account has no usable AI config
 * (AI never set up, or its key cannot be decrypted). Kept deliberately
 * vague — it must never re-raise a specific topic the model would have
 * to summarize, and never promise a human is waiting.
 */
const GENERIC_REMINDER =
  '¡Hola! Quería confirmar si quedó pendiente algo por tu parte. Quedo atento para ayudarte.'

/**
 * Hard cap for the AI-generated reminder text. The model is told to stay
 * under ~30 words, but a wayward provider can still answer with a wall of
 * text — and this is an automated nudge, not a newsletter. Cuts at the
 * nearest word boundary at or below `limit` words and keeps a single short
 * paragraph (no line breaks).
 */
export function truncateToLimit(text: string, limit = 30): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  const words = normalized.split(' ')
  if (words.length <= limit) return normalized
  const cut = words.slice(0, limit).join(' ')
  const clean = cut.replace(/[.,;:!?]+$/, '')
  return clean.endsWith('.') ? clean : `${clean}.`
}

/**
 * Natural reminder for a conversation that went quiet. Built by the
 * account's AI provider out of the REAL recent transcript; falls back to
 * `GENERIC_REMINDER` when provisioning failed or the model said nothing.
 */
async function buildFollowUpMessage(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<string> {
  const config = await loadAiConfig(db, accountId, {
    requireActive: false,
  }).catch((err) => {
    // Decrypt failures are surfaced by loadAiConfig itself (CRITICAL
    // log); treat them as "no AI available" here so the nudge still goes
    // out rather than the customer being silently ignored.
    console.error(
      `[follow-up] AI config unavailable for account ${accountId}; falling back to a generic reminder:`,
      err instanceof Error ? err.message : err,
    )
    return null
  })
  if (!config?.apiKey) return GENERIC_REMINDER

  const transcript = await buildConversationContext(db, conversationId, 20)
  if (transcript.length === 0) return GENERIC_REMINDER

  const systemPrompt =
    'You are a WhatsApp CRM assistant writing ONE short, natural check-in ' +
    'message because the customer has not replied in a while. Read the ' +
    'recent transcript and follow up on the PENDING topic: if the last ' +
    'assistant message was a proposal, a quote or a question, briefly check ' +
    'whether it was clear and whether they want to move forward; otherwise ' +
    'ask about the open point. Rules: a SINGLE message no longer than 30 ' +
    'words, formatted as ONE short paragraph with no blank lines, bullet ' +
    'points or emojis; do not repeat the exact words of the previous ' +
    'assistant message and never sound like a rigid bot; never invent ' +
    'facts, dates, prices, links or appointments; no greeting beyond the ' +
    'first word; write in the language the customer used; end with a ' +
    'single open question.'

  try {
    const result = await generateReply({
      config,
      systemPrompt,
      messages: transcript,
    })
    const text = truncateToLimit(stripInternalReasoning(result.text ?? ''))
    return text || GENERIC_REMINDER
  } catch (err) {
    console.error(
      `[follow-up] provider call failed for conversation ${conversationId}; using a generic reminder:`,
      err instanceof Error ? err.message : err,
    )
    return GENERIC_REMINDER
  }
}

/**
 * The last message of a conversation (sender + timestamp), or null.
 *
 * `created_at` is what makes the anti-race check time-aware: a manual
 * timer is set while the customer's last message is USUALLY still theirs
 * (the agent schedules "chase them in 5 min" right after reading it), so
 * we must only drop the reminder when the customer wrote AFTER the
 * reminder itself was queued.
 */
async function lastMessage(
  db: SupabaseClient,
  conversationId: string,
): Promise<{ sender: 'customer' | 'agent' | 'bot'; createdAt: string | null } | null> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  const row = data as {
    sender_type: 'customer' | 'agent' | 'bot'
    created_at?: string | null
  }
  return { sender: row.sender_type, createdAt: row.created_at ?? null }
}

/**
 * Re-verify a claimed row is STILL mid-dispatch before the network call.
 *
 * The atomic claim guards overlaps between sweeps, but an agent can turn
 * the chat OFF (or the webhook can cancel on a customer reply) AFTER the
 * claim and BEFORE the send lands. Both cancellations flip the row to
 * `cancelled`, so this read is the authoritative "may I still fire?"
 * check — if the row is no longer `processing`, the message must NOT go
 * out ("switch OFF stops the send").
 */
async function stillProcessing(
  db: SupabaseClient,
  table: 'follow_ups' | 'response_wait_timers',
  id: string,
): Promise<boolean> {
  try {
    const { data } = await db
      .from(table)
      .select('status')
      .eq('id', id)
      .maybeSingle()
    return (data as { status?: string } | null)?.status === 'processing'
  } catch (err) {
    console.error(
      `[follow-up] could not re-check claim of ${id} (${table}); treating as not processing:`,
      err instanceof Error ? err.message : err,
    )
    return false
  }
}

/**
 * A claimed row can never fire if a sweep crashes between the claim and its
 * terminal update — it sits in `processing` forever, invisible to every
 * future scan (they only select `pending`/`active`). This reclaims rows that
 * have been stuck for longer than a CLAIM lease (~5 min, far beyond any
 * single send's lifetime), restoring them to their schedulable state so the
 * next sweep (cron, in-process, or a client-triggered `process_now`) can
 * dispatch them instead of leaving the countdown at 00:00 with no message.
 *
 * gracefully degraded: a missing `updated_at` column just skips the table.
 */
const CLAIM_LEASE_MS = 5 * 60_000

/**
 * Small tolerance used ONLY by a per-conversation trigger (`process_now`):
 * the browser fires when ITS countdown (server-clock-anchored via `server_now`)
 * shows `00:00`, and a few seconds of clock skew / due-boundary skitter must
 * not let the whole scan skip the row. A global cron sweep stays exact.
 */
const DUE_GRACE_MS = 5_000

async function reclaimStaleClaims(db: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - CLAIM_LEASE_MS).toISOString()
  const reclaim = async (
    table: 'follow_ups' | 'response_wait_timers',
    toStatus: 'pending' | 'active',
  ): Promise<number> => {
    try {
      const { data, error } = await db
        .from(table)
        .update({ status: toStatus })
        .eq('status', 'processing')
        .lt('updated_at', cutoff)
        .select('id')
      if (error) {
        console.error(
          `[follow-up] stale-claim reclaim on ${table} skipped (${error.message}); the row may stay stuck until a manual fix.`,
        )
        return 0
      }
      return data?.length ?? 0
    } catch (err) {
      console.error(
        `[follow-up] stale-claim reclaim on ${table} threw:`,
        err instanceof Error ? err.message : err,
      )
      return 0
    }
  }
  const followUps = await reclaim('follow_ups', 'pending')
  const wait = await reclaim('response_wait_timers', 'active')
  if (followUps > 0 || wait > 0) {
    console.log(
      `[follow-up] reclaimed ${followUps} follow-up + ${wait} response-wait stale claim(s) older than ${cutoff} — re-queued for the next sweep.`,
    )
  }
}

export interface RunFollowUpsResult {
  scanned: number
  sent: number
  cancelled: number
  noResponse: number
  /** Second-stage (24h) reminders queued this sweep. */
  scheduled: number
}

/**
 * The runner: sweep every due PENDING follow-up and resolve it.
 *
 * For each due row:
 *   1. ANTI-RACE — the customer must NOT have replied since the bot
 *      answered. Read the conversation's last message; if the sender is
 *      the customer, the reminder is dropped and marked `cancelled`.
 *   2. Otherwise generate a natural follow-up and send it to WhatsApp.
 *   3. Mark `completed` on success, `no_response` on failure (a
 *      provider/send failure is terminal — the contact's one-budget is
 *      consumed, so the system never retries forever and never chases
 *      twice).
 *
 * Best-effort, never throws to the caller. Idempotent by ATOMIC CLAIM:
 * each due row is moved `pending → processing` before any work, and every
 * later state transition is guarded on `status='processing'`, so an
 * overlapping invocation (cron + in-process interval) cannot double-process
 * a row it already claimed.
 */
export async function runDueFollowUps(
  db: SupabaseClient | null = null,
  now: Date = new Date(),
  conversationId?: string,
): Promise<RunFollowUpsResult> {
  const result: RunFollowUpsResult = {
    scanned: 0,
    sent: 0,
    cancelled: 0,
    noResponse: 0,
    scheduled: 0,
  }

  try {
    // Resolve the client INSIDE the try: `supabaseAdmin()` throws when
    // the service-role env vars are missing, and that must be a logged
    // no-op for the cron, never a 500.
    const client = db ?? supabaseAdmin()

    // A previous sweep may have crashed mid-claim; any row still `processing`
    // beyond the claim lease is re-queued so it can actually fire (never
    // stranded at 00:00). Cheap and idempotent — reclaims zero rows normally.
    // A per-conversation trigger (client `process_now`) stays focused and
    // does NOT touch other conversations' claims.
    if (!conversationId) await reclaimStaleClaims(client)

    // A per-conversation scan (client-triggered `process_now`) is allowed a
    // small DUE GRACE so a countdown the browser already showed at 00:00 is
    // never skipped: the server clock can trail the client's (or the two
    // clocks can disagree by microseconds on the due boundary) and the row
    // would otherwise be silently omitted by the exact `<= NOW()` sweep.
    const dueCutoff = new Date(
      now.getTime() + (conversationId ? DUE_GRACE_MS : 0),
    ).toISOString()

    const base = client
      .from('follow_ups')
      .select('id, conversation_id, contact_id, account_id, type, created_at')
      .eq('status', 'pending')
      .lte('execute_at', dueCutoff)
      .order('execute_at', { ascending: true })
      .limit(50)
    // FOCUSED TRIGGER: only the rows of THIS conversation. The shared claim
    // logic below (atomic `pending`→`processing`, anti-race, send, terminal
    // state) runs identically, so a client-hit timer goes through the exact
    // same delivery path as a cron sweep.
    const query = conversationId ? base.eq('conversation_id', conversationId) : base
    const { data: due, error } = await query

    if (error) {
      console.error('[follow-up] runner scan failed:', error.message)
      return result
    }
    if (!due || due.length === 0) return result
    console.log(`[follow-up] runner found ${due.length} due follow-up(s) to dispatch.`)

    for (const row of due) {
      const id = row.id as string
      const conversationId = row.conversation_id as string
      const contactId = row.contact_id as string
      const accountId = row.account_id as string
      const type: FollowUpType = row.type === '24h' ? '24h' : '10m'
      result.scanned++

      // ATOMIC CLAIM: move the due row to `processing` BEFORE doing any
      // work, and only continue when THIS update was the one that won.
      // Both sweeps (external cron + in-process interval) enter with the
      // same `pending` set; `.eq('status','pending')` means the second
      // sweep matches zero rows and skips, so a row can never be sent by
      // two overlapping invocations. Every later transition is guarded on
      // `status='processing'`.
      const { data: claimed, error: claimErr } = await client
        .from('follow_ups')
        .update({ status: 'processing' })
        .eq('id', id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle()
      if (claimErr) {
        console.error(`[follow-up] could not claim ${id}:`, claimErr.message)
        continue
      }
      if (!claimed) {
        // Lost the race — another sweep owns this row. Never send twice.
        continue
      }
      console.log(
        `[follow-up] dispatching follow-up ${id} for conversation ${conversationId} (contact ${contactId}).`,
      )
      console.log(`[TIMER EXPIRED] Processing conversation_id: ${conversationId}`)
      console.log(`[TIMER EXECUTE] Triggered for conversation ${conversationId}`)

      // NO public-@handle gate: a due reminder fires for ANY registered
      // contact. The destination is resolved at send time by the shared
      // sender ladder (phone → recovered → wa_id → wa_user_id →
      // recipient_id → username), never from a cosmetic `@user`.

      // PER-CHAT SWITCH: a chat in OFF must never dispatch. The inbox route
      // also cancels pending rows the moment the switch flips off, but this
      // is the authoritative check at SEND time — it covers the ON→OFF race
      // where a row came due at (or after) the instant the agent flipped it.
      if (!(await isConversationFollowUpEnabled(client, conversationId))) {
        const { error: cancelErr } = await client
          .from('follow_ups')
          .update({ status: 'cancelled' })
          .eq('id', id)
          .eq('status', 'processing')
        if (cancelErr) {
          console.error(`[follow-up] could not cancel ${id} (chat OFF):`, cancelErr.message)
        } else {
          result.cancelled++
          console.log(`[follow-up] follow-up ${id} cancelled (chat switched OFF).`)
        }
        continue
      }

      // ROW-STATE RE-CHECK: a switch-Off or an inbound reply that landed
      // AFTER the claim already flipped this row to `cancelled` even
      // though this sweep still holds it in memory. Firing anyway would
      // send a message the agent explicitly stopped — abort without
      // sending. (`stillProcessing` reads the live row.)
      if (!(await stillProcessing(client, 'follow_ups', id))) {
        console.log(
          `[follow-up] follow-up ${id} cancelled after the claim — not sending.`,
        )
        result.cancelled++
        continue
      }

      // The anti-race read must never STOP delivery because of a DB hiccup:
      // if we cannot read the last message we cannot prove a late reply, so
      // we deliver (fail-open) instead of silently dropping the reminder.
      let last: {
        sender: 'customer' | 'agent' | 'bot'
        createdAt: string | null
      } | null = null
      try {
        last = await lastMessage(client, conversationId)
      } catch (err) {
        console.error(
          `[follow-up] could not read the last message for conversation ${conversationId}; delivering without the anti-race check:`,
          err instanceof Error ? err.message : err,
        )
      }

      // ANTI-RACE (time-aware): only drop the reminder when the customer
      // wrote AFTER this reminder was queued. That is the true signal that
      // they answered on their own — and it is what lets a MANUAL timer
      // fire even though the last message was (and still is) the
      // customer's, which is the normal case when an agent schedules a
      // chase from the inbox. When either timestamp is missing we cannot
      // prove a late reply, so we deliver rather than silently drop it.
      const scheduledAt = row.created_at ? Date.parse(String(row.created_at)) : NaN
      const repliedAt = last?.createdAt ? Date.parse(last.createdAt) : NaN
      const repliedAfterSchedule =
        last?.sender === 'customer' &&
        Number.isFinite(repliedAt) &&
        Number.isFinite(scheduledAt) &&
        repliedAt > scheduledAt

      if (repliedAfterSchedule) {
        const { error: cancelErr } = await client
          .from('follow_ups')
          .update({ status: 'cancelled' })
          .eq('id', id)
          .eq('status', 'processing')
        if (cancelErr) {
          console.error(`[follow-up] could not cancel ${id} (anti-race):`, cancelErr.message)
        } else {
          result.cancelled++
          console.log(
            `[follow-up] follow-up ${id} cancelled (customer replied before the ${type} window closed).`,
          )
        }
        continue
      }

      // UNIFIED DESTINATION — the same getRecipientAddress a manual inbox
      // send and the bot auto-reply walk through: a valid `phone` wins (with
      // non-numeric characters stripped); when `phone` is `'unknown'`/empty
      // the `wa_id` / `recipient_id` Meta persisted on the contact row kick
      // in. Resolve FIRST so a failed delivery's log carries the exact
      // address this send was aimed at, and fail fast when there is
      // genuinely nothing Meta could route to. A DB hiccup reading the
      // contact is fail-open: the send core re-resolves at dispatch time
      // anyway. The username/@handle last-resort stays available to the
      // core, so we only close the row early when it holds NO phone /
      // wa_id / recipient_id AND no username either.
      let destination: string | null = null
      try {
        const { data: contact, error: contactErr } = await client
          .from('contacts')
          .select('phone, wa_id, recipient_id, username')
          .eq('id', contactId)
          .maybeSingle()
        if (contactErr) {
          console.error(
            `[follow-up] could not read the contact for conversation ${conversationId} — the send core will resolve the destination anyway:`,
            contactErr.message,
          )
        } else if (contact) {
          destination = getRecipientAddress(contact)
          const usernameBare = cleanRecipientAddress(contact?.username ?? '')
          if (destination) {
            console.log(
              `[follow-up] destination for conversation ${conversationId} resolved via getRecipientAddress: ${destination}.`,
            )
            console.log(`[TIMER RECIPIENT] Target phone resolved: ${destination}`)
            console.log(
              `[TIMER PARAMETERS] Phone: ${contact.phone ?? 'n/a'}, RecipientID: ${contact.recipient_id ?? 'n/a'}`,
            )
          } else if (usernameBare && !isPlaceholderValue(usernameBare)) {
            console.warn(
              `[follow-up] conversation ${conversationId} has no phone/wa_id/recipient_id — leaving the username/@handle last resort to the send core.`,
            )
          } else {
            console.warn(
              `[follow-up] conversation ${conversationId} has NO resolvable destination (no phone, wa_id, recipient_id or username) — closing the timer so it is never retried.`,
            )
            const { error: noAddrErr } = await client
              .from('follow_ups')
              .update({ status: 'no_response' })
              .eq('id', id)
              .eq('status', 'processing')
            if (noAddrErr) {
              console.error(
                `[follow-up] could not mark ${id} as no_response (no address):`,
                noAddrErr.message,
              )
            } else {
              result.noResponse++
            }
            continue
          }
        }
      } catch (err) {
        console.error(
          `[follow-up] destination resolution threw for conversation ${conversationId} (fail-open, the send core resolves anyway):`,
          err instanceof Error ? err.message : err,
        )
      }

      // Generate the nudge text. A failure here (AI context/DB hiccup) must
      // NEVER strand the row in `processing` — a stuck claimed row can never
      // be delivered by another sweep AND it blocks re-scheduling for the
      // conversation — nor abort the whole run: resolve it exactly like a
      // send failure so the reminder is closed as `no_response`.
      let text: string
      try {
        text = await buildFollowUpMessage(client, accountId, conversationId)
      } catch (err) {
        console.error(
          `[follow-up] could not build the follow-up text for conversation ${conversationId}:`,
          err instanceof Error ? err.message : err,
        )
        const { error: noRespErr } = await client
          .from('follow_ups')
          .update({ status: 'no_response' })
          .eq('id', id)
          .eq('status', 'processing')
        if (noRespErr) {
          console.error(`[follow-up] could not mark ${id} as no_response:`, noRespErr.message)
        } else {
          result.noResponse++
        }
        continue
      }

      console.log(
        `[FOLLOW-UP EXEC] Message text generated for conversation ${conversationId}: "${text}"`,
      )
      console.log(
        `[TIMER CENTRAL SEND] Calling central send function (sendMessageToConversation) for conversation ${conversationId}...`,
      )

      // Send through the SAME core the inbox uses for a manual message
      // (`sendMessageToConversation`), so the OFFICIAL Meta API is hit and a
      // follow-up to a phone-less contact still reaches them. It resolves the
      // destination DYNAMICALLY at call time with the normalized rule: a
      // valid `phone` is used as-is; when `phone` is `'unknown'` or empty it
      // falls back to the identifiers Meta persisted on the contact row
      // (`wa_id` / `recipient_id`) — the ladder actually runs phone →
      // recovered number → wa_id → BSUID → recipient_id → @username — and
      // anchors opaque-id recipients to the thread's newest inbound wamid so
      // WhatsApp delivers the nudge instead of silently dropping a 200.
      // Nothing about the destination is hardcoded.
      try {
        const sendResult = await sendMessageToConversation(client, accountId, {
          conversationId,
          messageType: 'text',
          contentText: text,
          senderType: 'bot',
          aiGenerated: true,
        })
        // The send core resolves the SAME destination the bot/manual sends
        // use (E.164 phone → wa_id → recipient_id) and only resolves when
        // Meta answered 2xx — a reject throws into the catch below and is
        // NEVER recorded as delivered. Log the real wamid for traceability.
        console.log(
          `[follow-up] follow-up delivered by the shared send core for conversation ${conversationId} (destination: ${destination ?? 'core-resolved'}, wamid: ${sendResult.whatsappMessageId ?? sendResult.messageId}).`,
        )
        // Task-mandated diagnostic logs: Meta's answer (reaching here means
        // 2xx — the send core only resolves after Meta accepted) and the DB
        // insert the shared send core persists so the bubble renders in the
        // inbox thread (`messageId` is the stored `messages` row id).
        console.log(
          `[FOLLOW-UP META] Response from Meta API for conversation ${conversationId}: accepted (2xx), wamid ${sendResult.whatsappMessageId ?? 'n/a'}.`,
        )
        console.log(
          `[FOLLOW-UP DB] Message stored in DB: ${sendResult.messageId} (conversation ${conversationId}, wamid ${sendResult.whatsappMessageId ?? 'n/a'}).`,
        )
        // Reaching this log means Meta answered 2xx (the send core threw
        // otherwise); the exact status code is printed by the adjacent
        // `[OUTBOUND WHATSAPP] … status=<n>` log in the send core.
        console.log(
          `[TIMER META RESULT] Success status: 2xx, wamid: ${sendResult.whatsappMessageId ?? 'n/a'}`,
        )
      } catch (err) {
        console.error(
          `[follow-up] could not send the follow-up for conversation ${conversationId} (destination resolved via getRecipientAddress: ${destination ?? 'none'}):`,
          err instanceof Error ? err.message : err,
        )
        const { error: noRespErr } = await client
          .from('follow_ups')
          .update({ status: 'no_response' })
          .eq('id', id)
          .eq('status', 'processing')
        if (noRespErr) {
          console.error(`[follow-up] could not mark ${id} as no_response:`, noRespErr.message)
        } else {
          result.noResponse++
        }
        continue
      }

      const { error: doneErr } = await client
        .from('follow_ups')
        .update({ status: 'completed' })
        .eq('id', id)
        .eq('status', 'processing')
      if (doneErr) {
        console.error(`[follow-up] could not mark ${id} as completed:`, doneErr.message)
        continue
      }
      result.sent++
      console.log(
        `[follow-up] follow-up ${id} completed — reminder delivered for conversation ${conversationId}.`,
      )

      // A delivered 10-minute reminder earns the contact ONE more chance,
      // a day later. The per-type historic rule means the just-completed
      // 10m doesn't block the 24h, and a silent 24h never triggers a third.
      if (type === '10m') {
        const next = await scheduleFollowUp(client, {
          conversationId,
          contactId,
          accountId,
          type: '24h',
        })
        if (next.scheduled) {
          result.scheduled++
          console.log(
            `[follow-up] 10m delivered — 24h stage queued (${next.id}) for conversation ${conversationId}.`,
          )
        }
      }
    }
  } catch (err) {
    // Whole-sweep safety net: an unexpected exception (missing table,
    // network error, a provider that threw outside its inner try/catch,
    // …) must never reach the cron endpoint or the in-process worker and
    // turn into a 500 / a crashed process.
    console.error(
      '[follow-up] runner threw while draining the queue:',
      err instanceof Error ? err.message : err,
    )
  }

  return result
}

export interface RunResponseWaitResult {
  scanned: number
  sent: number
  cancelled: number
  noResponse: number
}

/**
 * The Timer 2 runner: sweep every due ACTIVE response-wait timer and
 * resolve it.
 *
 * For each due row:
 *   1. ATOMIC CLAIM (`active` → `processing`) so an overlapping sweep can
 *      never dispatch the same timer twice.
 *   2. AUTO-CANCEL SAFETY NET — if the customer replied AFTER the timer
 *      started (`started_at`), the row is cancelled and nothing is sent.
 *      (The inbound webhook already cancelled it, so this covers the
 *      race where the reply landed just before/after the sweep's scan.)
 *   3. Otherwise generate a contextual AI follow-up and send it through
 *      `sendMessageToConversation` (with `autoArm: false`).
 *   4. ONE-SHOT EXECUTION — the moment the single nudge is dispatched the
 *      row closes as `completed` AND the conversation's "Esperar
 *      respuesta" switch (`response_wait_enabled`) flips OFF, so the
 *      cycle strictly never re-enters a loop. The agent must press ↻
 *      Reiniciar (or re-enable the switch) to watch again. The update is
 *      guarded on `status='processing'`: if the client replied at the exact
 *      moment of dispatch, the webhook already cancelled the row and this
 *      sweep does not resurrect it. `no_response` still closes a row whose
 *      nudge never went out (a provider/send failure is terminal — the
 *      system never retries forever).
 *
 * Scoped strictly to `conversation_id`; a missing table or schema glitch
 * degrades to a logged no-op. Never throws. Idempotent: every state
 * transition is guarded on `status='processing'` (the claimed state).
 */
export async function runDueResponseWaitTimers(
  db: SupabaseClient | null = null,
  now: Date = new Date(),
  conversationId?: string,
): Promise<RunResponseWaitResult> {
  const result: RunResponseWaitResult = {
    scanned: 0,
    sent: 0,
    cancelled: 0,
    noResponse: 0,
  }

  try {
    const client = db ?? supabaseAdmin()

    // Reclaim any previous crash's stale claims before scanning (see
    // `reclaimStaleClaims`) so an abandoned `processing` row can still fire.
    // A per-conversation trigger (client `process_now`) stays focused.
    if (!conversationId) await reclaimStaleClaims(client)

    // FOCUSED TRIGGER grace: a per-conversation scan (`process_now` from the
    // banner at 00:00) tolerates a small clock/`<= NOW()` skitter so the row
    // the browser already showed expired is never silently omitted.
    const dueCutoff = new Date(
      now.getTime() + (conversationId ? DUE_GRACE_MS : 0),
    ).toISOString()

    const base = client
      .from('response_wait_timers')
      .select('id, conversation_id, contact_id, account_id, started_at')
      .eq('status', 'active')
      .lte('expires_at', dueCutoff)
      .order('expires_at', { ascending: true })
      .limit(50)
    // FOCUSED TRIGGER: only the rows of THIS conversation (same shared claim
    // + send + anti-race logic below as a cron sweep).
    const query = conversationId ? base.eq('conversation_id', conversationId) : base
    const { data: due, error } = await query
    if (error) {
      if (!/does not exist|42703|PGRST204/i.test(error.message)) {
        console.error('[response-wait] runner scan failed:', error.message)
      }
      return result
    }
    if (!due || due.length === 0) return result
    console.log(
      `[response-wait] runner found ${due.length} expired "Esperando respuesta" timer(s) to dispatch.`,
    )

    for (const row of due) {
      const id = row.id as string
      const conversationId = row.conversation_id as string
      const contactId = row.contact_id as string
      const accountId = row.account_id as string
      result.scanned++

      // ATOMIC CLAIM: move the due row to `processing` BEFORE doing any
      // work, and only continue when THIS update was the one that won.
      // Both sweeps (external cron + in-process interval) enter with the
      // same `active` set; `.eq('status','active')` means the second sweep
      // matches zero rows and skips — a timer can never fire twice. Every
      // later transition is guarded on `status='processing'`.
      const { data: claimed, error: claimErr } = await client
        .from('response_wait_timers')
        .update({ status: 'processing' })
        .eq('id', id)
        .eq('status', 'active')
        .select('id')
        .maybeSingle()
      if (claimErr) {
        console.error(`[response-wait] could not claim ${id}:`, claimErr.message)
        continue
      }
      if (!claimed) {
        // Lost the race — another sweep owns this row. Never send twice.
        continue
      }
      console.log(
        `[response-wait] dispatching expired timer ${id} for conversation ${conversationId} (contact ${contactId}).`,
      )
      console.log(`[TIMER EXPIRED] Processing conversation_id: ${conversationId}`)
      console.log(`[TIMER EXECUTE] Triggered for conversation ${conversationId}`)

      // NO public-@handle gate: a due nudge fires for ANY registered
      // contact. The destination is resolved at send time by the shared
      // sender ladder (phone → recovered → wa_id → wa_user_id →
      // recipient_id → username), never from a cosmetic `@user`.

      // ROW-STATE RE-CHECK: a switch-Off or an inbound reply that landed
      // AFTER the claim already flipped this row to `cancelled` (the
      // inbox toggle and the webhook both cancel rows) even though this
      // sweep still holds it in memory. Firing anyway would nudge a chat
      // the agent explicitly stopped — abort without sending, and re-close
      // the row if something left it in limbo.
      if (!(await stillProcessing(client, 'response_wait_timers', id))) {
        const { error: cancelErr } = await client
          .from('response_wait_timers')
          .update({ status: 'cancelled', cancelled_reason: 'manual' })
          .eq('id', id)
          .eq('status', 'processing')
        if (cancelErr) {
          console.error(`[response-wait] could not close ${id} after post-claim cancel:`, cancelErr.message)
        }
        result.cancelled++
        console.log(
          `[response-wait] timer ${id} cancelled after the claim — not sending.`,
        )
        continue
      }

      // The anti-race read must never STOP the nudge because of a DB hiccup:
      // if we cannot read the last message we cannot prove the customer
      // replied since the countdown started, so we send (fail-open) instead
      // of stranding the claimed row in `processing` — a stuck row is never
      // delivered and blocks any retry of the "Esperar respuesta" cycle.
      let last: {
        sender: 'customer' | 'agent' | 'bot'
        createdAt: string | null
      } | null = null
      try {
        last = await lastMessage(client, conversationId)
      } catch (err) {
        console.error(
          `[response-wait] could not read the last message for conversation ${conversationId}; sending the nudge without the anti-race check:`,
          err instanceof Error ? err.message : err,
        )
      }

      // AUTO-CANCEL BY REPLY (micro-race safety net): the inbound webhook
      // normally RE-ARMS the timer when the customer writes, refreshing
      // `started_at` in the same DB. If the reply landed between THIS sweep's
      // claim and the send (a race), the webhook has already re-armed a fresh
      // ACTIVE row — so the stale claimed row must NOT dispatch: close it as
      // `cancelled/anti_race` instead of sending an obsolete nudge.
      const startedAt = row.started_at ? Date.parse(String(row.started_at)) : NaN
      const repliedAt = last?.createdAt ? Date.parse(last.createdAt) : NaN
      const repliedAfterStart =
        last?.sender === 'customer' &&
        Number.isFinite(repliedAt) &&
        Number.isFinite(startedAt) &&
        repliedAt >= startedAt

      if (repliedAfterStart) {
        const { error: cancelErr } = await client
          .from('response_wait_timers')
          .update({ status: 'cancelled', cancelled_reason: 'anti_race' })
          .eq('id', id)
          .eq('status', 'processing')
        if (cancelErr) {
          // Migration 065 pending (column missing): retry the legacy update
          // so the one-shot cancel still lands on an un-migrated DB.
          if (/column .* does not exist|42703|PGRST204|schema cache/i.test(cancelErr.message)) {
            const { error: legacyErr } = await client
              .from('response_wait_timers')
              .update({ status: 'cancelled' })
              .eq('id', id)
              .eq('status', 'processing')
            if (legacyErr) {
              console.error(`[response-wait] could not cancel ${id} (reply race):`, legacyErr.message)
            } else {
              result.cancelled++
            }
          } else {
            console.error(`[response-wait] could not cancel ${id} (reply race):`, cancelErr.message)
          }
        } else {
          result.cancelled++
          console.log(
            `[response-wait] timer ${id} cancelled — the customer replied for conversation ${conversationId}.`,
          )
        }
        continue
      }

      // UNIFIED DESTINATION — the same getRecipientAddress used by the manual
      // inbox send, the bot auto-reply and the follow-up runner: a valid
      // `phone` wins (non-numeric characters stripped); when `phone` is
      // `'unknown'`/empty the `wa_id` / `recipient_id` Meta persisted on the
      // contact row kick in. Resolve FIRST so a failed nudge's log carries
      // the exact address it was aimed at, and fail fast when there is
      // genuinely nothing Meta could route to. A DB hiccup reading the
      // contact is fail-open: the send core re-resolves at dispatch time
      // anyway, and the username/@handle last-resort stays available to it —
      // we only close the row early when it holds NO phone / wa_id /
      // recipient_id AND no username either.
      let destination: string | null = null
      try {
        const { data: contact, error: contactErr } = await client
          .from('contacts')
          .select('phone, wa_id, recipient_id, username')
          .eq('id', contactId)
          .maybeSingle()
        if (contactErr) {
          console.error(
            `[response-wait] could not read the contact for conversation ${conversationId} — the send core will resolve the destination anyway:`,
            contactErr.message,
          )
        } else if (contact) {
          destination = getRecipientAddress(contact)
          const usernameBare = cleanRecipientAddress(contact?.username ?? '')
          if (destination) {
            console.log(
              `[response-wait] destination for conversation ${conversationId} resolved via getRecipientAddress: ${destination}.`,
            )
            console.log(`[TIMER RECIPIENT] Target phone resolved: ${destination}`)
            console.log(
              `[TIMER PARAMETERS] Phone: ${contact.phone ?? 'n/a'}, RecipientID: ${contact.recipient_id ?? 'n/a'}`,
            )
          } else if (usernameBare && !isPlaceholderValue(usernameBare)) {
            console.warn(
              `[response-wait] conversation ${conversationId} has no phone/wa_id/recipient_id — leaving the username/@handle last resort to the send core.`,
            )
          } else {
            console.warn(
              `[response-wait] conversation ${conversationId} has NO resolvable destination (no phone, wa_id, recipient_id or username) — closing the timer so it is never retried.`,
            )
            const { error: noAddrErr } = await client
              .from('response_wait_timers')
              .update({ status: 'no_response' })
              .eq('id', id)
              .eq('status', 'processing')
            if (noAddrErr) {
              console.error(
                `[response-wait] could not mark ${id} as no_response (no address):`,
                noAddrErr.message,
              )
            } else {
              result.noResponse++
            }
            continue
          }
        }
      } catch (err) {
        console.error(
          `[response-wait] destination resolution threw for conversation ${conversationId} (fail-open, the send core resolves anyway):`,
          err instanceof Error ? err.message : err,
        )
      }

      // Generate the nudge text. A failure here (AI context/DB hiccup) must
      // NEVER strand the row in `processing` — a stuck claimed row can never
      // be sent by another sweep and blocks future cycles for the
      // conversation — nor abort the whole run: close it exactly like a send
      // failure so the timer is marked `no_response` instead of hanging at
      // 00:00 and never dispatching the "Esperando respuesta" message.
      let text: string
      try {
        text = await buildFollowUpMessage(client, accountId, conversationId)
      } catch (err) {
        console.error(
          `[response-wait] could not build the nudge text for conversation ${conversationId}:`,
          err instanceof Error ? err.message : err,
        )
        const { error: noRespErr } = await client
          .from('response_wait_timers')
          .update({ status: 'no_response' })
          .eq('id', id)
          .eq('status', 'processing')
        if (noRespErr) {
          console.error(`[response-wait] could not mark ${id} as no_response:`, noRespErr.message)
        } else {
          result.noResponse++
        }
        continue
      }

      console.log(
        `[FOLLOW-UP EXEC] Message text generated for conversation ${conversationId}: "${text}"`,
      )
      console.log(
        `[TIMER CENTRAL SEND] Calling central send function (sendMessageToConversation) for conversation ${conversationId}...`,
      )

      try {
        const sendResult = await sendMessageToConversation(client, accountId, {
          conversationId,
          messageType: 'text',
          contentText: text,
          senderType: 'bot',
          aiGenerated: true,
          // ONE-SHOT: this nudge opts OUT of the send core's auto-arm so no
          // second ACTIVE row can stack (the due row is still `active` and
          // only closes as `completed` AFTER the dispatch below). If the
          // client replies at the exact moment of expiry the webhook
          // cancelled the row — and without auto-arm no fresh row spawns.
          autoArm: false,
        })
        // Same shared core as the bot/manual sends; it only resolves when
        // Meta answered 2xx, so a reject below is never recorded as
        // delivered. Log the real wamid for traceability.
        console.log(
          `[response-wait] "Esperando respuesta" nudge delivered by the shared send core for conversation ${conversationId} (destination: ${destination ?? 'core-resolved'}, wamid: ${sendResult.whatsappMessageId ?? sendResult.messageId}).`,
        )
        // Task-mandated diagnostic logs: Meta's accepted answer (2xx) with
        // the wamid, and the DB insert persisted by the shared send core
        // (the inbox bubble reads from the same `messages` table).
        console.log(
          `[FOLLOW-UP META] Response from Meta API for conversation ${conversationId}: accepted (2xx), wamid ${sendResult.whatsappMessageId ?? 'n/a'}.`,
        )
        console.log(
          `[FOLLOW-UP DB] Message stored in DB: ${sendResult.messageId} (conversation ${conversationId}, wamid ${sendResult.whatsappMessageId ?? 'n/a'}).`,
        )
        // Reaching this log means Meta answered 2xx (the send core threw
        // otherwise); the exact status code is printed by the adjacent
        // `[OUTBOUND WHATSAPP] … status=<n>` log in the send core.
        console.log(
          `[TIMER META RESULT] Success status: 2xx, wamid: ${sendResult.whatsappMessageId ?? 'n/a'}`,
        )
      } catch (err) {
        console.error(
          `[response-wait] could not send the follow-up for conversation ${conversationId} (destination resolved via getRecipientAddress: ${destination ?? 'none'}):`,
          err instanceof Error ? err.message : err,
        )
        const { error: noRespErr } = await client
          .from('response_wait_timers')
          .update({ status: 'no_response' })
          .eq('id', id)
          .eq('status', 'processing')
        if (noRespErr) {
          console.error(`[response-wait] could not mark ${id} as no_response:`, noRespErr.message)
        } else {
          result.noResponse++
        }
        continue
      }

      // ONE-SHOT: the single contextual nudge went out; the timer closes as
      // `completed` AND the conversation's "Esperar respuesta" switch flips
      // to OFF — a finished cycle strictly never re-enters a loop. The agent
      // must press ↻ Reiniciar (or re-enable the switch) to watch again.
      // Guarded on `status='processing'`: if the inbound webhook cancelled
      // an active wait at the exact moment of dispatch (the client DID reply),
      // zero rows match and nothing is resurrected.
      const { error: doneErr } = await client
        .from('response_wait_timers')
        .update({ status: 'completed' })
        .eq('id', id)
        .eq('status', 'processing')
      if (doneErr) {
        console.error(`[response-wait] could not mark ${id} as completed:`, doneErr.message)
        continue
      }
      // Best-effort — flip the Timer 2 ON/OFF switch to OFF so no future
      // send auto-arms this conversation until the agent re-enables it.
      try {
        const { error: switchErr } = await client
          .from('conversations')
          .update({ response_wait_enabled: false })
          .eq('id', conversationId)
        if (switchErr) {
          console.error(
            `[response-wait] could not turn the switch OFF for conversation ${conversationId}:`,
            switchErr.message,
          )
        }
      } catch (err) {
        console.error(
          `[response-wait] switch-off threw for conversation ${conversationId}:`,
          err instanceof Error ? err.message : err,
        )
      }
      result.sent++
      console.log(
        `[response-wait] timer ${id} completed — one-shot follow-up delivered for conversation ${conversationId}, switch OFF.`,
      )
    }
  } catch (err) {
    console.error(
      '[response-wait] runner threw while draining the queue:',
      err instanceof Error ? err.message : err,
    )
  }

  return result
}

export interface ScheduledFollowUpsResult {
  /** Timer 1 results (the classic follow-up queue). */
  followUps: RunFollowUpsResult
  /** Timer 2 results (response-wait timers). */
  responseWait: RunResponseWaitResult
}

/**
 * Sweep BOTH timers in one call. Used by the cron endpoints and the
 * in-process worker so a single scheduler drives both queues.
 */
export async function runScheduledFollowUps(
  db: SupabaseClient | null = null,
  now: Date = new Date(),
): Promise<ScheduledFollowUpsResult> {
  const [followUps, responseWait] = await Promise.all([
    runDueFollowUps(db, now),
    runDueResponseWaitTimers(db, now),
  ])
  return { followUps, responseWait }
}

/**
 * In-process runner started by `src/instrumentation.ts` (or a server
 * bootstrap). It runs by DEFAULT; `FOLLOW_UP_WORKER_DISABLED=true` opts
 * out and `FOLLOW_UP_WORKER_INTERVAL_SECONDS` overrides the cadence.
 *
 * Returns a stop handle. A single in-flight guard makes overlapping
 * ticks (or a tick firing while the previous sweep is still running)
 * skip cleanly instead of double-processing.
 */
export function startFollowUpWorker(opts: {
  intervalMs?: number
  db?: SupabaseClient
} = {}): () => void {
  const intervalMs = opts.intervalMs ?? FOLLOW_UP_INTERVAL_DEFAULT_MS
  const db = opts.db ?? supabaseAdmin()
  let busy = false
  let timer: ReturnType<typeof setInterval> | null = null

  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const res = await runScheduledFollowUps(db)
      const fu = res.followUps
      const wait = res.responseWait
      if (fu.scanned > 0 || wait.scanned > 0) {
        console.log(
          `[follow-up] worker sweep complete — followUps: scanned=${fu.scanned} sent=${fu.sent} cancelled=${fu.cancelled} noResponse=${fu.noResponse} | responseWait: scanned=${wait.scanned} sent=${wait.sent} cancelled=${wait.cancelled} noResponse=${wait.noResponse}`,
        )
      }
    } catch (err) {
      // Safety net: a runaway sweep must never crash the process.
      console.error(
        '[follow-up] worker sweep threw:',
        err instanceof Error ? err.message : err,
      )
    } finally {
      busy = false
    }
  }

  timer = setInterval(tick, intervalMs)
  // Never hold the event loop open on the interval alone: the HTTP server
  // keeps the process alive, and this lets a short-lived process (tests,
  // CLI) exit cleanly.
  const handle = timer as unknown as { unref?: () => void }
  if (typeof handle.unref === 'function') handle.unref()
  // Fire once immediately so a just-deployed worker drains without
  // waiting a full interval.
  void tick()

  return () => {
    if (timer) clearInterval(timer)
    timer = null
  }
}