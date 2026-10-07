import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  scheduleFollowUp,
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
  }
}
type ResolveFailure = { ok: false; status: number; error: string }
type Resolved = ResolvedConversation | ResolveFailure

async function resolveConversation(
  supabase: Ctx['supabase'],
  conversationId: string,
  accountId: string,
): Promise<Resolved> {
  const full = await supabase
    .from('conversations')
    .select('id, account_id, contact_id, follow_up_enabled')
    .eq('id', conversationId)
    .maybeSingle()

  let data = (full.data as Record<string, unknown> | null) ?? null
  let error = full.error
  // Migration 063 not applied → retry without the per-chat switch. The
  // thread still loads (switch treated as "inherit"), instead of the whole
  // banner 500-ing and the inbox appearing to hang.
  if (error && isMissingColumnError(error.message)) {
    console.warn(
      '[follow-ups] conversations.follow_up_enabled is absent (migration 063 pending) — serving the legacy projection.',
    )
    const legacy = await supabase
      .from('conversations')
      .select('id, account_id, contact_id')
      .eq('id', conversationId)
      .maybeSingle()
    data = (legacy.data as Record<string, unknown> | null) ?? null
    error = legacy.error
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
      global_enabled: globalEnabled,
      conversation_enabled: owned.conv.follow_up_enabled,
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
    if (!['cancel', 'reschedule', 'schedule', 'set_enabled'].includes(action)) {
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
          .eq('status', 'pending')
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
      // `force: true` — this is an explicit agent action, so it must work
      // independently of the account-wide automation switch and the
      // per-chat override (both of which only govern the AUTOMATIC path).
      const res = await scheduleFollowUp(supabaseAdmin(), {
        conversationId,
        contactId: conv.contact_id,
        accountId,
        type,
        force: true,
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
        .eq('status', 'pending')
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