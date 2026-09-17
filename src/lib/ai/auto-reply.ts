import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { AI_TOOLS, executeToolCall, loadContactContext } from './tools'
import { calendarConfigured } from '@/lib/calendar'
import { gmailConfigured } from '@/lib/gmail'
import { engineSendAiReply } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import type { ChatMessage } from './types'

/** Maximum tool-call rounds per inbound to avoid infinite loops. */
const MAX_TOOL_ROUNDS = 3

/**
 * Customer-facing fallback when a scheduling tool ran but we could not
 * produce a confirmation with a Meet link (tool threw, or the model ran
 * out of rounds). Sent instead of leaving the customer in silence.
 */
export const AGENDAR_FALLBACK_MESSAGE =
  'Tu cita ha sido procesada, pero tuvimos un inconveniente generando el enlace de Google Meet. Un asesor te contactará en breve.'

interface DispatchArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  /** Meta id (wamid) of the inbound message being answered — used to
   *  keep WhatsApp's typing indicator alive across the multi-part reply. */
  composeMessageId?: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return
    if (conv.ai_autoreply_disabled) return
    if (
      config.autoReplyMaxPerConversation > 0 &&
      conv.ai_reply_count >= config.autoReplyMaxPerConversation
    )
      return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Pre-LLM context is fetched in parallel (knowledge retrieval and
    // the contact profile/citas are independent) so the reply isn't held
    // for two sequential DB + embedding round trips.
    const [knowledge, contactCtx] = await Promise.all([
      retrieveKnowledge(
        db,
        accountId,
        config,
        latestUserMessage(messages),
      ),
      loadContactContext(db, contactId),
    ])

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      contactName: contactCtx?.name,
      contactEmail: contactCtx?.email,
      contactLocation: contactCtx?.location,
      calendarEnabled: calendarConfigured(),
      gmailEnabled: gmailConfigured(),
      citas: contactCtx?.citas,
    })

    // Tool execution loop: the model may request tool calls before
    // producing a final text reply. We feed tool results back and
    // re-generate up to MAX_TOOL_ROUNDS times.
    let finalText = ''
    let finalUsage = null
    let handoff = false
    let toolFallback: string | null = null
    const conversationMessages: ChatMessage[] = [...messages]

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const result = await generateReply({
        config,
        systemPrompt,
        messages: conversationMessages,
        tools: AI_TOOLS,
      })

      finalUsage = result.usage
      handoff = result.handoff

      // If the model returned tool calls, execute them and continue.
      if (result.toolCalls && result.toolCalls.length > 0) {
        const toolResults: ChatMessage[] = []
        for (const tc of result.toolCalls) {
          let output: string
          try {
            output = await executeToolCall(db, accountId, contactId, tc)
          } catch (err) {
            // A thrown tool must never abort the whole turn — that would
            // leave the customer with no message at all. Turn the failure
            // into a tool result the model can relay, and remember a
            // deterministic fallback for the scheduling case.
            console.error(`[ai auto-reply] tool "${tc.name}" threw:`, err)
            if (tc.name === 'agendar_cita') {
              toolFallback = AGENDAR_FALLBACK_MESSAGE
            }
            output =
              tc.name === 'agendar_cita'
                ? AGENDAR_FALLBACK_MESSAGE
                : `Error: la herramienta ${tc.name} no pudo completarse.`
          }
          toolResults.push({
            role: 'tool',
            content: output,
            toolCallId: tc.id,
          })
        }
        // Append the assistant message carrying the requested tool_calls
        // plus the results so the model can reason over them on the next
        // round, then loop for a final reply.
        conversationMessages.push({
          role: 'assistant',
          content: result.text || '',
          toolCalls: result.toolCalls,
        })
        conversationMessages.push(...toolResults)
        continue
      }

      // No tool calls — this is the final text reply.
      finalText = result.text
      break
    }

    // The tool round must NOT be the end of the turn. Force one extra,
    // tool-free generation so the model turns the tool output (the Meet
    // link, the booked time) into a customer-facing confirmation even
    // when the round budget was exhausted by repeated tool calls.
    if (!finalText && !handoff) {
      try {
        const final = await generateReply({
          config,
          systemPrompt,
          messages: conversationMessages,
        })
        finalUsage = final.usage ?? finalUsage
        handoff = final.handoff
        finalText = final.text
      } catch (err) {
        console.error('[ai auto-reply] final confirmation pass failed:', err)
      }
    }

    // Last resort: if a scheduling tool failed and the model still said
    // nothing, send the fallback rather than going silent.
    if (!finalText && !handoff && toolFallback) {
      finalText = toolFallback
    }

    // Record token spend on the account's BYO key.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage: finalUsage,
    })

    if (handoff || !finalText) {
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      }
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      return
    }

    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return

    await engineSendAiReply({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: finalText,
      aiGenerated: true,
      composeMessageId: args.composeMessageId,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
