import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ conversationId: string }> }

/**
 * POST /api/ai/autoreply/[conversationId]  (agent+)
 *
 * Hand control of one conversation back and forth between the inbox and
 * the AI bot — the "Take over" / "Resume AI" banner.
 *
 * Body: { paused: boolean, assign_to_me?: boolean }
 *   - paused: true  → a human is taking over the thread. When
 *                     `assign_to_me` is set (the usual "Take over" flow),
 *                     the thread is assigned to the caller; assignment
 *                     fires the `on_conversation_assigned` trigger.
 *   - paused: false → hand the thread back to the bot: release ANY
 *                     assignment so the AI resumes replying.
 *
 * There is NO pause/handoff flag anymore (ai_autoreply_disabled is
 * legacy): the bot's only eligibility rule is "no human assigned", and
 * a human accountable for the thread is expressed purely as
 * `assigned_agent_id`. The request key is still called `paused` for
 * backwards compatibility with the banner.
 *
 * Writes go through the RLS-scoped SSR client, so a conversation outside
 * the caller's account simply isn't found (404).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    // Reuse the send bucket: this is a cheap per-user inbox action and
    // toggling it in a tight loop has no legitimate use.
    const limit = checkRateLimit(`ai-takeover:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { conversationId } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body.paused !== 'boolean') {
      return NextResponse.json(
        { error: 'paused (boolean) is required' },
        { status: 400 },
      )
    }
    const paused = body.paused as boolean
    const assignToMe = body.assign_to_me === true

    // Confirm the conversation is in the caller's account before writing.
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (convErr) {
      console.error('[ai/autoreply] conversation lookup error:', convErr)
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 },
      )
    }
    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const update: Record<string, unknown> = {}

    if (paused) {
      // "Take over": el agente humano queda asignado — única condición que
      // detiene el bot. Sin flag de pausa.
      if (assignToMe) update.assigned_agent_id = userId
    } else {
      // "Resume AI": liberar CUALQUIER asignación (no solo la del caller)
      // — la puerta de elegibilidad del auto-reply se detiene cuando hay
      // un humano asignado, así que dejar un assignee viejo mantendría el
      // bot mudo y haría "Resume AI" un no-op. Es la decisión explícita
      // de devolverle el hilo al bot.
      update.assigned_agent_id = null
    }

    const { error: upErr } = await supabase
      .from('conversations')
      .update(update)
      .eq('id', conversationId)
      .eq('account_id', accountId)
    if (upErr) {
      console.error('[ai/autoreply] update error:', upErr)
      return NextResponse.json(
        { error: 'Failed to update conversation' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, paused })
  } catch (err) {
    return toErrorResponse(err)
  }
}
