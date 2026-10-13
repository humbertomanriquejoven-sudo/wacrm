import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * ============================================================
 * PER-CONVERSATION AI PAUSE (HUMAN TAKE OVER)
 * ============================================================
 * In this schema a conversation is "paused" for the AI when it has an
 * `assigned_agent_id`: a human pressed "Take over", or a Flow `handoff`
 * node ran with `assign_to`. There is NO `is_paused` / `take_over_status`
 * column — `assigned_agent_id` (or the absence of it) is the single source
 * of truth, and only a manual "Resume AI" clears it again.
 *
 * Every automatic AI send must consult this state IMMEDIATELY before it
 * reaches WhatsApp, because a human can take a thread over at any moment —
 * including while an LLM answer is still being generated, while a Timer 1
 * follow-up is queued, or while a Timer 2 "Esperando respuesta" nudge is
 * about to fire. The gate read at the top of the dispatch (auto-reply) is
 * not enough on its own; these helpers close that race.
 */

/**
 * Raised when an AI-generated send is refused because the conversation is
 * under human takeover. Callers treat it as "nothing was sent" — never as a
 * delivery failure, and never as a reason to retry.
 */
export class AiReplySuppressedError extends Error {
  readonly conversationId: string;
  readonly assignedAgentId: string | null;
  constructor(conversationId: string, assignedAgentId: string | null) {
    super(
      `AI reply suppressed: conversation ${conversationId} is under human takeover` +
        (assignedAgentId ? ` (agent ${assignedAgentId})` : '')
    );
    this.name = 'AiReplySuppressedError';
    this.conversationId = conversationId;
    this.assignedAgentId = assignedAgentId;
  }
}

/**
 * Read the persisted pause state of a conversation.
 *
 * FAIL-OPEN on a read error: a transient DB hiccup must never silence the
 * bot globally (the same convention the send core uses for its own
 * best-effort reads). The primary gate at the top of the dispatch still
 * runs first and is fail-closed there.
 */
export async function isConversationAiPaused(
  db: SupabaseClient,
  conversationId: string
): Promise<boolean> {
  const assigned = await readAssignedAgentId(db, conversationId);
  return assigned !== null;
}

/**
 * The assigned agent id, or `null` when the conversation is not paused /
 * cannot be read (fail-open).
 */
export async function readAssignedAgentId(
  db: SupabaseClient,
  conversationId: string
): Promise<string | null> {
  try {
    const { data, error } = await db
      .from('conversations')
      .select('assigned_agent_id')
      .eq('id', conversationId)
      .maybeSingle();
    if (error) {
      console.error(
        `[ai pause] could not read the pause state of conversation ${conversationId} (fail-open, sending):`,
        error.message
      );
      return null;
    }
    const assigned = (data as { assigned_agent_id?: string | null } | null)
      ?.assigned_agent_id;
    return assigned ?? null;
  } catch (err) {
    console.error(
      `[ai pause] pause-state read threw for conversation ${conversationId} (fail-open, sending):`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Throw `AiReplySuppressedError` when the conversation has a human
 * assigned. Used as the last checkpoint right before an AI reply touches
 * WhatsApp.
 */
export async function assertConversationNotPaused(
  db: SupabaseClient,
  conversationId: string
): Promise<void> {
  const assigned = await readAssignedAgentId(db, conversationId);
  if (assigned) {
    throw new AiReplySuppressedError(conversationId, assigned);
  }
}
