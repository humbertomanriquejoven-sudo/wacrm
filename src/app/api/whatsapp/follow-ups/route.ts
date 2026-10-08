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
  buildFollowUpMessage,
  GENERIC_REMINDER,
  type FollowUpType,
} from '@/lib/whatsapp/follow-up-worker'
import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message'

type Ctx = Awaited<ReturnType<typeof getCurrentAccount>>

function isMissingColumnError(message: string): boolean {
  return /column .* does not exist|42703|PGRST204|schema cache/i.test(message)
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
      await supabaseAdmin()
        .from('follow_ups')
        .update({ status: 'cancelled' })
        .eq('conversation_id', conversationId)
        .eq('status', 'pending')
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
      const delayMinutes = Math.max(1, Math.min(10080, Number((body as Record<string, unknown>).delay_minutes) || 10))
      const type = ((body as Record<string, unknown>).type as FollowUpType) || 'follow_up'
      const id = await scheduleManualFollowUp(supabaseAdmin(), {
        conversationId,
        contactId: owned.conv.contact_id,
        accountId,
        delayMs: delayMinutes * 60 * 1000,
        type,
      })
      return NextResponse.json({ success: true, id })
    }

    if (action === 'set_enabled') {
      const enabled = (body as Record<string, unknown>).enabled === true || (body as Record<string, unknown>).enabled === 'true'
      await supabaseAdmin()
        .from('conversations')
        .update({ follow_up_enabled: enabled })
        .eq('id', conversationId)
        .eq('account_id', accountId)
      if (!enabled) {
        await supabaseAdmin()
          .from('follow_ups')
          .update({ status: 'cancelled' })
          .eq('conversation_id', conversationId)
          .eq('status', 'pending')
      }
      return NextResponse.json({ success: true, follow_up_enabled: enabled })
    }

    if (action === 'wait_enabled') {
      const enabled = (body as Record<string, unknown>).enabled === true || (body as Record<string, unknown>).enabled === 'true'
      await supabaseAdmin()
        .from('conversations')
        .update({ response_wait_enabled: enabled })
        .eq('id', conversationId)
        .eq('account_id', accountId)
      if (!enabled) {
        await cancelResponseWaitTimers(supabaseAdmin(), conversationId, 'manual')
      }
      return NextResponse.json({ success: true, response_wait_enabled: enabled })
    }

    if (action === 'wait_schedule' || action === 'wait_reset' || action === 'reset') {
      const delayMinutes = Math.max(
        1,
        Math.min(10080, Number((body as Record<string, unknown>).delay_minutes) || ARM_DEFAULT_MINUTES),
      )
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
      const admin = supabaseAdmin()
      let forceText: string = GENERIC_REMINDER

      const buildWithTimeout = async (): Promise<string> => {
        const timeoutMs = 10000
        const buildPromise = buildFollowUpMessage(admin, accountId, conversationId).catch(
          (err) => {
            console.error('[FOLLOW-UP AI FALLBACK]', err instanceof Error ? err.message : err)
            return null
          },
        )
        const timeoutPromise = new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), timeoutMs)
        })
        const built = await Promise.race([buildPromise, timeoutPromise])
        return built || GENERIC_REMINDER
      }

      try {
        forceText = await buildWithTimeout()
      } catch (err) {
        console.error('[FOLLOW-UP AI FALLBACK]', err instanceof Error ? err.message : err)
        forceText = GENERIC_REMINDER
      }

      let forcedSent = false
      try {
        const convRes = await admin
          .from('conversations')
          .select('id, account_id, contact_id')
          .eq('id', conversationId)
          .maybeSingle()
        if (convRes.error) throw convRes.error
        if (!convRes.data) throw new Error('Conversation not found')

        const contactRes = await admin
          .from('contacts')
          .select(
            'id, phone, wa_id, wa_user_id, recipient_id, username, name, profile_name, display_name',
          )
          .eq('id', (convRes.data as Record<string, unknown>).contact_id)
          .maybeSingle()
        if (contactRes.error) throw contactRes.error
        if (contactRes.data) {
          await (sendMessageToConversation as unknown as (arg: unknown) => Promise<unknown>)({
            supabase: admin,
            accountId,
            conversationId,
            text: forceText,
            contact: contactRes.data as unknown,
            autoArm: false,
          })
          forcedSent = true
        }
      } catch (err) {
        if (err instanceof SendMessageError) {
          console.error('[TIMER FORCE-SEND ERROR]', err.code, err.message)
          return NextResponse.json(
            { success: false, error: err.message, code: err.code },
            { status: 400 },
          )
        }
        console.error('[TIMER FORCE-SEND ERROR]', err)
        return NextResponse.json(
          { success: false, error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        )
      }

      try {
        await (runDueFollowUps as unknown as (a: string, s: unknown) => Promise<void>)(accountId, admin)
      } catch (err) {
        console.error('[process_now runDueFollowUps]', err)
      }
      try {
        await (runDueResponseWaitTimers as unknown as (a: string, s: unknown) => Promise<void>)(accountId, admin)
      } catch (err) {
        console.error('[process_now runDueResponseWaitTimers]', err)
      }

      return NextResponse.json({
        success: true,
        forced_sent: forcedSent,
        message: forceText,
      })
    }

    if (action === 'set_type') {
      const id = (body as Record<string, unknown>).id
      if (!id || typeof id !== 'string') {
        return NextResponse.json({ error: 'id required' }, { status: 400 })
      }
      const type = ((body as Record<string, unknown>).type as FollowUpType) || 'follow_up'
      await supabaseAdmin()
        .from('follow_ups')
        .update({ type })
        .eq('id', id)
        .eq('conversation_id', conversationId)
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