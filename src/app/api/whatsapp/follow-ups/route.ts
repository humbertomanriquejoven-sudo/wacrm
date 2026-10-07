import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { ARM_DEFAULT_MINUTES } from '@/lib/whatsapp/response-wait'
import {
  scheduleManualFollowUp,
  scheduleResponseWaitTimer,
  cancelResponseWaitTimers,
  runDueFollowUps,
  runDueResponseWaitTimers,
  type FollowUpType,
} from '@/lib/whatsapp/follow-up-worker'

/**
 * CRM-facing follow-ups API — the UI companion to the runner.
 *
 * The runner (`runDueFollowUps`, driven by `/api/cron/follow-ups` or the
 * in-process interval) only speaks service-role; this route lets the
 * inbox SEE and MANAGE the queue through normal dashboard auth:
 *
 *   GET   /api/whatsapp/follow-ups?conversation_id=…  → status for the thread
 *   POST  { action }  with the shared `{ conversation_id, … }` envelope:
 *         - cancel       cancel every PENDING reminder for the thread
 *         - reschedule   push the due time of the PENDING reminder back
 *         - schedule     queue a reminder now (defaults to the 10m stage)
 *         - set_enabled  per-chat override for {conversation_id, enabled}
 *         - wait_enabled   per-chat ON/OFF switch for Timer 2 (Esperar
 *                          respuesta); OFF also cancels the ACTIVE timer
 *         - wait_schedule  arm Timer 2 (response-wait) for N minutes
 *         - wait_reset     cancel the current Timer 2 + re-arm from N
 *         - wait_cancel    cancel the ACTIVE Timer 2 for the thread
 *         - process_now    drain BOTH queues like the cron would (client
 *                          fallback fired by the banner the moment a
 *                          countdown hits 00:00, so delivery never depends
 *                          solely on an external schedule)
 *
 * IMPORTANT — READS NEVER WRITE: GET (and the whole mount path of the
 * banner) is strictly read-only. A countdown's timestamp may only enter
 * BD through an explicit agent action (↻ Reiniciar / Programar) or the
 * send-triggered auto-arm, so switching chats, tabs, or reloading F5 can
 * only RECOVER a chat's persisted remainder, never create or reset it.
 *
 * Reads use the RLS-scoped user client (members may SELECT follow_ups).
 * Writes use the service-role client AFTER explicit ownership checks —
 * follow_ups row-level write policies are restricted to admin (062), and
 * the webhook/runner already write service-role; agents must still be
 * able to cancel/reschedule their own chats.
 */

type Ctx = Awaited<ReturnType<typeof getCurrentAccount>>

/**
 * PostgREST rejects the WHOLE projection when a named column is unknown
 * (`42703` / `PGRST204` / "… does not exist"). The per-chat switch lives
 * in migration 063, so an un-migrated database must still be able to load
 * the inbox: detect that and fall back to the legacy columns.
 */
function isMissingColumnError(message: string): boolean {
  return /column .* does not exist|42703|PGRST204|schema cache/i.test(message)
}

interface ResolvedConversation {
  ok: true
  conv: {
    id: string
    contact_id: string
    follow_up_enabled: boolean | null
    /** Timer 2 ON/OFF switch. Missing column (066 pending) → ON. */
    response_wait_enabled: boolean
  }
}
type ResolveFailure = { ok: false; status: number; error: string }
type Resolved = ResolvedConversation | ResolveFailure

/**
 * Load the conversation through progressively narrower projections, so the
 * inbox keeps loading on a partially-migrated database: newest columns
 * first (066 → 063), falling back to the raw legacy projection when
 * PostgREST rejects a named column (migration pending).
 */
async function resolveConversation(
  supabase: Ctx['supabase'],
  conversationId: string,
  accountId: string,
): Promise<Resolved> {
  const projections = [
    'id, account_id, contact_id, follow_up_enabled, response_wait_enabled',
    'id, account_id, contact_id, follow_up_enabled',
    'id, account_id, contact_id',
  ]

  let data: Record<string, unknown> | null = null
  let error: { message: string } | null = null
  for (const projection of projections) {
    const res = await supabase
      .from('conversations')
      .select(projection)
      .eq('id', conversationId)
      .maybeSingle()
    if (!res.error) {
      data = (res.data as Record<string, unknown> | null) ?? null
      error = null
      break
    }
    if (!isMissingColumnError(res.error.message)) {
      error = res.error
      break
    }
    console.warn(
      `[follow-ups] conversations projection failed (${projection}) — ${res.error.message}; retrying legacy projection.`,
    )
  }

  if (error) return { ok: false, status: 500, error: error.message }
  if (!data) return { ok: false, status: 404, error: 'Conversation not found' }
  if (data.account_id !== accountId) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }
  return {
    ok: true,
    conv: {
      id: data.id as string,
      contact_id: data.contact_id as string,
      follow_up_enabled: (data.follow_up_enabled as boolean | null | undefined) ?? null,
      response_wait_enabled: (data.response_wait_enabled as boolean | undefined) ?? true,
    },
  }
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const conversationId =
      new URL(request.url).searchParams.get('conversation_id') ?? ''
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 },
      )
    }

    const owned = await resolveConversation(supabase, conversationId, accountId)
    if (!owned.ok) {
      return NextResponse.json({ error: owned.error }, { status: owned.status })
    }

    // Any member may SELECT follow_ups (062 RLS). Worst case a transient
    // read hiccup degrades the banner to "no pending" — never a hard stop.
    const { data: pending, error } = await supabase
      .from('follow_ups')
      .select('id, conversation_id, type, status, execute_at')
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .order('execute_at', { ascending: true })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Timer 2 — the ACTIVE response-wait timer for THIS conversation (at
    // most one by design). Missing table/column (migration 064 pending)
    // or any read error degrades to "none" — the banner simply shows an
    // empty wait row instead of 500-ing the inbox.
    const { data: waitTimer } = await supabase
      .from('response_wait_timers')
      .select('id, conversation_id, status, delay_minutes, started_at, expires_at')
      .eq('conversation_id', conversationId)
      .eq('status', 'active')
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // Timer 2 one-shot OUTCOME — the most recent terminal row, so the UI
    // can keep showing "✅ finalizado (acción ejecutada)" after the timer
    // fired, or "💬 cliente respondió (temporizador cancelado)" after the
    // webhook cancelled it — across refreshes and chat switches. Tolerant
    // of migration 065 pending (cancelled_reason missing).
    let waitLast: Record<string, unknown> | null = null
    const lastRes = await supabase
      .from('response_wait_timers')
      .select('id, conversation_id, status, delay_minutes, cancelled_reason, updated_at')
      .eq('conversation_id', conversationId)
      .neq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (lastRes.error && isMissingColumnError(lastRes.error.message)) {
      const legacy = await supabase
        .from('response_wait_timers')
        .select('id, conversation_id, status, delay_minutes, updated_at')
        .eq('conversation_id', conversationId)
        .neq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!legacy.error && legacy.data) waitLast = legacy.data
    } else if (!lastRes.error && lastRes.data) {
      waitLast = lastRes.data
    }

    // READ-ONLY recovery anchor for chats that have NO ACTIVE row (the
    // auto-arm never ran for them — the switch was enabled after the last
    // send, the arm was refused, …). The banner re-mounts on every chat
    // switch / tab return / F5 and must RECOVER the persisted remainder:
    // deriving the exact timestamp the auto-arm WOULD have written (the
    // LAST OUTBOUND message + the chat's assigned delay — the same inputs
    // `armResponseWaitIfIdle` uses) keeps the slot counting the REAL
    // elapsed time instead of letting the client invent a fresh `NOW()+N`
    // on each mount. An ACTIVE row always wins (checked above), a thread
    // whose last message is the customer's has nothing left to wait for,
    // and an already-elapsed anchor resolves to "nothing to show".
    // Pure computation over persisted data — this GET never writes.
    let waitDerived: { expires_at: string; delay_minutes: number } | null = null
    if (!waitTimer && owned.conv.response_wait_enabled) {
      const { data: lastMsg, error: lastErr } = await supabase
        .from('messages')
        .select('sender_type, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const msg = lastMsg as {
        sender_type?: string | null
        created_at?: string | null
      } | null
      const anchor =
        !lastErr &&
        msg?.created_at &&
        (msg.sender_type === 'agent' || msg.sender_type === 'bot')
          ? Date.parse(msg.created_at)
          : NaN
      if (Number.isFinite(anchor)) {
        // Same delay resolution as the auto-arm: the chat's last-used
        // `delay_minutes` (any prior row carries the assigned value) or
        // the shared default.
        const lastMinutes = waitLast?.delay_minutes
        const delayMinutes =
          typeof lastMinutes === 'number' &&
          lastMinutes > 0 &&
          lastMinutes <= 10080
            ? Math.floor(lastMinutes)
            : ARM_DEFAULT_MINUTES
        const expiresAt = anchor + delayMinutes * 60_000
        if (expiresAt > Date.now()) {
          waitDerived = {
            expires_at: new Date(expiresAt).toISOString(),
            delay_minutes: delayMinutes,
          }
        }
      }
    }

    // Account-wide switch. Missing row / read error ⇒ enabled (the worker
    // shows follow-ups even before the operator visits Settings).
    let globalEnabled = true
    const cfg = await supabase
      .from('ai_configs')
      .select('follow_up_enabled')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!cfg.error && cfg.data) {
      globalEnabled =
        (cfg.data as { follow_up_enabled?: boolean }).follow_up_enabled !== false
    }

    return NextResponse.json({
      pending: pending ?? [],
      response_wait: waitTimer ?? null,
      response_wait_derived: waitDerived,
      response_wait_last: waitLast,
      global_enabled: globalEnabled,
      conversation_enabled: owned.conv.follow_up_enabled,
      response_wait_enabled: owned.conv.response_wait_enabled,
      // Server wall clock. The banner computes every remainder against it
      // (`max(0, expires_at − server_now)`, re-fetched on each poll) so a
      // drifted laptop clock can never distort a countdown's remainder.
      server_now: new Date().toISOString(),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    const conversationId =
      typeof body.conversation_id === 'string' ? body.conversation_id : ''
    const action = typeof body.action === 'string' ? body.action : ''
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 },
      )
    }
    if (
      ![
        'cancel',
        'reschedule',
        'schedule',
        'set_enabled',
        'wait_enabled',
        'wait_schedule',
        'wait_reset',
        'wait_cancel',
        'process_now',
      ].includes(action)
    ) {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    const owned = await resolveConversation(supabase, conversationId, accountId)
    if (!owned.ok) {
      return NextResponse.json({ error: owned.error }, { status: owned.status })
    }
    const { conv } = owned

    // Client fallback for the worker: the banner fires this the instant a
    // countdown hits 00:00 so an expired "Esperando respuesta" / follow-up
    // timer is dispatched even if no external cron is pinging the server.
    // FOCUSED: the runners are asked to process ONLY this conversation (the
    // banner's own countdown already reached 00:00, so a small due-grace in
    // the worker absorbs clock skitter instead of the global exact-`<=NOW()`
    // scan skipping the row by microseconds). Same idempotent claim logic
    // and service-role client as the cron route.
    if (action === 'process_now') {
      const now = new Date()
      const [follow, wait] = await Promise.all([
        runDueFollowUps(supabaseAdmin(), now, conversationId),
        runDueResponseWaitTimers(supabaseAdmin(), now, conversationId),
      ])
      console.log(
        `[follow-up] client-triggered FOCUSED sweep for conversation ${conversationId} — follow_ups: ${follow.sent}/${follow.scanned} sent (${follow.cancelled} cancelled, ${follow.noResponse} no_response), response-wait: ${wait.sent}/${wait.scanned} sent (${wait.cancelled} cancelled, ${wait.noResponse} no_response).`,
      )
      return NextResponse.json({
        success: true,
        conversation_id: conversationId,
        scanned: { follow_ups: follow.scanned, response_wait: wait.scanned },
        sent: { follow_ups: follow.sent, response_wait: wait.sent },
      })
    }

    if (action === 'set_enabled') {
      // Per-chat override. `enabled: null` resets to "inherit the account".
      const value = body.enabled
      if (typeof value !== 'boolean' && value !== null) {
        return NextResponse.json(
          { error: 'enabled must be a boolean or null' },
          { status: 400 },
        )
      }
      const { error: upErr } = await supabaseAdmin()
        .from('conversations')
        .update({ follow_up_enabled: value })
        .eq('id', conversationId)
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
      // Turning the chat OFF also drops anything already queued so "off"
      // really means "no more reminders for this thread". A later MANUAL
      // schedule still works (it is independent of the switch).
      if (value === false) {
        const { error: cancelErr } = await supabaseAdmin()
          .from('follow_ups')
          .update({ status: 'cancelled' })
          .eq('conversation_id', conversationId)
          .in('status', ['pending', 'processing'])
        if (cancelErr) {
          console.error(
            `[follow-up] could not clear pending reminders for conversation ${conversationId}:`,
            cancelErr.message,
          )
        }
      }
      console.log(
        `[follow-up] ${userId} set per-chat switch to ${
          value === null ? 'inherit' : value
        } for conversation ${conversationId}.`,
      )
      return NextResponse.json({
        success: true,
        conversation_enabled: value,
      })
    }

    // Timer 2 ON/OFF switch (Switch 2 in the inbox banner). Independent of
    // the Timer 1 `set_enabled`: OFF disables "Esperar respuesta" for this
    // chat only — it cancels any ACTIVE countdown AND blocks future
    // auto-arms until re-enabled. Turning ON alone does NOT arm a timer;
    // the countdown starts on the next outbound message (or via ↻
    // Reiniciar / wait_schedule).
    if (action === 'wait_enabled') {
      const value = body.enabled
      if (typeof value !== 'boolean') {
        return NextResponse.json(
          { error: 'enabled must be a boolean' },
          { status: 400 },
        )
      }
      const { error: upErr } = await supabaseAdmin()
        .from('conversations')
        .update({ response_wait_enabled: value })
        .eq('id', conversationId)
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
      if (value === false) {
        await cancelResponseWaitTimers(supabaseAdmin(), conversationId, 'manual')
      }
      console.log(
        `[follow-up] ${userId} set the "Esperar respuesta" switch to ${value} for conversation ${conversationId}.`,
      )
      return NextResponse.json({
        success: true,
        response_wait_enabled: value,
      })
    }

    // Timer 2 — response-wait. Whole minutes, 1..10080, taken EXACTLY as
    // typed (no defaults/fallbacks). `wait_schedule` and `wait_reset`
    // both UPSERT the conversation's single ACTIVE row (re-arm instead of
    // reject), so neither can stack or duplicate; `wait_reset` explicitly
    // replaces whatever countdown was running with the box's current value.
    // Both are explicit agent actions: they re-enable the Timer 2 switch
    // and arm immediately (even right after a completed cycle, where the
    // worker had flipped the switch OFF). Timer 2 is independent of the
    // Timer 1 ON/OFF switch (an explicit agent action must fire even when
    // automation is off).
    if (action === 'wait_schedule' || action === 'wait_reset') {
      const rawMinutes = Number(body.delay_minutes)
      const delayMinutes =
        Number.isFinite(rawMinutes) && rawMinutes > 0
          ? Math.min(10080, Math.floor(rawMinutes))
          : null
      if (delayMinutes === null) {
        return NextResponse.json(
          { error: 'delay_minutes must be a whole number between 1 and 10080' },
          { status: 400 },
        )
      }
      // Turn the switch back ON so the armed countdown is reflected by the
      // banner's Switch 2 (arming this feature always implies enabling it;
      // the worker no longer flips the switch OFF after a completed cycle).
      const { error: switchErr } = await supabaseAdmin()
        .from('conversations')
        .update({ response_wait_enabled: true })
        .eq('id', conversationId)
      if (switchErr) {
        console.error(
          `[follow-up] could not re-enable the "Esperar respuesta" switch for conversation ${conversationId}:`,
          switchErr.message,
        )
      }
      const res = await scheduleResponseWaitTimer(supabaseAdmin(), {
        conversationId,
        contactId: conv.contact_id,
        accountId,
        delayMinutes,
      })
      if (!res.scheduled) {
        console.error(
          `[follow-up] ${action} could not arm the "Esperar respuesta" timer for conversation ${conversationId}:`,
          res.reason,
        )
        return NextResponse.json({
          success: false,
          scheduled: false,
          id: null,
          expires_at: null,
          reason: res.reason,
          error: `Could not start the "Esperar respuesta" timer (${res.reason}). Please try again.`,
        })
      }
      return NextResponse.json({
        success: true,
        scheduled: true,
        id: res.id,
        expires_at: res.expires_at,
        delay_minutes: delayMinutes,
      })
    }

    if (action === 'wait_cancel') {
      await cancelResponseWaitTimers(supabaseAdmin(), conversationId, 'manual')
      return NextResponse.json({ success: true })
    }

    // Custom delay in minutes — the inbox lets the agent type ANY value
    // (1, 3, 7, 12, 15, …). When present it wins over the stage default and
    // its stage `type` is inferred so the historic "one per type" budget
    // still lines up (≥ 24 h is the 24h stage, everything else the 10m one).
    const rawMinutes = Number(body.delay_minutes)
    const customMinutes =
      Number.isFinite(rawMinutes) && rawMinutes > 0
        ? Math.min(10080, Math.max(1, Math.floor(rawMinutes)))
        : null
    const type = (
      body.type === '24h' ||
      (customMinutes !== null && customMinutes >= 24 * 60)
        ? '24h'
        : '10m'
    ) as FollowUpType

    if (action === 'schedule') {
      // The per-chat switch is the master ON/OFF for this thread. While it
      // is OFF the backend refuses to queue (and the worker refuses to
      // dispatch) — so OFF really means "no reminders for this chat".
      if (conv.follow_up_enabled === false) {
        return NextResponse.json({
          success: false,
          scheduled: false,
          id: null,
          reason: 'disabled',
        })
      }
      // Manual scheduling is bound to the CONVERSATION and always upserts
      // its one pending row. It deliberately bypasses the automatic per-type
      // historic budget, so an agent can re-chase ANY contact — with a
      // phone, a recovered wa_id/BSUID or nothing but an internal id — no
      // public @handle required. The destination is resolved at send time
      // by the shared sender ladder (phone → recovered → wa_id →
      // wa_user_id → recipient_id → username).
      const res = await scheduleManualFollowUp(supabaseAdmin(), {
        conversationId,
        contactId: conv.contact_id,
        accountId,
        type,
        ...(customMinutes !== null
          ? { delayMs: customMinutes * 60 * 1000 }
          : {}),
      })
      return NextResponse.json({
        success: res.scheduled,
        scheduled: res.scheduled,
        id: res.id,
        reason: res.reason,
      })
    }

    if (action === 'cancel') {
      const { error: upErr } = await supabaseAdmin()
        .from('follow_ups')
        .update({ status: 'cancelled' })
        .eq('conversation_id', conversationId)
        .in('status', ['pending', 'processing'])
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
      return NextResponse.json({ success: true })
    }

    // reschedule — move the pending reminder to NOW() + delay_minutes
    // (default keeps the stage's own cadence: 10m → 10m, 24h → 24h).
    const delayMinutes = customMinutes ?? (type === '24h' ? 24 * 60 : 10)
    const { data: grab } = await supabaseAdmin()
      .from('follow_ups')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .order('execute_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (!grab?.id) {
      return NextResponse.json(
        { error: 'No pending follow-up to reschedule' },
        { status: 404 },
      )
    }
    const executeAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString()
    const { data: updated, error: upErr } = await supabaseAdmin()
      .from('follow_ups')
      .update({ execute_at: executeAt })
      .eq('id', grab.id)
      .eq('status', 'pending')
      .select('id, conversation_id, type, status, execute_at')
      .single()
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
    console.log(
      `[follow-up] ${userId} rescheduled ${updated?.id} for conversation ${conversationId} by ${delayMinutes} minutes.`,
    )
    return NextResponse.json({ success: true, follow_up: updated })
  } catch (err) {
    return toErrorResponse(err)
  }
}