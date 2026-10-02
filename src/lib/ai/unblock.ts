import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * ============================================================
 * AUTO-UNBLOCK ON INBOUND
 * ============================================================
 * Reopens a conversation that an earlier session left muted, the moment the
 * contact writes again.
 *
 * The symptom this exists for: the bot answered fine on brand-new numbers
 * but went permanently silent on contacts with prior history. The cause is
 * accumulated per-conversation state that only old threads have:
 *
 *   * `assigned_agent_id` — set by a Flow `handoff` node with `assign_to`
 *     (flows/engine.ts) or by a manual "Take over", and never cleared
 *     automatically. It is THE pause flag; there is no `is_paused`
 *     column in this schema.
 *   * `status = 'pending'` — written by the same handoff path. Not a gate
 *     by itself, but it is the fingerprint of a stranded handoff.
 *   * `ai_autoreply_disabled` / `ai_reply_count` — legacy columns from the
 *     capped-replies era that could leave a thread muted.
 *
 * A fresh conversation has none of that, which is exactly why new numbers
 * worked and old threads did not.
 *
 * TRADE-OFF — READ BEFORE ENABLING:
 * clearing `assigned_agent_id` on every inbound means a deliberate human
 * takeover no longer holds: the next customer message hands the thread
 * straight back to the bot. Set `AI_AUTOREPLY_AUTO_UNBLOCK=false` to get
 * the previous human-wins behaviour back.
 */

export function autoUnblockEnabled(): boolean {
  // Default ON: the requested behaviour. Set the env var to 'false' to
  // restore human-wins handoff.
  return process.env.AI_AUTOREPLY_AUTO_UNBLOCK !== 'false'
}

export interface UnblockResult {
  changed: boolean
  reasons: string[]
}

/**
 * Clear every silencing flag on a conversation and report what was stuck.
 *
 * Never throws: a failure here must not stop the reply that follows.
 * `phone` is only used for the diagnostic log.
 */
export async function autoUnblockConversation(
  db: SupabaseClient,
  conversationId: string,
  phone?: string | null
): Promise<UnblockResult> {
  const empty: UnblockResult = { changed: false, reasons: [] }

  try {
    // Read what is actually set. Selecting the legacy columns by name would
    // hard-fail on an install that never ran 029, so the state check is
    // done with a narrow select and the UPDATE is attempted regardless —
    // PostgREST ignores no columns, it rejects unknown ones, so the update
    // itself is the best-effort probe.
    const { data: conv, error: readErr } = await db
      .from('conversations')
      .select('assigned_agent_id, status')
      .eq('id', conversationId)
      .maybeSingle()

    if (readErr) {
      console.error(
        `[ai unblock] could not read conversation ${conversationId}:`,
        readErr.message
      )
      return empty
    }
    if (!conv) return empty

    const reasons: string[] = []
    const assigned = (conv as { assigned_agent_id?: string | null })
      .assigned_agent_id
    if (assigned) reasons.push(`assigned_agent_id=${assigned} (human/flow takeover)`)
    const status = (conv as { status?: string | null }).status
    if (status === 'pending') reasons.push('status=pending (flow handoff residue)')

    // Legacy counters can only be read on installs that ran 029; probe them
    // defensively and never let a missing column abort the unblock.
    const legacy = await readLegacyFlags(db, conversationId)
    if (legacy.ai_autoreply_disabled) reasons.push('ai_autoreply_disabled=true')
    if ((legacy.ai_reply_count ?? 0) > 0) {
      reasons.push(`ai_reply_count=${legacy.ai_reply_count}`)
    }

    if (reasons.length === 0) return empty

    const { error: updErr } = await db
      .from('conversations')
      .update({
        assigned_agent_id: null,
        status: 'open',
        ai_autoreply_disabled: false,
        ai_reply_count: 0,
      })
      .eq('id', conversationId)

    if (updErr) {
      // Retry without the legacy columns in case this install lacks 029.
      const { error: retryErr } = await db
        .from('conversations')
        .update({ assigned_agent_id: null, status: 'open' })
        .eq('id', conversationId)
      if (retryErr) {
        console.error(
          `[ai unblock] could not unblock conversation ${conversationId}:`,
          retryErr.message
        )
        return empty
      }
    }

    console.warn(
      `[ai unblock] AUTO-UNBLOCKED conversation ${conversationId} (phone ${phone ?? 'unknown'}) — cleared: ${reasons.join(', ')}. ` +
        'Set AI_AUTOREPLY_AUTO_UNBLOCK=false to keep human takeover sticky.'
    )

    return { changed: true, reasons }
  } catch (err) {
    console.error(
      `[ai unblock] unexpected failure unblocking ${conversationId}:`,
      err
    )
    return empty
  }
}

async function readLegacyFlags(
  db: SupabaseClient,
  conversationId: string
): Promise<{ ai_autoreply_disabled?: boolean; ai_reply_count?: number }> {
  try {
    const { data } = await db
      .from('conversations')
      .select('ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    return (data ?? {}) as { ai_autoreply_disabled?: boolean; ai_reply_count?: number }
  } catch {
    // Columns absent on a pre-029 install — nothing to clear.
    return {}
  }
}

/**
 * End flow runs stranded in `active`.
 *
 * A run left active (customer went silent mid-`collect_input`, or the run
 * was created and never completed) makes `dispatchInboundToFlows` report
 * `consumed: true` for EVERY subsequent inbound, so the AI never gets a
 * turn. That is the second half of "old threads are silent, new ones
 * aren't": only contacts that have already talked to a flow can hold one.
 */
export async function clearStaleFlowRuns(
  db: SupabaseClient,
  conversationId: string
): Promise<number> {
  try {
    const { data, error } = await db
      .from('flow_runs')
      .update({ status: 'timed_out' })
      .eq('conversation_id', conversationId)
      .eq('status', 'active')
      .select('id')

    if (error) {
      // flow_runs is absent on installs without the Flows feature.
      return 0
    }
    const n = data?.length ?? 0
    if (n > 0) {
      console.warn(
        `[ai unblock] cleared ${n} stranded active flow run(s) on conversation ${conversationId} so the AI can answer again`
      )
    }
    return n
  } catch (err) {
    console.error('[ai unblock] clearStaleFlowRuns failed:', err)
    return 0
  }
}