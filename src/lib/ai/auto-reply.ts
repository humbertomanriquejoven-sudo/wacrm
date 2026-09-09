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
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import type { ChatMessage } from './types'

/** Maximum tool-call rounds per inbound to avoid infinite loops. */
const MAX_TOOL_ROUNDS = 3

/**
 * Ventana de debounce para agrupar mensajes consecutivos del mismo cliente.
 * Cuando el usuario envía varios mensajes cortos y rápidos ("Hola", "???",
 * "Hola?"), espera DEBOUNCE_MS desde el último mensaje antes de responder; si
 * llega uno nuevo se reinicia el reloj. El tope MAX_AGGREGATION_MS evita que
 * un flujo constante de mensajes deje la respuesta para siempre.
 */
const DEBOUNCE_MS = 3000
const MAX_AGGREGATION_MS = 10_000

interface DispatchArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
}

interface Pendiente {
  timer: NodeJS.Timeout | null
  resolve: () => void
  promise?: Promise<void>
  inicio: number
  args: DispatchArgs
}

// Una entrada por conversación: el debounce es PER conversación, no global,
// para que dos clientes distintos nunca se bloqueen entre sí.
const pendientes = new Map<string, Pendiente>()

/**
 * Debounce de la entrada del webhook. Programa `ejecutarAutoReply` para
 * DEBOUNCE_MS después del último mensaje recibido en esa conversación y
 * devuelve la misma promesa a todos los webhooks concurrentes del mismo
 * cliente, de forma que el `after()` del route los mantenga vivos hasta que
 * la respuesta se haya generado (y no se quede congelado a mitad de camino).
 */
function programarAutoReply(args: DispatchArgs): Promise<void> {
  const clave = `${args.accountId}:${args.conversationId}`
  const ahora = Date.now()
  let pendiente = pendientes.get(clave)

  if (!pendiente) {
    pendiente = {
      timer: null,
      resolve: () => {},
      inicio: ahora,
      args,
    }
    pendientes.set(clave, pendiente)
    pendiente.promise = new Promise<void>((r) => {
      pendiente!.resolve = r
    })
  } else {
    pendiente.args = args
  }

  // Se dispara lo antes posible de entre [último mensaje + DEBOUNCE, inicio + MAX].
  const vencimiento = Math.min(
    ahora + DEBOUNCE_MS,
    pendiente.inicio + MAX_AGGREGATION_MS,
  )
  if (pendiente.timer) clearTimeout(pendiente.timer)
  pendiente.timer = setTimeout(() => {
    pendientes.delete(clave)
    void ejecutarAutoReply(pendiente!.args).finally(() => pendiente!.resolve())
  }, Math.max(0, vencimiento - Date.now()))

  return pendiente.promise!
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Agrupa mensajes
 * consecutivos del mismo cliente (debounce) y luego ejecuta la respuesta real.
 * Mirrors the flow runner's contract: it owns its try/catch and NEVER throws —
 * a failing or slow LLM call must not affect the webhook's 200 to Meta.
 */
export function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  return programarAutoReply(args)
}

async function ejecutarAutoReply(args: DispatchArgs): Promise<void> {
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

    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    // Load contact context for the system prompt.
    const contactCtx = await loadContactContext(db, contactId)

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      contactName: contactCtx?.name,
      contactEmail: contactCtx?.email,
      contactLocation: contactCtx?.location,
    })

    // Tool execution loop: the model may request tool calls before
    // producing a final text reply. We feed tool results back and
    // re-generate up to MAX_TOOL_ROUNDS times.
    let finalText = ''
    let finalUsage = null
    let handoff = false
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
        for (const tc of result.toolCalls) {
          await executeToolCall(db, accountId, contactId, tc)
        }
        // Append a synthetic assistant message + tool results so the
        // model sees the tools were called, then loop for a final reply.
        conversationMessages.push({
          role: 'assistant',
          content: result.text || '(tool call)',
        })
        continue
      }

      // No tool calls — this is the final text reply.
      finalText = result.text
      break
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

    if (!finalText && !handoff) {
      // El modelo respondió vacío sin pedir handoff: nunca quedarse en
      // silencio. Se retoma la última propuesta enviada o, si no hay,
      // se saluda pidiendo en qué ayudar.
      const ultimaPropuesta = [...messages]
        .reverse()
        .find((m) => m.role === 'assistant' && m.content.trim())
      finalText = ultimaPropuesta
        ? `¡Hola de nuevo! Retomando lo que hablábamos sobre "${ultimaPropuesta.content.trim().slice(0, 120)}", dime, ¿en qué te puedo colaborar el día de hoy?`
        : '¡Hola de nuevo! Dime, ¿en qué te puedo colaborar el día de hoy con tu proyecto?'
    }

    if (handoff) {
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

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: finalText,
      aiGenerated: true,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
