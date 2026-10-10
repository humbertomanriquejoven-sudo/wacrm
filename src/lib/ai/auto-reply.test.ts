import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AiConfig } from './types';

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  engineSendAiReply: vi.fn(),
  executeToolCall: vi.fn(),
  loadContactContext: vi.fn(),
  analyzeDealFromConversation: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    citas: [] as {
      id: string;
      fecha_inicio: string;
      estado: string;
      meet_link?: string | null;
    }[],
    claim: true as boolean,
    rpcError: null as Error | null,
    rateLimit: true,
    updatePayloads: [] as Record<string, unknown>[],
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}));

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }));
vi.mock('./context', () => ({
  buildConversationContext: h.buildConversationContext,
}));
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }));
vi.mock('./generate', async () => {
  const actual =
    await vi.importActual<typeof import('./generate')>('./generate');
  return {
    generateReply: h.generateReply,
    // Real implementation: deterministic CoT stripping applied before the
    // WhatsApp send — keep it real so the guard tests exercise it.
    stripInternalReasoning: actual.stripInternalReasoning,
  };
});
vi.mock('./tools', async () => {
  // The real trailer parser and tool classifier are used on purpose: the
  // grounding behaviour under test (which tools count as a cita mutation, and
  // how a JSON_RESULT is read) lives in them, and a hand-copied stub here is
  // what silently drifts out of sync with the implementation.
  const actual = await vi.importActual<typeof import('./tools')>('./tools');
  return {
    AI_TOOLS: [
      {
        name: 'agendar_cita',
        description: '',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'reagendar_cita',
        description: '',
        parameters: { type: 'object', properties: {} },
      },
    ],
    executeToolCall: h.executeToolCall,
    loadContactContext: h.loadContactContext,
    extractBookingResult: actual.extractBookingResult,
    isCitaMutatingTool: actual.isCitaMutatingTool,
  };
});
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  engineSendAiReply: h.engineSendAiReply,
}));
// Lead scoring runs after a successful send; stubbed here so these
// dispatch tests stay focused on reply behaviour (its own unit tests
// cover the scoring pass).
vi.mock('./deal-analysis', () => ({
  analyzeDealFromConversation: h.analyzeDealFromConversation,
}));
// The real limiter is a module-level singleton with a 30/min budget, so a
// suite that dispatches more than 30 inbounds would start failing purely on
// test count. These tests are about dispatch behaviour, not throttling, and
// `rateLimit:false` re-enables the limiter for the one test that covers it.
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () =>
    h.state.rateLimit
      ? { success: true, remaining: 999, limit: 999, reset: Date.now() }
      : { success: false, remaining: 0, limit: 0, reset: Date.now() },
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { aiAutoReplyAccount: { limit: 30, windowMs: 60_000 } },
}));
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        };
        return chain;
      }
      if (table === 'citas') {
        // latestCitaConLink (real code): .select().eq().eq().not().order()
        //   .limit().maybeSingle(); loadContactContext is mocked, so this
        //   DB path is only exercised by link re-send lookups.
        const chain = {
          select: () => chain,
          eq: () => chain,
          not: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: (h.state.citas[0] ?? null) as Record<
                string,
                unknown
              > | null,
              error: null,
            }),
        };
        return chain;
      }
      if (table === 'follow_ups') {
        // 10-minute auto follow-ups (migration 062). The auto-reply
        // schedules a pending row after a successful send; a no-op chain
        // keeps existing assertions intact while exercising the hook.
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () => chain,
          maybeSingle: () =>
            Promise.resolve({ data: null, error: null }),
          insert: (payload: Record<string, unknown>) => {
            h.state.updatePayloads.push({ __follow_up: true, ...payload });
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: { id: 'fu-mock', ...payload },
                    error: null,
                  }),
              }),
            };
          },
        };
        return chain;
      }
      // contacts (reads) + conversations (reads + writes)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayloads.push(payload);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args });
      if (h.state.rpcError) {
        return Promise.resolve({ data: null, error: h.state.rpcError });
      }
      return Promise.resolve({ data: h.state.claim, error: null });
    },
  }),
}));

import {
  dispatchInboundToAiReply,
  AGENDAR_FALLBACK_MESSAGE,
  REAGENDAR_FALLBACK_MESSAGE,
  guardBookingReply,
  buildBookingConfirmationMessage,
  buildRescheduleConfirmationMessage,
  buildRescheduleFailureMessage,
} from './auto-reply';

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
};

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  };
}

/**
 * The bot must never silence a thread or hand it to a human on its own —
 * not even when it drops a turn. An inbound MAY reset the legacy counter
 * (`ai_reply_count = 0`) and clear the legacy pause flag
 * (`ai_autoreply_disabled = false`), which is what unblocks a thread stuck
 * at an old cap; what it must never do is mute or assign.
 */
function expectNeverMuted() {
  for (const payload of h.state.updatePayloads) {
    expect(payload.ai_autoreply_disabled ?? false).toBe(false);
    expect(payload.assigned_agent_id ?? null).toBeNull();
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
  };
  h.state.autoResponders = [];
  h.state.citas = [];
  h.state.claim = true;
  h.state.rpcError = null;
  h.state.rateLimit = true;
  h.state.updatePayloads = [];
  h.state.rpcCalls = [];
  h.loadAiConfig.mockResolvedValue(aiConfig());
  h.buildConversationContext.mockResolvedValue([
    { role: 'user', content: 'hi' },
  ]);
  h.retrieveKnowledge.mockResolvedValue([]);
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false });
  h.executeToolCall.mockResolvedValue(
    'Cita agendada: 2026-09-18T14:00:00-05:00 (45 minutos) para Carlos. Reunión Meet: https://meet.google.com/abc.\n\n' +
      'JSON_RESULT (no lo repitas en el mensaje al cliente, usa su contenido): ' +
      '{"confirmado":true,"exito":true,"inicio":"2026-09-18T14:00:00-05:00","duracionMin":45,"idCita":"cita-1","link":"https://meet.google.com/abc","fecha":"2026-09-18","hora":"14:00","estado":"confirmada"}'
  );
  h.loadContactContext.mockImplementation(async () => ({
    name: null,
    email: null,
    location: null,
    citas: h.state.citas,
  }));
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' });
  h.engineSendAiReply.mockResolvedValue({ whatsapp_message_id: 'm1' });
  h.analyzeDealFromConversation.mockReset();
  h.analyzeDealFromConversation.mockResolvedValue(undefined);
});

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS);
    // The configured cap is forwarded verbatim when it is a real number.
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ]);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' })
    );
    // Lead scoring is kicked off (best-effort) right after the send, with
    // the same conversation context.
    expect(h.analyzeDealFromConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        userId: 'user-1',
      })
    );
  });

  it('sends 99999 (not 0) when the configured max is 99999 or more', async () => {
    // Regression guard for the permanent-silence bug: the "unlimited"
    // sentinel must NOT be 0. The original claim_ai_reply_slot from
    // migration 029 tests `ai_reply_count < max_replies`, and the counter
    // is reset to 0 on every inbound, so `0 < 0` is false — the RPC
    // refuses the slot and the bot never answers anyone. 99999 passes on
    // the 029, 041 and 046 versions of the function alike.
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ autoReplyMaxPerConversation: 99999 })
    );
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 99999 },
      },
    ]);
    expect(h.engineSendAiReply).toHaveBeenCalled();
  });

  it('never sends max_replies 0, which would mute the thread on the 029 RPC', async () => {
    // Whatever the panel holds — including an empty/invalid value — the
    // RPC must receive a positive cap.
    for (const configured of [0, -5, Number.NaN, 1, 20, 500, 200000]) {
      h.state.rpcCalls.length = 0;
      h.loadAiConfig.mockResolvedValue(
        aiConfig({ autoReplyMaxPerConversation: configured })
      );
      await dispatchInboundToAiReply(ARGS);
      expect(h.state.rpcCalls).toHaveLength(1);
      expect(h.state.rpcCalls[0].args).toMatchObject({
        max_replies: expect.any(Number),
      });
      const sent = (h.state.rpcCalls[0].args as { max_replies: number })
        .max_replies;
      expect(Number.isFinite(sent)).toBe(true);
      expect(sent).toBeGreaterThan(0);
      expect(sent).toBeLessThanOrEqual(99999);
    }
  });

  it('resets the legacy reply counter and pause flag on every inbound', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 17,
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.updatePayloads).toContainEqual({
      ai_reply_count: 0,
      ai_autoreply_disabled: false,
    });
  });

  it('forwards the inbound composeMessageId to the fragment sender', async () => {
    await dispatchInboundToAiReply({ ...ARGS, composeMessageId: 'wamid.IN_1' });

    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ composeMessageId: 'wamid.IN_1' })
    );
  });

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.']);
    await dispatchInboundToAiReply(ARGS);
    expect(h.retrieveKnowledge).toHaveBeenCalled();
    const systemPrompt = h.generateReply.mock.calls[0][0]
      .systemPrompt as string;
    expect(systemPrompt).toContain('Returns accepted within 30 days.');
  });

  it("injects the contact's active citas ids into the system prompt", async () => {
    h.state.citas = [
      {
        id: 'cita-9',
        fecha_inicio: '2026-09-10T10:00:00-05:00',
        estado: 'confirmada',
      },
    ];
    await dispatchInboundToAiReply(ARGS);
    const systemPrompt = h.generateReply.mock.calls[0][0]
      .systemPrompt as string;
    expect(systemPrompt).toContain('idCita="cita-9"');
    expect(systemPrompt).toContain('2026-09-10T10:00:00-05:00');
  });

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }];
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('still sends when the slot claim refuses the slot', async () => {
    // The claim is advisory, not a gate. `ai_reply_count` is reset to 0 on
    // every inbound so no cap can ever be reached, and a stale/missing
    // RPC used to silence the bot for every customer. Losing the claim
    // must never cost the customer their reply.
    h.state.claim = false;
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.rpcCalls).toHaveLength(1);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' })
    );
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('still sends when the slot claim RPC errors', async () => {
    // e.g. the function is missing or service_role lacks EXECUTE.
    h.state.rpcError = new Error('permission denied for function claim_ai_reply_slot');
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' })
    );
  });

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null);
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }));
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('ignores the legacy pause flag, clears it and replies anyway', async () => {
    // ai_autoreply_disabled is a legacy column and no longer GATES the
    // bot: it must answer any new inbound when no human is assigned, and
    // it clears the stale flag on the way so a thread muted by an older
    // version unblocks itself on the next message.
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    };
    await dispatchInboundToAiReply(ARGS);
    expectNeverMuted();
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' })
    );
  });

  it('auto-unblocks an assigned thread by DEFAULT and answers it', async () => {
    // Requested behaviour: a thread left muted by an earlier session must
    // not stay muted when the contact writes again. Only contacts with
    // prior history can be stuck this way, which is why new numbers always
    // worked.
    delete process.env.AI_AUTOREPLY_AUTO_UNBLOCK;
    h.state.conv = {
      assigned_agent_id: 'agent-9',
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.updatePayloads).toContainEqual(
      expect.objectContaining({ assigned_agent_id: null })
    );
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' })
    );
  });

  it('keeps human takeover sticky when AI_AUTOREPLY_AUTO_UNBLOCK=false', async () => {
    // The opt-out preserves the original human-wins semantics.
    process.env.AI_AUTOREPLY_AUTO_UNBLOCK = 'false';
    try {
      h.state.conv = {
        assigned_agent_id: 'agent-9',
      };
      await dispatchInboundToAiReply(ARGS);
      expect(h.engineSendText).not.toHaveBeenCalled();
      expect(h.engineSendAiReply).not.toHaveBeenCalled();
    } finally {
      delete process.env.AI_AUTOREPLY_AUTO_UNBLOCK;
    }
  });

  it('BYPASS: answers anyway when a human is assigned and the flag is on', async () => {
    // AI_AUTOREPLY_BYPASS is the temporary diagnostic switch: it must
    // override the human-handoff gate so we can prove the rest of the
    // pipeline (provider + WhatsApp outbound) is reachable. Off by
    // default so production behaviour is unchanged.
    process.env.AI_AUTOREPLY_BYPASS = 'true';
    try {
      h.state.conv = { assigned_agent_id: 'agent-9' };
      await dispatchInboundToAiReply(ARGS);
      expect(h.engineSendAiReply).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-1' })
      );
    } finally {
      delete process.env.AI_AUTOREPLY_BYPASS;
    }
  });

  it('BYPASS: falls back to an outbound probe when the provider throws', async () => {
    // Separates "the AI provider is broken" from "WhatsApp outbound is
    // broken" — the two look identical from the customer's side.
    process.env.AI_AUTOREPLY_BYPASS = 'true';
    try {
      h.generateReply.mockRejectedValue(
        new Error('401 invalid_api_key from provider')
      );
      await dispatchInboundToAiReply(ARGS);
      expect(h.engineSendAiReply).not.toHaveBeenCalled();
      expect(h.engineSendText).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Test de respuesta automática' })
      );
    } finally {
      delete process.env.AI_AUTOREPLY_BYPASS;
    }
  });

  it('BYPASS off by default: a provider failure still answers the customer', async () => {
    // Golden rule: a turn that got past every deliberate gate must NEVER
    // end without reaching WhatsApp. A dead provider used to leave the
    // customer staring at a typing indicator that never resolved. The
    // fallback is the neutral acknowledgement — it asserts nothing that
    // could be false (no cita, no date, no link).
    delete process.env.AI_AUTOREPLY_BYPASS;
    h.generateReply.mockRejectedValue(new Error('401 invalid_api_key'));
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.engineSendAiReply).toHaveBeenCalledTimes(1);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        contactId: 'contact-1',
        single: true,
        text: '¡Gracias! Recibí tu información. ¿Deseas que agende tu cita ahora?',
      })
    );
  });

  it('a knowledge-base failure does not block the reply', async () => {
    // retrieveKnowledge rejects (dead DB / RPC). The turn must continue and
    // still produce a normal generated reply — not a fallback, not silence.
    delete process.env.AI_AUTOREPLY_BYPASS;
    h.retrieveKnowledge.mockRejectedValue(new Error('connection terminated'));
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendAiReply).toHaveBeenCalledTimes(1);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' })
    );
  });

  it('a knowledge-base hang past the 2.5s ceiling still answers', async () => {
    // The failure mode that froze the thread: the promise never settles, so
    // without a ceiling the whole dispatch would wait forever. Real timers,
    // no fake clock: retrieveKnowledge returns a promise that never resolves.
    delete process.env.AI_AUTOREPLY_BYPASS;
    h.retrieveKnowledge.mockImplementation(() => new Promise<string[]>(() => {}));
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendAiReply).toHaveBeenCalledTimes(1);
  });

  it('a contact-context failure does not block the reply', async () => {
    // loadContactContext has no error handling of its own; unguarded, its
    // rejection cancelled the entire turn through the shared Promise.all.
    delete process.env.AI_AUTOREPLY_BYPASS;
    h.loadContactContext.mockRejectedValue(new Error('contacts read failed'));
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendAiReply).toHaveBeenCalledTimes(1);
  });

  it('skips when the per-conversation cap is reached (a low stored value never blocks)', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ autoReplyMaxPerConversation: 3 })
    );
    h.state.conv = {
      assigned_agent_id: null,
    };
    await dispatchInboundToAiReply(ARGS);
    // The effective cap is 99999, so the AI still answers this inbound.
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' })
    );
  });

  it('replies unlimited when autoReplyMaxPerConversation is 0', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ autoReplyMaxPerConversation: 0 })
    );
    h.state.conv = {
      assigned_agent_id: null,
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' })
    );
  });

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([]);
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips without muting when the account is over its rate limit', async () => {
    h.state.rateLimit = false;
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendAiReply).not.toHaveBeenCalled();
    expectNeverMuted();
  });
});

describe('dispatchInboundToAiReply — handoff', () => {
  it('never mutes, and answers instead of staying silent, when the model yields nothing', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    // Empty turn used to return without sending anything (customer on "seen").
    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).toContain('Recibí tu información');
    // The conversation is NOT silenced and NOT auto-assigned to a human.
    expectNeverMuted();
  });

  it('never auto-assigns to the handoff agent when the model yields nothing', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }));
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    await dispatchInboundToAiReply(ARGS);
    // The ack must NOT claim a human took the conversation: this path never
    // auto-assigns, so promising an advisor would be false.
    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).not.toMatch(/asesor|te contactaremos|un asesor/i);
    expectNeverMuted();
  });
});

describe('dispatchInboundToAiReply — tool-call lifecycle', () => {
  const toolCall = {
    id: 'call-1',
    name: 'agendar_cita',
    arguments: { inicio: '2026-09-18T14:00:00-05:00', nombre: 'Carlos' },
  };

  it('executes the tool, then makes a second LLM pass to confirm with the Meet link', async () => {
    h.generateReply
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [toolCall],
      })
      .mockResolvedValueOnce({
        text: '¡Listo! Tu cita quedó para mañana a las 2:00 PM. Meet: https://meet.google.com/abc',
        handoff: false,
      });

    await dispatchInboundToAiReply(ARGS);

    expect(h.executeToolCall).toHaveBeenCalledTimes(1);
    expect(h.generateReply).toHaveBeenCalledTimes(2);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('https://meet.google.com/abc'),
      })
    );
    // The tool result was fed back to the model on the confirmation pass.
    const secondMessages = h.generateReply.mock.calls[1][0].messages as {
      role: string;
      content: string;
    }[];
    expect(secondMessages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('dispatches the booked confirmation even when repeated tool calls exhaust the round budget', async () => {
    h.generateReply
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [toolCall],
      })
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [toolCall],
      })
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [toolCall],
      })
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [toolCall],
      });

    await dispatchInboundToAiReply(ARGS);

    // 4 loop rounds; the deterministic confirmation skips the forced,
    // tool-free pass because the link is already real and in hand.
    expect(h.generateReply).toHaveBeenCalledTimes(4);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('https://meet.google.com/abc'),
      })
    );
  });

  it('never goes silent when the scheduling tool throws — sends the fallback', async () => {
    h.executeToolCall.mockRejectedValue(new Error('network timeout'));
    h.generateReply
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [toolCall],
      })
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [toolCall],
      })
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [toolCall],
      })
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [toolCall],
      })
      .mockResolvedValueOnce({ text: '', handoff: false });

    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: AGENDAR_FALLBACK_MESSAGE })
    );
    expectNeverMuted();
  });

  it('relays the tool fallback message through the model on the next pass', async () => {
    h.executeToolCall.mockRejectedValue(new Error('boom'));
    h.generateReply
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [toolCall],
      })
      .mockResolvedValueOnce({
        text: AGENDAR_FALLBACK_MESSAGE,
        handoff: false,
      });

    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: AGENDAR_FALLBACK_MESSAGE })
    );
  });

  it('nunca deja el bot congelado: si agendar_cita no confirma y el modelo calla, envía el fallback', async () => {
    h.executeToolCall.mockResolvedValue('Error: ese horario ya está ocupado.');
    h.generateReply
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [toolCall],
      })
      .mockResolvedValueOnce({ text: '', handoff: false })
      .mockResolvedValueOnce({ text: '', handoff: false });

    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: AGENDAR_FALLBACK_MESSAGE })
    );
  });
});

describe('dispatchInboundToAiReply — anti-hallucination guard', () => {
  it('replaces a fake Meet URL invented by the model with the REAL link from the tool', async () => {
    h.executeToolCall.mockResolvedValue(
      'Cita agendada: 2026-09-18T14:00:00-05:00 (45 minutos) para Carlos. Reunión Meet: https://meet.google.com/real-link.\n\n' +
        'JSON_RESULT (no lo repitas en el mensaje al cliente, usa su contenido): ' +
        '{"confirmado":true,"exito":true,"inicio":"2026-09-18T14:00:00-05:00","duracionMin":45,"idCita":"cita-1","link":"https://meet.google.com/real-link","estado":"confirmada"}'
    );
    h.generateReply
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [
          {
            id: 'call-1',
            name: 'agendar_cita',
            arguments: {
              inicio: '2026-09-18T14:00:00-05:00',
              nombre: 'Carlos',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        text: '¡Listo! Agendada tu cita para el jueves a las 2:00 PM. Meet: https://meet.google.com/xxx-yyyy-zzz',
        handoff: false,
      });

    await dispatchInboundToAiReply(ARGS);

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).toContain('https://meet.google.com/real-link');
    expect(sent).not.toContain('xxx-yyyy-zzz');
  });

  it('never sends a booking confirmation that has no real tool success — neutral ack instead of silence', async () => {
    h.buildConversationContext.mockResolvedValue([
      {
        role: 'user',
        content: 'Hola, quiero agendar una cita para mañana a las 10 am',
      },
    ]);
    h.generateReply.mockResolvedValue({
      text: '¡Listo! Agendada tu cita para mañana a las 10:00 AM. Meet: https://meet.google.com/xxx-yyyy-zzz',
      handoff: false,
    });

    await dispatchInboundToAiReply(ARGS);

    expect(h.generateReply).toHaveBeenCalledTimes(1);
    expect(h.executeToolCall).not.toHaveBeenCalled();
    // The fabricated confirmation is still discarded — the guard holds.
    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).not.toContain('xxx-yyyy-zzz');
    expect(sent).not.toContain('meet.google.com');
    expect(sent).not.toMatch(/agendada/i);
    // But the customer is no longer left on "seen".
    expect(sent).toContain('Recibí tu información');
    expectNeverMuted();
  });

  it('never sends an intermediate "un momento…" wait message and does NOT mute the chat', async () => {
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'Hola, ¿cómo estás?' },
    ]);
    h.generateReply.mockResolvedValue({
      text: 'Un momento, por favor: estoy registrando tu cita.',
      handoff: false,
    });

    await dispatchInboundToAiReply(ARGS);

    // The bare wait phrase never reaches the customer, but the conversation
    // stays enabled so the NEXT message is answered normally (no mute, no
    // handoff flag is ever written) — and this turn is no longer silent.
    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).not.toMatch(/un momento/i);
    expect(sent).toContain('Recibí tu información');
    expectNeverMuted();
  });

  it('sends the mandated confirmation with the real link even when the model omits the URL', async () => {
    h.generateReply
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [
          {
            id: 'call-1',
            name: 'agendar_cita',
            arguments: {
              inicio: '2026-09-18T14:00:00-05:00',
              nombre: 'Carlos',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        text: 'Quedó agendada tu cita para el jueves a las 2:00 PM.',
        handoff: false,
      });

    await dispatchInboundToAiReply(ARGS);

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).toContain(
      'cita ha sido agendada con éxito para el 2026-09-18 a las 14:00'
    );
    expect(sent).toContain('https://meet.google.com/abc');
    // La confirmación de una cita REal viaja en UNA sola burbuja.
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ single: true })
    );
  });

  it('greets the contact by their CRM name when available', async () => {
    h.loadContactContext.mockImplementation(async () => ({
      name: 'Carlos',
      email: 'carlos@example.com',
      location: null,
      citas: [],
    }));
    h.generateReply
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [
          {
            id: 'call-1',
            name: 'agendar_cita',
            arguments: {
              inicio: '2026-09-18T14:00:00-05:00',
              nombre: 'Carlos',
            },
          },
        ],
      })
      .mockResolvedValueOnce({ text: '', handoff: false });

    await dispatchInboundToAiReply(ARGS);

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).toContain('¡Listo, Carlos!');
  });

  it('never sends a link-promise with a fake URL — neutral ack instead of silence', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Este es el enlace de Google Meet para que te conectes: https://meet.google.com/xxx-yyyy-zzz',
      handoff: false,
    });

    await dispatchInboundToAiReply(ARGS);

    // The invented URL never leaves the building…
    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).not.toContain('xxx-yyyy-zzz');
    expect(sent).not.toContain('meet.google.com');
    // …but the customer still gets an answer.
    expect(sent).toContain('Recibí tu información');
    expectNeverMuted();
  });

  it('dispatches the confirmation with the REAL link even if the final LLM pass returns empty text', async () => {
    h.generateReply
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [
          {
            id: 'call-1',
            name: 'agendar_cita',
            arguments: {
              inicio: '2026-09-18T14:00:00-05:00',
              nombre: 'Carlos',
            },
          },
        ],
      })
      .mockResolvedValueOnce({ text: '', handoff: false });

    await dispatchInboundToAiReply(ARGS);

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).toBe(
      '¡Listo, Cliente! Tu cita ha sido agendada con éxito para el 2026-09-18 a las 14:00.\n' +
        '\n' +
        'Puedes unirte a la videollamada de Google Meet directamente desde este enlace:\n' +
        'https://meet.google.com/abc'
    );
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ single: true })
    );
  });

  it('dispatches a local confirmation when the booking succeeded but Google timed out (no link)', async () => {
    h.executeToolCall.mockResolvedValue(
      'Cita agendada: 2026-09-18T14:00:00-05:00 (45 minutos), cliente: Carlos. ' +
        '(Google Calendar no disponible; la cita quedó guardada en el CRM con enlace provisional de Meet. Reunión Meet: https://meet.google.com/new)\n\n' +
        'JSON_RESULT (no lo repitas en el mensaje al cliente, usa su contenido): ' +
        '{"confirmado":true,"exito":true,"inicio":"2026-09-18T14:00:00-05:00","duracionMin":45,"idCita":"cita-1","link":null,"fecha":"2026-09-18","hora":"14:00","estado":"confirmada"}'
    );
    h.generateReply
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [
          {
            id: 'call-1',
            name: 'agendar_cita',
            arguments: {
              inicio: '2026-09-18T14:00:00-05:00',
              nombre: 'Carlos',
            },
          },
        ],
      })
      .mockResolvedValueOnce({ text: '', handoff: false });

    await dispatchInboundToAiReply(ARGS);

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).toContain(
      'cita ha sido agendada con éxito para el 2026-09-18 a las 14:00'
    );
    expect(sent).toContain(
      'Puedes unirte a la videollamada de Google Meet directamente desde este enlace:\nhttps://meet.google.com/new'
    );
    expect(sent).not.toContain('calendar.google.com');
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ single: true })
    );
  });

  it('notifica al cliente cuando Google Calendar falla al crear el evento (calendarSynced=false)', async () => {
    h.executeToolCall.mockResolvedValue(
      'Cita agendada: 2026-09-18T14:00:00-05:00 (45 minutos), cliente: Carlos. ' +
        '(Google Calendar no disponible; la cita quedó guardada en el CRM con enlace provisional de Meet. Reunión Meet: https://meet.google.com/new)\n\n' +
        'JSON_RESULT (no lo repitas en el mensaje al cliente, usa su contenido): ' +
        '{"confirmado":true,"exito":true,"calendarSynced":false,"inicio":"2026-09-18T14:00:00-05:00","duracionMin":45,"idCita":"cita-1","link":null,"fecha":"2026-09-18","hora":"14:00","estado":"confirmada"}'
    );
    h.generateReply
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [
          {
            id: 'call-1',
            name: 'agendar_cita',
            arguments: {
              inicio: '2026-09-18T14:00:00-05:00',
              nombre: 'Carlos',
            },
          },
        ],
      })
      .mockResolvedValueOnce({ text: '', handoff: false });

    await dispatchInboundToAiReply(ARGS);

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).toContain('no pudimos crear el evento en Google Calendar');
    expect(sent).toContain('2026-09-18');
    expect(sent).not.toContain('meet.google.com');
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ single: true })
    );
  });

  it('strips a stray fake URL from an ordinary (non-booking) reply', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Te comparto el enlace que pidió Juan: https://calendar.google.com/event?eid=abc',
      handoff: false,
    });

    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Te comparto el enlace que pidió Juan:',
      })
    );
  });

  it('never sends Chain-of-Thought / thinking blocks to WhatsApp', async () => {
    h.generateReply.mockResolvedValue({
      text:
        '<thinking>El cliente pide el enlace de su cita del viernes.</thinking>\n' +
        'Claro, con gusto te doy más información.',
      handoff: false,
    });

    await dispatchInboundToAiReply(ARGS);

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).not.toContain('<thinking>');
    expect(sent).not.toContain('El cliente pide el enlace');
    expect(sent).toBe('Claro, con gusto te doy más información.');
  });

  it('strips label-prefixed monologue (Pensamiento:/Razonamiento:) before send', async () => {
    h.generateReply.mockResolvedValue({
      text:
        'Pensamiento: podría responder en un solo mensaje.\n' +
        'Razonamiento: mantenerlo profesional.\n' +
        'Con gusto te ayudo con tu solicitud.',
      handoff: false,
    });

    await dispatchInboundToAiReply(ARGS);

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).toBe('Con gusto te ayudo con tu solicitud.');
  });
});

describe('dispatchInboundToAiReply — reenvío del enlace ("mándame el link")', () => {
  it('resends the stored Meet link of the latest confirmed cita when asked', async () => {
    h.state.citas = [
      {
        id: 'cita-9',
        fecha_inicio: '2026-09-10T10:00:00-05:00',
        estado: 'confirmada',
        meet_link: 'https://meet.google.com/stored-link',
      },
    ];
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'Mándame el link de la reunión' },
    ]);

    await dispatchInboundToAiReply(ARGS);

    // Deterministic: the stored link is read from the DB and sent in ONE
    // bubble, without any tool call or invented URL.
    expect(h.executeToolCall).not.toHaveBeenCalled();
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('https://meet.google.com/stored-link'),
        single: true,
      })
    );
  });

  it('does not fabricate a link when the contact has no cita with one', async () => {
    h.state.citas = [];
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'Mándame el link de mi cita' },
    ]);
    h.generateReply.mockResolvedValue({
      text: 'Claro, aquí te ayudo con lo que necesites.',
      handoff: false,
    });

    await dispatchInboundToAiReply(ARGS);

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).toBe('Claro, aquí te ayudo con lo que necesites.');
    expect(sent).not.toMatch(/meet\.google\.com/);
  });

  it('a booking made this turn wins over the stored resend', async () => {
    h.state.citas = [
      {
        id: 'cita-9',
        fecha_inicio: '2026-09-10T10:00:00-05:00',
        estado: 'confirmada',
        meet_link: 'https://meet.google.com/stored-old',
      },
    ];
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'Mándame el link de mi cita' },
    ]);
    h.generateReply
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [
          {
            id: 'call-1',
            name: 'agendar_cita',
            arguments: {
              inicio: '2026-09-18T14:00:00-05:00',
              nombre: 'Carlos',
            },
          },
        ],
      })
      .mockResolvedValueOnce({ text: '', handoff: false });

    await dispatchInboundToAiReply(ARGS);

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).toContain('https://meet.google.com/abc');
    expect(sent).not.toContain('stored-old');
  });
});

describe('guardBookingReply — pure function', () => {
  const confirmedLink: Parameters<typeof guardBookingReply>[1] = {
    confirmado: true,
    link: 'https://meet.google.com/real-link',
    inicio: '2026-09-18T14:00:00-05:00',
    idCita: 'cita-1',
    fecha: '2026-09-18',
    hora: '14:00',
  };

  it('keeps text untouched when it already quotes the real link', () => {
    const text =
      'Cita para jueves 14:00. Meet: https://meet.google.com/real-link';
    expect(guardBookingReply(text, confirmedLink)).toBe(text);
  });

  it('replaces every fake link with the real one', () => {
    const out = guardBookingReply(
      'Meet: https://meet.google.com/fake-aaa y evento https://calendar.google.com/event?eid=zzz',
      confirmedLink
    );
    expect(out).toBe(
      'Meet: https://meet.google.com/real-link y evento https://meet.google.com/real-link'
    );
  });

  it('replaces a booking claim without real success with null (handoff) under booking context', () => {
    const out = guardBookingReply(
      '¡Listo! Agendada tu cita. Meet: https://meet.google.com/xxx-yyyy-zzz',
      null,
      { bookingContext: true }
    );
    expect(out).toBeNull();
  });

  it('returns null for an intermediate wait message under booking context', () => {
    const out = guardBookingReply(
      'Un momento, por favor: estoy registrando tu cita.',
      null,
      { bookingContext: true }
    );
    expect(out).toBeNull();
  });

  it('returns null for an intermediate wait message WITHOUT booking context', () => {
    const out = guardBookingReply(
      'Un momento, por favor, esto puede tardar un poco.',
      null
    );
    expect(out).toBeNull();
  });

  it('keeps a non-booking-context claim but still strips its fake URL', () => {
    const out = guardBookingReply(
      '¡Listo! Agendada tu cita. Meet: https://meet.google.com/xxx-yyyy-zzz',
      null
    );
    expect(out).toBe('¡Listo! Agendada tu cita. Meet: ');
  });

  it('never sends a link-promise without a real link — returns null (dangling "enlace:" bubble)', () => {
    expect(
      guardBookingReply(
        'Este es el enlace de Google Meet para que te conectes:',
        null
      )
    ).toBeNull();
    expect(
      guardBookingReply(
        'Este es el enlace de Google Meet para que te conectes: https://meet.google.com/xxx-yyyy-zzz',
        null
      )
    ).toBeNull();
    expect(
      guardBookingReply(
        'Aquí tienes el enlace: https://meet.google.com/xxx',
        null
      )
    ).toBeNull();
  });

  it('strips fake URLs but keeps the text when it does not promise a link', () => {
    const out = guardBookingReply(
      'Puedes confirmar tu pago aquí: https://meet.google.com/xxx',
      null
    );
    expect(out).toBe('Puedes confirmar tu pago aquí: ');
  });

  it('never sends a raw timezone timestamp — it is stripped from the bubble', () => {
    const out = guardBookingReply(
      'El horario disponible es de 17:32:11 -05:00 a 18:17:11 -05:00.',
      null
    );
    expect(out).toBe('El horario disponible es de a .');
    expect(
      guardBookingReply(
        'Tu cita quedó para 2026-09-18T14:00:00-05:00.',
        null
      )
    ).toBe('Tu cita quedó para .');
  });

  it('returns null when the only content was a raw timestamp', () => {
    expect(guardBookingReply('2026-09-17T17:32:11-05:00', null)).toBeNull();
    expect(guardBookingReply('17:32:11 -05:00', null)).toBeNull();
  });

  it('keeps friendly dates/times while stripping raw ones', () => {
    const out = guardBookingReply(
      'Agendamos para el 2026-09-18 a las 14:00 (evento 2026-09-18T14:00:00-05:00).',
      null
    );
    expect(out).toBe('Agendamos para el 2026-09-18 a las 14:00 (evento ).');
  });
});

describe('buildBookingConfirmationMessage — pure function', () => {
  it('returns null when the booking is not confirmed', () => {
    expect(
      buildBookingConfirmationMessage({
        confirmado: false,
        link: null,
        inicio: null,
        idCita: null,
        fecha: null,
        hora: null,
      })
    ).toBeNull();
  });

  it('guarantees the Meet fallback URL when Google timed out (no link)', () => {
    const out = buildBookingConfirmationMessage({
      confirmado: true,
      link: null,
      inicio: null,
      idCita: null,
      fecha: '2026-09-18',
      hora: '14:00',
    });
    expect(out).toContain(
      'cita ha sido agendada con éxito para el 2026-09-18 a las 14:00'
    );
    expect(out).toBe(
      '¡Listo, Cliente! Tu cita ha sido agendada con éxito para el 2026-09-18 a las 14:00.\n' +
        '\n' +
        'Puedes unirte a la videollamada de Google Meet directamente desde este enlace:\n' +
        'https://meet.google.com/new'
    );
  });

  it('builds the mandated confirmation format with fecha, hora and link', () => {
    expect(
      buildBookingConfirmationMessage(
        {
          confirmado: true,
          link: 'https://meet.google.com/real-link',
          inicio: '2026-09-18T14:00:00-05:00',
          idCita: 'cita-1',
          fecha: '2026-09-18',
          hora: '14:00',
        },
        null
      )
    ).toBe(
      '¡Listo, Cliente! Tu cita ha sido agendada con éxito para el 2026-09-18 a las 14:00.\n' +
        '\n' +
        'Puedes unirte a la videollamada de Google Meet directamente desde este enlace:\n' +
        'https://meet.google.com/real-link'
    );
  });

  it('uses the provided contact name in the greeting', () => {
    expect(
      buildBookingConfirmationMessage(
        {
          confirmado: true,
          link: 'https://meet.google.com/real-link',
          inicio: '2026-09-18T14:00:00-05:00',
          idCita: 'cita-1',
          fecha: '2026-09-18',
          hora: '14:00',
        },
        'Carlos'
      )
    ).toContain('¡Listo, Carlos!');
  });

  it('falls back to inicio when fecha/hora are missing from the JSON_RESULT', () => {
    const out = buildBookingConfirmationMessage(
      {
        confirmado: true,
        link: 'https://meet.google.com/real-link',
        inicio: '2026-09-18T14:00:00-05:00',
        idCita: 'cita-1',
        fecha: null,
        hora: null,
      },
      null
    );
    expect(out).toContain('para el 2026-09-18 a las 14:00');
    expect(out).toContain('¡Listo, Cliente!');
  });
});

// ============================================================================
// Rescheduling regressions.
//
// The dangerous failure here is a confirmation that does not match reality:
// either a move that silently became a NEW booking, or a "listo, la movimos"
// for a patch that never happened. These tests pin the reply to the tool's
// structured result instead of the model's prose.
// ============================================================================
describe('dispatchInboundToAiReply — reschedule grounding', () => {
  const rescheduleCall = {
    id: 'call-1',
    name: 'reagendar_cita',
    arguments: { nuevoInicio: '2026-09-22T09:00:00-05:00' },
  };

  const okTrailer =
    'Cita reagendada al 2026-09-22T09:00:00-05:00.\n\n' +
    'JSON_RESULT (no lo repitas en el mensaje al cliente, usa su contenido): ' +
    '{"accion":"reagendar","confirmado":true,"exito":true,"calendarSynced":true,' +
    '"inicio":"2026-09-22T09:00:00-05:00","idCita":"cita-1",' +
    '"link":"https://meet.google.com/new-room","fecha":"2026-09-22","hora":"09:00"}';

  it('confirms the move with the NEW link and discards the model prose', async () => {
    h.generateReply
      .mockResolvedValueOnce({ text: '', handoff: false, toolCalls: [rescheduleCall] })
      // The model volunteers the stale link of the slot the customer left.
      .mockResolvedValueOnce({
        text: '¡Listo! La movimos al martes 22 a las 9:00 AM. Meet: https://meet.google.com/old-room',
        handoff: false,
      });
    h.executeToolCall.mockResolvedValue(okTrailer);

    await dispatchInboundToAiReply(ARGS);

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).toContain('https://meet.google.com/new-room');
    expect(sent).not.toContain('old-room');
    expect(sent).toContain('reagendada');
  });

  it('never claims success when the move failed — keeps the original slot', async () => {
    h.generateReply
      .mockResolvedValueOnce({ text: '', handoff: false, toolCalls: [rescheduleCall] })
      .mockResolvedValueOnce({
        text: '¡Listo! Ya la movimos al martes 22 a las 9:00 AM.',
        handoff: false,
      });
    h.executeToolCall.mockResolvedValue(
      'No se pudo reagendar.\n\n' +
        'JSON_RESULT (no lo repitas en el mensaje al cliente, usa su contenido): ' +
        '{"accion":"reagendar","confirmado":false,"exito":false,"motivo":"horario_ocupado","calendarSynced":false}'
    );

    await dispatchInboundToAiReply(ARGS);

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).toContain('ya está ocupado');
    expect(sent).toContain('horario original');
    expect(sent).not.toMatch(/¡Listo!|quedó|movimos|listo/i);
  });

  it('offers a new booking when there is nothing to reschedule (no compensating create)', async () => {
    h.generateReply
      .mockResolvedValueOnce({ text: '', handoff: false, toolCalls: [rescheduleCall] })
      .mockResolvedValueOnce({ text: 'Entendido.', handoff: false });
    h.executeToolCall.mockResolvedValue(
      'No encontré ninguna cita previa activa.\n\n' +
        'JSON_RESULT (no lo repitas en el mensaje al cliente, usa su contenido): ' +
        '{"accion":"reagendar","confirmado":false,"exito":false,"motivo":"sin_cita_previa"}'
    );

    await dispatchInboundToAiReply(ARGS);

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    expect(sent).toContain('encontré ninguna cita previa');
    expect(sent).toContain('agendo una nueva');
    // Exactly one tool round: the model must not "fix" this with agendar_cita.
    expect(h.executeToolCall).toHaveBeenCalledTimes(1);
    expect(h.executeToolCall.mock.calls[0][3].name).toBe('reagendar_cita');
  });

  it('never goes silent when the reschedule tool throws', async () => {
    h.generateReply.mockResolvedValue({
      text: '',
      handoff: false,
      toolCalls: [rescheduleCall],
    });
    h.executeToolCall.mockRejectedValue(new Error('network timeout'));

    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: REAGENDAR_FALLBACK_MESSAGE })
    );
  });

  it('does not touch the provider when the CRM row has no remote event', async () => {
    h.generateReply
      .mockResolvedValueOnce({ text: '', handoff: false, toolCalls: [rescheduleCall] })
      .mockResolvedValueOnce({ text: 'Entendido.', handoff: false });
    h.executeToolCall.mockResolvedValue(
      'Cita movida solo en el CRM.\n\n' +
        'JSON_RESULT (no lo repitas en el mensaje al cliente, usa su contenido): ' +
        '{"accion":"reagendar","confirmado":true,"exito":true,"calendarSynced":false,' +
        '"inicio":"2026-09-22T09:00:00-05:00","idCita":"cita-1","link":"https://meet.google.com/old-room"}'
    );

    await dispatchInboundToAiReply(ARGS);

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string;
    // calendarSynced:false must never reach the customer as a confirmation.
    expect(sent).not.toMatch(/¡Listo!|reagendada con éxito/i);
    expect(h.engineSendAiReply).toHaveBeenCalledTimes(1);
  });
});

describe('reschedule message builders', () => {
  const base = {
    inicio: '2026-09-22T09:00:00-05:00',
    fecha: '2026-09-22',
    hora: '09:00',
    idCita: 'cita-1',
  };

  it('buildRescheduleConfirmationMessage returns null unless confirmed', () => {
    expect(
      buildRescheduleConfirmationMessage(
        { ...base, confirmado: false, exito: false, link: 'https://meet.google.com/x' },
        'Ana'
      )
    ).toBeNull();
  });

  it('buildRescheduleConfirmationMessage carries the returned link', () => {
    const out = buildRescheduleConfirmationMessage(
      { ...base, confirmado: true, exito: true, link: 'https://meet.google.com/new-room' },
      'Ana'
    );
    expect(out).toContain('Ana');
    expect(out).toContain('2026-09-22');
    expect(out).toContain('09:00');
    expect(out).toContain('https://meet.google.com/new-room');
  });

  it('buildRescheduleFailureMessage returns null on success', () => {
    expect(
      buildRescheduleFailureMessage(
        { ...base, confirmado: true, exito: true, link: '' },
        'Ana'
      )
    ).toBeNull();
  });

  it('buildRescheduleFailureMessage distinguishes busy from provider error', () => {
    expect(
      buildRescheduleFailureMessage(
        { ...base, confirmado: false, exito: false, motivo: 'horario_ocupado', link: '' },
        'Ana'
      )
    ).toContain('ese horario ya está ocupado');
    expect(
      buildRescheduleFailureMessage(
        { ...base, confirmado: false, exito: false, motivo: 'error_proveedor', link: '' },
        'Ana'
      )
    ).toContain('sin cambios');
  });

  it('guardBookingReply lets the authoritative reschedule text through', () => {
    // The deterministic confirmation contains no link of its own beyond the
    // one the provider returned, so the guard must not strip it as a "fake"
    // booking claim.
    const booking = {
      ...base,
      accion: 'reagendar' as const,
      confirmado: true,
      exito: true,
      link: 'https://meet.google.com/new-room',
    };
    const msg = buildRescheduleConfirmationMessage(booking, 'Ana') as string;
    expect(guardBookingReply(msg, booking)).toBe(msg);
  });
});
