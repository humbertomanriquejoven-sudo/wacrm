import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { hasPublicUserHandle } from '@/lib/whatsapp/phone-utils'
import {
  scheduleManualFollowUp,
  scheduleResponseWaitTimer,
  cancelResponseWaitTimers,
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
 *         - wait_autoinit  banner self-heal: arm Timer 2 ONLY when it is
 *                          safe to fire (switch ON, no cycle in flight,
 *                          thread actually waiting on the customer)
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
      response_wait_last: waitLast,
      global_enabled: globalEnabled,
      conversation_enabled: owned.conv.follow_up_enabled,
      response_wait_enabled: owned.conv.response_wait_enabled,
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
        'wait_autoinit',
      ].includes(action)
    ) {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    const owned = await resolveConversation(supabase, conversationId, accountId)
    if (!owned.ok) {
      return NextResponse.json({ error: owned.error }, { status: owned.status })
    }
    const { conv } = owned

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
      // banner's Switch 2 (the worker turned it OFF after the last cycle).
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
      return NextResponse.json({
        success: res.scheduled,
        scheduled: res.scheduled,
        id: res.id,
        expires_at: res.expires_at,
        delay_minutes: delayMinutes,
      })
    }

    if (action === 'wait_cancel') {
      await cancelResponseWaitTimers(supabaseAdmin(), conversationId, 'manual')
      return NextResponse.json({ success: true })
    }

    // AUTO-INIT — the banner's self-heal for "the switch says ACTIVO but
    // there is no countdown running" (the timer frozen at 00:00). The
    // inbox calls it when Switch 2 is ON and no USABLE active row exists
    // (no row at all, a missing/expired `expires_at`, or a row the worker
    // never got to close). It is deliberately NOT a blind insert: a timer
    // created here really fires a nudge at 00:00, so it only becomes a
    // REAL row when firing it would be correct.
    //
    //   disabled    → the switch flipped OFF in the meantime; the banner
    //                 keeps its client-side countdown and shows no timer.
    //   processing  → the one-shot worker owns this cycle RIGHT NOW
    //                 (dispatching/completing). Arming here would stack a
    //                 second nudge behind the in-flight one and survive the
    //                 worker's switch-OFF, breaking one-shot.
    //   not_awaiting→ the thread has NO messages, or its last message is
    //                 the customer's (they already replied and the webhook
    //                 cancelled the row — the switch stays ON by design).
    //                 A timer armed here would nudge someone who already
    //                 answered, so the banner shows its local countdown
    //                 instead. Fail-closed on a read error, same as the
    //                 other send gates in this route.
    // Otherwise: `expires_at = NOW() + N` (N = the box's minutes) with
    // `started_at` anchored to our last OUTBOUND message, so the runner's
    // anti-race safety net still cancels it if a reply lands while this
    // very request is being written.
    if (action === 'wait_autoinit') {
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
      if (conv.response_wait_enabled === false) {
        return NextResponse.json({
          success: false,
          scheduled: false,
          reason: 'disabled',
        })
      }
      const { data: processingRow } = await supabase
        .from('response_wait_timers')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('status', 'processing')
        .limit(1)
        .maybeSingle()
      if (processingRow) {
        return NextResponse.json({
          success: false,
          scheduled: false,
          reason: 'processing',
        })
      }
      const { data: lastMsg, error: lastErr } = await supabase
        .from('messages')
        .select('sender_type, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const last = lastMsg as {
        sender_type?: string | null
        created_at?: string | null
      } | null
      if (lastErr || !last || last.sender_type === 'customer') {
        if (lastErr) {
          console.warn(
            `[follow-ups] could not read the last message of conversation ${conversationId} for auto-init: ${lastErr.message}`,
          )
        }
        return NextResponse.json({
          success: false,
          scheduled: false,
          reason: 'not_awaiting',
        })
      }
      const res = await scheduleResponseWaitTimer(supabaseAdmin(), {
        conversationId,
        contactId: conv.contact_id,
        accountId,
        delayMinutes,
        startedAt: last.created_at ?? new Date().toISOString(),
      })
      return NextResponse.json({
        success: res.scheduled,
        scheduled: res.scheduled,
        id: res.id,
        expires_at: res.expires_at,
        delay_minutes: delayMinutes,
        reason: res.reason,
      })
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
      // PUBLIC-HANDLE GATE: a timed follow-up is a BOT message the system
      // sends later without the agent re-confirming, so only contacts with
      // a public @user / @lid handle may be automatable — a phone-only or
      // bare-BSUID contact must never get one. FAIL-CLOSED: an unreadable
      // contact blocks scheduling rather than risk a send. (The worker
      // enforces the same gate again at dispatch.)
      const { data: contact, error: contactErr } = await supabaseAdmin()
        .from('contacts')
        .select('username, phone, wa_id, wa_user_id, recipient_id')
        .eq('id', conv.contact_id)
        .maybeSingle()
      if (
        contactErr ||
        !contact ||
        !hasPublicUserHandle(
          contact as {
            username?: string | null
            phone?: string | null
            wa_id?: string | null
            wa_user_id?: string | null
            recipient_id?: string | null
          },
        )
      ) {
        if (contactErr) {
          console.error(
            `[follow-up] could not read contact ${conv.contact_id} identity:`,
            contactErr.message,
          )
        }
        return NextResponse.json({
          success: false,
          scheduled: false,
          id: null,
          reason: 'not_handle',
        })
      }
      // Manual scheduling is bound to the CONVERSATION and always upserts
      // its one pending row. It deliberately bypasses the automatic
      // per-type historic budget, so an agent can re-chase ANY contact —
      // on any channel shape (@username, hidden id, BSUID…) — without
      // hitting "Couldn't schedule a follow-up for this contact". The
      // destination is resolved at send time by the shared sender.
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