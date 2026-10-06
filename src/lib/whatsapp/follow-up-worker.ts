import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { engineSendText } from '@/lib/flows/meta-send'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply, stripInternalReasoning } from '@/lib/ai/generate'
import { buildConversationContext } from '@/lib/ai/context'

/**
 * ============================================================
 * TIMED AUTO FOLLOW-UPS — 10 minutes, one per contact, ever.
 * ============================================================
 * When the auto-reply answers an inbound, `scheduleFollowUp` stores a
 * row that is due 10 minutes later. A runner (`runDueFollowUps`,
 * driven by the `/api/whatsapp/follow-ups/cron` endpoint or the
 * optional in-process interval) checks the queue on a cadence, and for
 * each due row verifies the customer truly did NOT reply afterwards —
 * the ANTI-RACE guard: the last message of the conversation must be
 * from the bot/agent, not the customer. Only then does it generate a
 * natural follow-up with the account's AI provider and send it.
 *
 * The hard rule: ONE historical follow-up per contact, ever. Once a
 * contact has a row in `completed` or `no_response`, `scheduleFollowUp`
 * refuses to create another — a customer is never chased twice.
 *
 * All writes run under the service-role client (this code has no
 * `auth.uid()`), and every step is best-effort: a failing provider must
 * never take down the webhook that scheduled the follow-up, or the cron
 * that drains the queue.
 */

/** How far in the future a follow-up is born. */
export const FOLLOW_UP_DELAY_MS = 10 * 60 * 1000
/** Default cadence of the optional in-process runner (ms). */
export const FOLLOW_UP_INTERVAL_DEFAULT_MS = 60 * 1000

/**
 * Terminal states that permanently close a contact's follow-up budget.
 * Once any exists, `scheduleFollowUp` refuses to schedule again.
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
    | 'error'
  id: string | null
}

/**
 * Schedule a 10-minute follow-up for a conversation, unless the contact
 * has already had their one historic follow-up (completed/no_response)
 * or there is already one pending for this conversation.
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
    /** Override for tests; defaults to FOLLOW_UP_DELAY_MS. */
    delayMs?: number
    now?: Date
  },
): Promise<ScheduleFollowUpResult> {
  const { conversationId, contactId, accountId } = params
  const delayMs = params.delayMs ?? FOLLOW_UP_DELAY_MS
  const now = params.now ?? new Date()

  try {
    // LA REGLA: a contact who already got their one follow-up is never
    // chased again — regardless of which conversation it happened in.
    const { data: historic, error: historicErr } = await db
      .from('follow_ups')
      .select('id')
      .eq('contact_id', contactId)
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
        `[follow-up] contact ${contactId} already had its one follow-up — refusing to schedule another.`,
      )
      return { scheduled: false, reason: 'already_followed_up', id: null }
    }

    // Don't stack: one PENDING per conversation. If the customer is being
    // chased and types again meanwhile, the old pending is cancelled by
    // the webhook and this fresh message schedules the next one.
    const { data: pending, error: pendingErr } = await db
      .from('follow_ups')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
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
        type: '10m',
        status: 'pending',
        execute_at: new Date(now.getTime() + delayMs).toISOString(),
      })
      .select('id')
      .single()
    if (error) {
      console.error(
        `[follow-up] could not schedule a follow-up for conversation ${conversationId}:`,
        error.message,
      )
      return { scheduled: false, reason: 'duplicate_pending', id: null }
    }

    console.log(
      `[follow-up] scheduled follow-up ${data?.id} for conversation ${conversationId} in ${delayMs / 1000}s.`,
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
      .eq('status', 'pending')
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
    'message because the customer has not replied in a while. Rules: ' +
    'refer to the LAST topic of the transcript without repeating the exact ' +
    'words of the previous assistant message; never invent facts, dates, ' +
    'links or appointments; no greetings beyond one word; write in the ' +
    'language the customer used; end with a single open question; keep it ' +
    'under ~30 words.'

  try {
    const result = await generateReply({
      config,
      systemPrompt,
      messages: transcript,
    })
    const text = stripInternalReasoning(result.text ?? '').trim()
    return text || GENERIC_REMINDER
  } catch (err) {
    console.error(
      `[follow-up] provider call failed for conversation ${conversationId}; using a generic reminder:`,
      err instanceof Error ? err.message : err,
    )
    return GENERIC_REMINDER
  }
}

/** The last message of a conversation, or null when there is none. */
async function lastMessageSender(
  db: SupabaseClient,
  conversationId: string,
): Promise<'customer' | 'agent' | 'bot' | null> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  return (data as { sender_type: 'customer' | 'agent' | 'bot' }).sender_type
}

export interface RunFollowUpsResult {
  scanned: number
  sent: number
  cancelled: number
  noResponse: number
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
 * Best-effort, never throws to the caller. Idempotent by design: the
 * state transitions below are all guarded on `status='pending'`, so an
 * overlapping invocation cannot double-process a row it already moved.
 */
export async function runDueFollowUps(
  db: SupabaseClient | null = null,
  now: Date = new Date(),
): Promise<RunFollowUpsResult> {
  const result: RunFollowUpsResult = {
    scanned: 0,
    sent: 0,
    cancelled: 0,
    noResponse: 0,
  }

  try {
    // Resolve the client INSIDE the try: `supabaseAdmin()` throws when
    // the service-role env vars are missing, and that must be a logged
    // no-op for the cron, never a 500.
    const client = db ?? supabaseAdmin()

    const { data: due, error } = await client
      .from('follow_ups')
      .select('id, conversation_id, contact_id, account_id')
      .eq('status', 'pending')
      .lte('execute_at', now.toISOString())
      .order('execute_at', { ascending: true })
      .limit(50)

    if (error) {
      console.error('[follow-up] runner scan failed:', error.message)
      return result
    }
    if (!due || due.length === 0) return result

    for (const row of due) {
      const id = row.id as string
      const conversationId = row.conversation_id as string
      const contactId = row.contact_id as string
      const accountId = row.account_id as string
      result.scanned++

      const lastSender = await lastMessageSender(client, conversationId)

      // ANTI-RACE: the customer replied within the window, so the
      // "are you still there?" reminder is obsolete. Cancel — the
      // webhook has already scheduled/cancelled through its own path, but
      // a message that arrived between scans lands here.
      if (lastSender === 'customer') {
        const { error: cancelErr } = await client
          .from('follow_ups')
          .update({ status: 'cancelled' })
          .eq('id', id)
          .eq('status', 'pending')
        if (cancelErr) {
          console.error(`[follow-up] could not cancel ${id} (anti-race):`, cancelErr.message)
        } else {
          result.cancelled++
          console.log(
            `[follow-up] follow-up ${id} cancelled (customer replied before the 10-minute window closed).`,
          )
        }
        continue
      }

      // Resolve the audit user for the outbound insert. `created_by` of the
      // account's ai_configs is the natural owner; fall back to the account
      // id itself (engineSendText only uses it for logs).
      let userId = accountId
      const { data: cfg } = await client
        .from('ai_configs')
        .select('created_by')
        .eq('account_id', accountId)
        .maybeSingle()
      if (cfg?.created_by) userId = cfg.created_by as string

      const text = await buildFollowUpMessage(client, accountId, conversationId)

      try {
        await engineSendText({
          accountId,
          userId,
          conversationId,
          contactId,
          text,
          aiGenerated: true,
        })
      } catch (err) {
        console.error(
          `[follow-up] could not send the follow-up for conversation ${conversationId}:`,
          err instanceof Error ? err.message : err,
        )
        const { error: noRespErr } = await client
          .from('follow_ups')
          .update({ status: 'no_response' })
          .eq('id', id)
          .eq('status', 'pending')
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
        .eq('status', 'pending')
      if (doneErr) {
        console.error(`[follow-up] could not mark ${id} as completed:`, doneErr.message)
        continue
      }
      result.sent++
      console.log(
        `[follow-up] follow-up ${id} completed — reminder delivered for conversation ${conversationId}.`,
      )
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

/**
 * Optional in-process runner started by `src/instrumentation.ts` (or a
 * server bootstrap) when `FOLLOW_UP_WORKER_INTERVAL_SECONDS` is set.
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
      const res = await runDueFollowUps(db)
      if (res.scanned > 0) {
        console.log(
          `[follow-up] worker sweep complete — scanned=${res.scanned} sent=${res.sent} cancelled=${res.cancelled} noResponse=${res.noResponse}`,
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
  // Fire once immediately so a just-deployed worker drains without
  // waiting a full interval.
  void tick()

  return () => {
    if (timer) clearInterval(timer)
    timer = null
  }
}