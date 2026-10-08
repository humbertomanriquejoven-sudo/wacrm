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
  type RunFollowUpsResult,
  type RunResponseWaitResult,
} from '@/lib/whatsapp/follow-up-worker'

type Ctx = Awaited<ReturnType<typeof getCurrentAccount>>

function isMissingColumnError(message: string): boolean {
  return /column .* does not exist|42703|PGRST204|schema cache/i.test(message)
}

/**
 * The reminder stages the `follow_ups.type` CHECK accepts, in the order a
 * conversation walks them. Anything else — most importantly the legacy
 * `'follow_up'` action name the `schedule` action used to forward verbatim —
 * is not a stage and must never reach an INSERT (it used to die on the
 * constraint and report success anyway).
 */
const FOLLOW_UP_TYPES: FollowUpType[] = ['10m', '24h']

/**
 * Map an arbitrary delay onto the stage that owns it. A manual "+ Programar"
 * takes ANY number of minutes from the inbox, so the stage is derived from
 * the delay: everything under a day is the first (10-minute) reminder, a day
 * or more is the second (24-hour) one.
 */
function followUpTypeForDelay(delayMinutes: number): FollowUpType {
  return delayMinutes >= 24 * 60 ? '24h' : '10m'
}

/** Clamp a caller-supplied minute count to the range the schema supports. */
function clampDelayMinutes(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.max(1, Math.min(10080, Math.floor(parsed)))
}

/**
 * Strict boolean parser for the two inbox toggles. A body that carries no
 * `enabled` flag (or one that is neither a boolean nor 'true'/'false') is a
 * malformed request, not "off": it is rejected with a 400 so a typo can never
 * flip a switch or cancel a queue by accident.
 */
function parseToggle(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

interface ResolvedConversation {
  ok: true
  conv: {
    id: string
    contact_id: string
    follow_up_enabled: boolean | null
    response_wait_enabled: boolean
  }
}
type ResolveFailure = { ok: false; status: number; error: string }
type Resolved = ResolvedConversation | ResolveFailure

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
  }

  if (error) {
    return {
      ok: false,
      status: 500,
      error: error.message,
    }
  }

  if (!data) {
    return {
      ok: false,
      status: 404,
      error: 'Conversation not found or not owned by account',
    }
  }

  const row = data as Record<string, unknown>
  if (row.account_id !== accountId) {
    return {
      ok: false,
      status: 403,
      error: 'Conversation belongs to another account',
    }
  }

  return {
    ok: true,
    conv: {
      id: String(row.id),
      contact_id: String(row.contact_id),
      follow_up_enabled: (row.follow_up_enabled as boolean | null) ?? null,
      response_wait_enabled: (row as Record<string, unknown>).response_wait_enabled !== false,
    },
  }
}

export async function GET(request: Request) {
  try {
    let session: Awaited<ReturnType<typeof requireRole>> | null = null
    try {
      session = await requireRole('agent')
    } catch (err) {
      console.error('[FOLLOW-UP AUTH ERROR]:', err)
    }
    if (!session) {
      return NextResponse.json(
        {
          success: false,
          error: 'Sesión no válida o sin permisos (401/403)',
        },
        { status: 401 },
      )
    }
    const { supabase, accountId } = session

    const url = new URL(request.url)
    const conversationId = url.searchParams.get('conversation_id') ?? ''

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

    const pendingRes = await supabase
      .from('follow_ups')
      .select('id, conversation_id, type, status, execute_at')
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .order('execute_at', { ascending: true })
    if (pendingRes.error) {
      return NextResponse.json({ error: pendingRes.error.message }, { status: 500 })
    }

    const waitTimerRes = await supabase
      .from('response_wait_timers')
      .select('id, conversation_id, status, delay_minutes, started_at, expires_at')
      .eq('conversation_id', conversationId)
      .eq('status', 'active')
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const waitTimer = !waitTimerRes.error ? waitTimerRes.data : null

    const lastRes = await supabase
      .from('response_wait_timers')
      .select('id, conversation_id, status, delay_minutes, cancelled_reason, updated_at')
      .eq('conversation_id', conversationId)
      .neq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    let waitLast: Record<string, unknown> | null = null
    if (lastRes.error && isMissingColumnError(lastRes.error.message)) {
      const legacy = await supabase
        .from('response_wait_timers')
        .select('id, conversation_id, status, delay_minutes, updated_at')
        .eq('conversation_id', conversationId)
        .neq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!legacy.error && legacy.data) waitLast = legacy.data as Record<string, unknown>
    } else if (!lastRes.error && lastRes.data) {
      waitLast = lastRes.data as Record<string, unknown>
    }

    let waitDerived: { expires_at: string; delay_minutes: number } | null = null
    if (!waitTimer && owned.conv.response_wait_enabled) {
      const lastMsgRes = await supabase
        .from('messages')
        .select('sender_type, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const msg = !lastMsgRes.error ? (lastMsgRes.data as Record<string, unknown> | null) : null
      const anchor =
        msg?.created_at && (msg.sender_type === 'agent' || msg.sender_type === 'bot')
          ? Date.parse(String(msg.created_at))
          : NaN
      if (Number.isFinite(anchor)) {
        const lastMinutes = waitLast?.delay_minutes as number | undefined
        const delayMinutes =
          typeof lastMinutes === 'number' && lastMinutes > 0 && lastMinutes <= 10080
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

    let globalEnabled = true
    const cfgRes = await supabase
      .from('ai_configs')
      .select('follow_up_enabled')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!cfgRes.error && cfgRes.data) {
      globalEnabled = (cfgRes.data as Record<string, unknown>).follow_up_enabled !== false
    }

    return NextResponse.json({
      pending: pendingRes.data ?? [],
      response_wait: waitTimer,
      response_wait_derived: waitDerived,
      response_wait_last: waitLast,
      global_enabled: globalEnabled,
      conversation_enabled: owned.conv.follow_up_enabled,
      response_wait_enabled: owned.conv.response_wait_enabled,
      server_now: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[CRITICAL FOLLOW-UP CRASH]:', err)
    const looked = err as { status?: unknown } | null
    if (looked && typeof looked.status === 'number' && looked.status >= 400 && looked.status < 500) {
      return toErrorResponse(err)
    }
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  try {
    let session: Awaited<ReturnType<typeof requireRole>> | null = null
    try {
      session = await requireRole('agent')
    } catch (err) {
      console.error('[FOLLOW-UP AUTH ERROR]:', err)
    }
    if (!session) {
      return NextResponse.json(
        {
          success: false,
          error: 'Sesión no válida o sin permisos (401/403)',
        },
        { status: 401 },
      )
    }
    const { supabase, accountId, userId } = session

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const conversationId =
      typeof (body as Record<string, unknown>).conversation_id === 'string'
        ? ((body as Record<string, unknown>).conversation_id as string)
        : typeof (body as Record<string, unknown>).conversationId === 'string'
          ? ((body as Record<string, unknown>).conversationId as string)
          : ''
    const action = typeof (body as Record<string, unknown>).action === 'string' ? ((body as Record<string, unknown>).action as string) : ''
    if (!conversationId) {
      return NextResponse.json(
        { success: false, error: 'Falta conversation_id' },
        { status: 400 },
      )
    }

    const owned = await resolveConversation(supabase, conversationId, accountId)
    if (!owned.ok) {
      return NextResponse.json(
        { success: false, error: owned.error },
        { status: owned.status },
      )
    }

    if (action === 'cancel') {
      // Both `pending` (queued) and `processing` (claimed by a sweep) are
      // cleared: an explicit cancel must win over an in-flight dispatch.
      const { error: cancelErr } = await supabaseAdmin()
        .from('follow_ups')
        .update({ status: 'cancelled' })
        .eq('conversation_id', conversationId)
        .in('status', ['pending', 'processing'])
      if (cancelErr) {
        return NextResponse.json(
          { success: false, error: cancelErr.message },
          { status: 500 },
        )
      }
      return NextResponse.json({ success: true })
    }

    if (action === 'reschedule') {
      const delayMinutes = Math.max(1, Math.min(10080, Number((body as Record<string, unknown>).delay_minutes) || 10))
      const grab = await supabaseAdmin()
        .from('follow_ups')
        .select('id, conversation_id, type, status, execute_at')
        .eq('conversation_id', conversationId)
        .eq('status', 'pending')
        .order('execute_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (!(grab.data as Record<string, unknown> | null)?.id) {
        return NextResponse.json(
          { error: 'No pending follow-up to reschedule' },
          { status: 404 },
        )
      }
      const executeAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString()
      const updated = await supabaseAdmin()
        .from('follow_ups')
        .update({ execute_at: executeAt })
        .eq('id', (grab.data as Record<string, unknown>).id)
        .eq('status', 'pending')
        .select('id, conversation_id, type, status, execute_at')
        .single()
      if (updated.error) {
        return NextResponse.json({ error: updated.error.message }, { status: 500 })
      }
      console.log(
        `[follow-up] ${userId} rescheduled ${(updated.data as Record<string, unknown> | null)?.id} for conversation ${conversationId} by ${delayMinutes} minutes.`,
      )
      return NextResponse.json({ success: true, follow_up: updated.data })
    }

    if (action === 'schedule') {
      const delayMinutes = clampDelayMinutes(
        (body as Record<string, unknown>).delay_minutes,
        10,
      )

      // The per-chat switch is authoritative for MANUAL scheduling too: the
      // agent turned "Seguimiento automático" OFF for this thread, so a
      // "+ Programar" must refuse instead of queueing a reminder the runner
      // would later cancel. The account-wide/automatic kill switches stay
      // bypassed — this is a hand-timed reminder.
      if (owned.conv.follow_up_enabled === false) {
        console.warn(
          `[follow-up] schedule refused for conversation ${conversationId}: the per-chat switch is OFF.`,
        )
        return NextResponse.json(
          {
            success: false,
            scheduled: false,
            id: null,
            reason: 'disabled',
            error:
              'Seguimiento automático está desactivado para esta conversación. Actívalo para programar un recordatorio.',
          },
          { status: 400 },
        )
      }

      // The stage MUST be one of the values `follow_ups.type` accepts.
      // Forwarding the raw action name here ('follow_up') is what made every
      // manual schedule fail its CHECK while the route still answered
      // `{ success: true }`.
      const type = followUpTypeForDelay(delayMinutes)
      const result = await scheduleManualFollowUp(supabaseAdmin(), {
        conversationId,
        contactId: owned.conv.contact_id,
        accountId,
        delayMs: delayMinutes * 60 * 1000,
        type,
      })

      if (!result?.scheduled) {
        const reason = result?.reason ?? 'error'
        console.error(
          `[follow-up] schedule FAILED for conversation ${conversationId} (type=${type}, delay=${delayMinutes}m): ${reason}`,
        )
        return NextResponse.json(
          {
            success: false,
            scheduled: false,
            id: null,
            reason,
            error: `No se pudo programar el recordatorio (${reason}). Revisa los registros del servidor.`,
          },
          { status: 400 },
        )
      }

      console.log(
        `[follow-up] ${userId} scheduled a manual ${type} reminder for conversation ${conversationId} in ${delayMinutes} min (row ${result.id}).`,
      )
      return NextResponse.json({
        success: true,
        scheduled: true,
        id: result.id,
        type,
        delay_minutes: delayMinutes,
      })
    }

    if (action === 'set_enabled') {
      const enabled = parseToggle((body as Record<string, unknown>).enabled)
      if (enabled === null) {
        return NextResponse.json(
          { success: false, error: 'Falta un valor booleano para `enabled`' },
          { status: 400 },
        )
      }
      const { error: toggleErr } = await supabaseAdmin()
        .from('conversations')
        .update({ follow_up_enabled: enabled })
        .eq('id', conversationId)
        .eq('account_id', accountId)
      if (toggleErr) {
        return NextResponse.json(
          { success: false, error: toggleErr.message },
          { status: 500 },
        )
      }
      if (!enabled) {
        // `processing` included: a switch OFF must beat a sweep that already
        // claimed the row, or the reminder still goes out mid-dispatch.
        const { error: queueErr } = await supabaseAdmin()
          .from('follow_ups')
          .update({ status: 'cancelled' })
          .eq('conversation_id', conversationId)
          .in('status', ['pending', 'processing'])
        if (queueErr) {
          console.error(
            `[follow-up] could not clear the queue for conversation ${conversationId} on switch OFF:`,
            queueErr.message,
          )
        }
      }
      return NextResponse.json({ success: true, follow_up_enabled: enabled })
    }

    if (action === 'wait_enabled') {
      const enabled = parseToggle((body as Record<string, unknown>).enabled)
      if (enabled === null) {
        return NextResponse.json(
          { success: false, error: 'Falta un valor booleano para `enabled`' },
          { status: 400 },
        )
      }
      const { error: waitToggleErr } = await supabaseAdmin()
        .from('conversations')
        .update({ response_wait_enabled: enabled })
        .eq('id', conversationId)
        .eq('account_id', accountId)
      if (waitToggleErr) {
        return NextResponse.json(
          { success: false, error: waitToggleErr.message },
          { status: 500 },
        )
      }
      if (!enabled) {
        await cancelResponseWaitTimers(supabaseAdmin(), conversationId, 'manual')
      }
      return NextResponse.json({ success: true, response_wait_enabled: enabled })
    }

    if (action === 'wait_schedule' || action === 'wait_reset' || action === 'reset') {
      // The countdown length is REQUIRED: defaulting a missing value to 10
      // minutes used to arm a timer the agent never asked for, and a malformed
      // body came back 200. Reject it so the box's own validation is the only
      // source of truth.
      const rawDelay = (body as Record<string, unknown>).delay_minutes
      const parsedDelay = Number(rawDelay)
      if (rawDelay === undefined || rawDelay === null || rawDelay === '' ||
          !Number.isFinite(parsedDelay) || parsedDelay <= 0) {
        return NextResponse.json(
          {
            success: false,
            error: 'delay_minutes es obligatorio y debe ser un número de minutos mayor que 0',
          },
          { status: 400 },
        )
      }
      const delayMinutes = clampDelayMinutes(rawDelay, ARM_DEFAULT_MINUTES)
      if (action !== 'wait_schedule') {
        await cancelResponseWaitTimers(supabaseAdmin(), conversationId, 'manual')
      }
      const res = await scheduleResponseWaitTimer(supabaseAdmin(), {
        conversationId,
        contactId: owned.conv.contact_id,
        accountId,
        delayMinutes,
      })
      if (!res.scheduled) {
        return NextResponse.json(
          {
            success: false,
            scheduled: false,
            id: null,
            expires_at: null,
            reason: res.reason,
            error: `Could not start the "Esperar respuesta" timer (${res.reason}). Please try again.`,
          },
          { status: 400 },
        )
      }
      await supabaseAdmin()
        .from('conversations')
        .update({ response_wait_enabled: true })
        .eq('id', conversationId)
        .eq('account_id', accountId)
      console.log(
        `[RESET BUTTON] ${action === 'wait_reset' || action === 'reset' ? 'Resetting' : 'Scheduling'} timer for conversation ${conversationId} -> New due_at: ${res.expires_at}`,
      )
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

    if (action === 'process_now') {
      // The 00:00 dispatcher. The inbox clock decides a row is due and asks
      // the backend to drain THIS conversation — the same idempotent worker
      // the cron and the in-process interval run, scoped to one thread.
      //
      // It used to build a generic text and force-send it FIRST, then invoke
      // the runners with an argument order they do not accept (the calls threw
      // immediately). That produced two bugs at once: a duplicate message that
      // no timer had asked for, and a sweep that never actually ran. Now the
      // runners own the whole decision — they claim the row atomically, run
      // the anti-race check, generate the copy and send through
      // `sendMessageToConversation`, exactly as the cron does.
      const admin = supabaseAdmin()
      const now = new Date()

      let followUps: RunFollowUpsResult = {
        scanned: 0,
        sent: 0,
        cancelled: 0,
        noResponse: 0,
        scheduled: 0,
      }
      let responseWait: RunResponseWaitResult = {
        scanned: 0,
        sent: 0,
        cancelled: 0,
        noResponse: 0,
      }

      try {
        followUps = await runDueFollowUps(admin, now, conversationId)
      } catch (err) {
        console.error(
          `[process_now] runDueFollowUps threw for conversation ${conversationId}:`,
          err,
        )
      }
      try {
        responseWait = await runDueResponseWaitTimers(admin, now, conversationId)
      } catch (err) {
        console.error(
          `[process_now] runDueResponseWaitTimers threw for conversation ${conversationId}:`,
          err,
        )
      }

      const sent = {
        follow_ups: followUps.sent,
        response_wait: responseWait.sent,
      }
      console.log(
        `[process_now] conversation ${conversationId} swept — followUps: scanned=${followUps.scanned} sent=${followUps.sent} cancelled=${followUps.cancelled} noResponse=${followUps.noResponse} | responseWait: scanned=${responseWait.scanned} sent=${responseWait.sent} cancelled=${responseWait.cancelled} noResponse=${responseWait.noResponse}`,
      )
      if (sent.follow_ups + sent.response_wait === 0) {
        // Not an error on its own (the row may already be claimed, or the
        // anti-race check may have cancelled it), but it must be visible:
        // a "successful" sweep that delivered nothing is exactly the kind of
        // silent failure this endpoint exists to surface.
        console.warn(
          `[process_now] conversation ${conversationId}: sweep executed but nothing was delivered to this conversation (followUps.scanned=${followUps.scanned}, responseWait.scanned=${responseWait.scanned}).`,
        )
      }

      return NextResponse.json({
        success: true,
        sent,
        message_id: null,
        server_now: now.toISOString(),
      })
    }

    if (action === 'set_type') {
      const id = (body as Record<string, unknown>).id
      if (!id || typeof id !== 'string') {
        return NextResponse.json({ error: 'id required' }, { status: 400 })
      }
      const requested = (body as Record<string, unknown>).type as FollowUpType
      // Only a real stage may be written: the CHECK on `follow_ups.type`
      // rejects everything else, and a rejected update used to be reported
      // as a success.
      if (!FOLLOW_UP_TYPES.includes(requested)) {
        return NextResponse.json(
          {
            success: false,
            error: `type must be one of: ${FOLLOW_UP_TYPES.join(', ')}`,
          },
          { status: 400 },
        )
      }
      const { error: typeErr } = await supabaseAdmin()
        .from('follow_ups')
        .update({ type: requested })
        .eq('id', id)
        .eq('conversation_id', conversationId)
      if (typeErr) {
        return NextResponse.json(
          { success: false, error: typeErr.message },
          { status: 500 },
        )
      }
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 })
  } catch (err) {
    console.error('[CRITICAL FOLLOW-UP CRASH]:', err)
    const looked = err as { status?: unknown } | null
    if (looked && typeof looked.status === 'number' && looked.status >= 400 && looked.status < 500) {
      return toErrorResponse(err)
    }
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}