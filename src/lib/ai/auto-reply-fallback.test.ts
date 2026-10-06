import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AiConfig } from './types';
import { AiError, AiKeyDecryptError } from './types';

// REGLA DE ORO tests: a failing provider / an undecryptable key / a broken
// context load must never leave the customer without a WhatsApp reply, and
// every failure must be logged with provider, model and HTTP status.
//
// Same hoisted mock scaffold as auto-reply.test.ts (independent module
// registry per test file), trimmed to what these paths touch.

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
    aiConfigRow: null as Record<string, unknown> | null,
    claim: true as boolean,
    rateLimit: true,
    updatePayloads: [] as Record<string, unknown>[],
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}));

vi.mock('./config', () => ({
  loadAiConfig: h.loadAiConfig,
}));
vi.mock('./context', () => ({
  buildConversationContext: h.buildConversationContext,
}));
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }));
vi.mock('./generate', () => ({
  generateReply: h.generateReply,
  stripInternalReasoning: (text: string) => text,
}));
vi.mock('./tools', () => ({
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
  extractBookingResult: () => null,
  isCitaMutatingTool: () => false,
}));
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  engineSendAiReply: h.engineSendAiReply,
}));
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
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        };
        return chain;
      }
      if (table === 'ai_configs') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: h.state.aiConfigRow, error: null }),
            }),
          }),
        };
      }
      if (table === 'citas') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          not: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        };
        return chain;
      }
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
      return Promise.resolve({ data: h.state.claim, error: null });
    },
  }),
}));

import { dispatchInboundToAiReply } from './auto-reply';

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
};

const ACK_TEXT =
  '¡Gracias! Recibí tu información. ¿Deseas que agende tu cita ahora?';

/** Minimal structural type so spy callbacks get real parameter types. */
interface TestSpy {
  mock: { calls: unknown[][] };
  mockRestore(): void;
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash-lite',
    apiKey: 'sk-or-v1-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 99999,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  };
}

let errorSpy: TestSpy;
let warnSpy: TestSpy;
let logSpy: TestSpy;

beforeEach(() => {
  h.state.conv = { assigned_agent_id: null };
  h.state.autoResponders = [];
  h.state.aiConfigRow = null;
  h.state.claim = true;
  h.state.rateLimit = true;
  h.state.updatePayloads = [];
  h.state.rpcCalls = [];
  h.loadAiConfig.mockReset();
  h.buildConversationContext.mockReset();
  h.retrieveKnowledge.mockReset();
  h.generateReply.mockReset();
  h.engineSendAiReply.mockReset();
  h.engineSendText.mockReset();

  h.loadAiConfig.mockResolvedValue(aiConfig());
  h.buildConversationContext.mockResolvedValue([
    { role: 'user', content: 'hola' },
  ]);
  h.retrieveKnowledge.mockResolvedValue([]);
  h.generateReply.mockResolvedValue({ text: '¡Hola! ¿En qué te ayudo?', handoff: false });
  h.engineSendAiReply.mockResolvedValue({ whatsapp_message_id: 'm1' });
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' });

  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
  vi.restoreAllMocks();
});

/** Find a structured log line by its exact tag. */
function logged(spy: TestSpy, tag: string) {
  return spy.mock.calls.find((call: unknown[]) => (call[0] as string) === tag);
}

describe('simulated inbound — provider failures (REGLA DE ORO)', () => {
  it('logs provider/model/upstream status and sends the contingency ack when OpenRouter rejects the key', async () => {
    h.generateReply.mockRejectedValue(
      new AiError('OpenRouter rejected the API key: Invalid API key', {
        code: 'invalid_key',
        status: 401,
        upstreamStatus: 401,
      }),
    );

    await dispatchInboundToAiReply(ARGS);

    const failure = logged(errorSpy, '[ai auto-reply] provider_failure');
    expect(failure).toBeDefined();
    expect(failure?.[1]).toMatchObject({
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash-lite',
      code: 'invalid_key',
      status: 401,
      upstream_status: 401,
      conversationId: 'conv-1',
      message: expect.stringContaining('Invalid API key'),
    });

    // The customer is NOT left on "seen".
    expect(h.engineSendAiReply).toHaveBeenCalledTimes(1);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: ACK_TEXT,
        aiGenerated: true,
        single: true,
      }),
    );
  });

  it('logs a 402 out-of-credit failure with its upstream status and still answers', async () => {
    h.generateReply.mockRejectedValue(
      new AiError(
        'OpenRouter API error (402): Insufficient credits',
        { code: 'provider_error', status: 502, upstreamStatus: 402 },
      ),
    );

    await dispatchInboundToAiReply(ARGS);

    const failure = logged(errorSpy, '[ai auto-reply] provider_failure');
    expect(failure?.[1]).toMatchObject({
      code: 'provider_error',
      status: 502,
      upstream_status: 402,
      message: expect.stringContaining('Insufficient credits'),
    });
    expect(h.engineSendAiReply).toHaveBeenCalledTimes(1);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: ACK_TEXT }),
    );
  });

  it('treats an empty model response as a failure and answers with the ack instead of silence', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: false });

    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendAiReply).toHaveBeenCalledTimes(1);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: ACK_TEXT }),
    );
    const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(logs.some((line) => line.includes('no final text'))).toBe(true);
  });
});

describe('simulated inbound — config and context failures (REGLA DE ORO)', () => {
  it('logs config_load_failed and sends the ack when the stored key cannot be decrypted', async () => {
    h.loadAiConfig.mockRejectedValue(new Error('bad decrypt: state mismatch'));

    await dispatchInboundToAiReply(ARGS);

    const failure = logged(errorSpy, '[ai auto-reply] config_load_failed');
    expect(failure?.[1]).toMatchObject({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      message: expect.stringContaining('bad decrypt'),
    });
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendAiReply).toHaveBeenCalledTimes(1);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: ACK_TEXT }),
    );
  });

  it('logs the greppable [CRITICAL_AI_KEY_ERROR] line for an ENCRYPTION_KEY mismatch and still acks', async () => {
    h.loadAiConfig.mockRejectedValue(
      new AiKeyDecryptError('Stored AI API key could not be decrypted'),
    );

    await dispatchInboundToAiReply(ARGS);

    const critical = errorSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .find((line) => line.includes('[CRITICAL_AI_KEY_ERROR]'));
    expect(critical).toContain('Verifica ENCRYPTION_KEY');
    expect(h.engineSendAiReply).toHaveBeenCalledTimes(1);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: ACK_TEXT }),
    );
  });

  it('logs context_load_failed and sends the ack when the transcript query blows up', async () => {
    h.buildConversationContext.mockRejectedValue(
      new Error('connection reset'),
    );

    await dispatchInboundToAiReply(ARGS);

    const failure = logged(errorSpy, '[ai auto-reply] context_load_failed');
    expect(failure?.[1]).toMatchObject({
      conversationId: 'conv-1',
      message: expect.stringContaining('connection reset'),
    });
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendAiReply).toHaveBeenCalledTimes(1);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: ACK_TEXT }),
    );
  });

  it('answers the contingency when the row is enabled but has no API key', async () => {
    h.loadAiConfig.mockResolvedValue(null);
    h.state.aiConfigRow = {
      is_active: true,
      auto_reply_enabled: true,
      api_key: null,
    };

    await dispatchInboundToAiReply(ARGS);

    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendAiReply).toHaveBeenCalledTimes(1);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: ACK_TEXT }),
    );
    const warns = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      warns.some((line) => line.includes('key_present=false')),
    ).toBe(true);
  });

  it('stays silent when the toggles are deliberately off (logged, no send)', async () => {
    h.loadAiConfig.mockResolvedValue(null);
    h.state.aiConfigRow = {
      is_active: false,
      auto_reply_enabled: false,
      api_key: 'enc:x',
    };

    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendAiReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
    const warns = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      warns.some((line) => line.includes('is_active=false')),
    ).toBe(true);
  });

  it('never sends the fallback for a suppressed message (Flow/reaction owns it)', async () => {
    h.loadAiConfig.mockRejectedValue(new Error('bad decrypt'));

    await dispatchInboundToAiReply({ ...ARGS, suppressReply: true });

    expect(h.engineSendAiReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
    const warns = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warns.some((line) => line.includes('fallback_skipped'))).toBe(true);
  });
});

describe('simulated inbound — knowledge retrieval fails open', () => {
  it('answers without the knowledge base when retrieval rejects', async () => {
    h.retrieveKnowledge.mockRejectedValue(new Error('embeddings down'));

    await dispatchInboundToAiReply(ARGS);

    // Fail-open: the RAG failure is logged and the reply still goes out.
    const failure = logged(errorSpy, '[ai auto-reply] knowledge retrieval unavailable for account acct-1 — continuing WITHOUT the knowledge base so the customer still gets an answer:');
    expect(failure).toBeDefined();
    expect(h.engineSendAiReply).toHaveBeenCalledTimes(1);
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: '¡Hola! ¿En qué te ayudo?' }),
    );
  });
});
