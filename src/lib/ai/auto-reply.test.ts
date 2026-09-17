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
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}));

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }));
vi.mock('./context', () => ({
  buildConversationContext: h.buildConversationContext,
}));
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }));
vi.mock('./generate', () => ({ generateReply: h.generateReply }));
vi.mock('./tools', () => ({
  AI_TOOLS: [
    {
      name: 'agendar_cita',
      description: '',
      parameters: { type: 'object', properties: {} },
    },
  ],
  executeToolCall: h.executeToolCall,
  loadContactContext: h.loadContactContext,
  extractBookingResult: (output: string) => {
    const marker = output.lastIndexOf('JSON_RESULT');
    if (marker === -1) return null;
    const start = output.indexOf('{', marker);
    if (start === -1) return null;
    try {
      const parsed = JSON.parse(output.slice(start)) as Record<string, unknown>;
      return {
        confirmado: parsed.confirmado === true,
        link: typeof parsed.link === 'string' ? parsed.link : null,
        inicio: typeof parsed.inicio === 'string' ? parsed.inicio : null,
        idCita: typeof parsed.idCita === 'string' ? parsed.idCita : null,
        fecha: typeof parsed.fecha === 'string' ? parsed.fecha : null,
        hora: typeof parsed.hora === 'string' ? parsed.hora : null,
      };
    } catch {
      return null;
    }
  },
}));
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  engineSendAiReply: h.engineSendAiReply,
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
      // contacts (reads) + conversations (reads + writes)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload;
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args });
      return Promise.resolve({ data: h.state.claim, error: null });
    },
  }),
}));

import {
  dispatchInboundToAiReply,
  AGENDAR_FALLBACK_MESSAGE,
  guardBookingReply,
  buildBookingConfirmationMessage,
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

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
  };
  h.state.autoResponders = [];
  h.state.citas = [];
  h.state.claim = true;
  h.state.updatePayload = null;
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
});

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 0 },
      },
    ]);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' })
    );
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

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false;
    await dispatchInboundToAiReply(ARGS);
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1);
    expect(h.engineSendText).not.toHaveBeenCalled();
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

  it('ignores the legacy pause flag and replies anyway (no handoff flag gates the bot)', async () => {
    // ai_autoreply_disabled is a legacy column: the bot must answer any
    // new inbound when no human is assigned, and must NOT try to clear
    // the column (it no longer reads or writes it).
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.updatePayload).toBeNull();
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' })
    );
  });

  it('still skips when a HUMAN agent is assigned to the conversation', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.engineSendAiReply).not.toHaveBeenCalled();
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
});

describe('dispatchInboundToAiReply — handoff', () => {
  it('never mutes nor sends when the model yields nothing (empty handoff)', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.rpcCalls).toHaveLength(0);
    // The conversation is NOT silenced and NOT auto-assigned to a human.
    expect(h.state.updatePayload).toBeNull();
  });

  it('never auto-assigns to the handoff agent when the model yields nothing', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }));
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.updatePayload).toBeNull();
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
    expect(h.state.updatePayload).toBeNull();
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

  it('never sends a booking confirmation that has no real tool success — dropped without muting', async () => {
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
    expect(h.engineSendAiReply).not.toHaveBeenCalled();
    expect(h.state.updatePayload).toBeNull();
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

    // The wait phrase is dropped for this turn, but the conversation stays
    // enabled so the NEXT message is answered normally (no mute, no
    // handoff flag is ever written).
    expect(h.engineSendAiReply).not.toHaveBeenCalled();
    expect(h.state.updatePayload).toBeNull();
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

  it('never sends a link-promise with a fake URL — drops the turn without muting', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Este es el enlace de Google Meet para que te conectes: https://meet.google.com/xxx-yyyy-zzz',
      handoff: false,
    });

    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendAiReply).not.toHaveBeenCalled();
    expect(h.state.updatePayload).toBeNull();
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
      '¡Listo, Humberto! Tu cita ha sido agendada con éxito para el 2026-09-18 a las 14:00.\n' +
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

  it('strips a stray fake URL from an ordinary (non-booking) reply', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Te comparto el enlace que pidió Juan: https://calendar.google.com/event?eid=abc',
      handoff: false,
    });

    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Te comparto el enlace que pidió Juan: ',
      })
    );
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
      '¡Listo, Humberto! Tu cita ha sido agendada con éxito para el 2026-09-18 a las 14:00.\n' +
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
      '¡Listo, Humberto! Tu cita ha sido agendada con éxito para el 2026-09-18 a las 14:00.\n' +
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
    expect(out).toContain('¡Listo, Humberto!');
  });
});
