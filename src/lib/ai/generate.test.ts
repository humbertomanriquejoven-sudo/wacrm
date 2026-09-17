import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateReply,
  parseGeneration,
  stripModelPrefix,
  stripInternalReasoning,
} from './generate';
import { AiError, type AiConfig } from './types';

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  };
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response;
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
      usage: null,
    });
  });

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({
      text: '',
      handoff: true,
      usage: null,
    });
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
      usage: null,
    });
  });

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    expect(parseGeneration('Hi', usage)).toEqual({
      text: 'Hi',
      handoff: false,
      usage,
    });
  });

  it('strips a leading Gemini "model" role token', () => {
    expect(parseGeneration('model\nHola, ¿en qué puedo ayudarte?').text).toBe(
      'Hola, ¿en qué puedo ayudarte?'
    );
    expect(parseGeneration('model Hola').text).toBe('Hola');
    expect(parseGeneration('MODEL\n   Hola').text).toBe('Hola');
    expect(parseGeneration('model\nmodel\n\n¡Hola de nuevo!').text).toBe(
      '¡Hola de nuevo!'
    );
  });

  it('keeps replies that merely contain the word "model", not as a leading token', () => {
    expect(parseGeneration('modelo deportivo 2026').text).toBe(
      'modelo deportivo 2026'
    );
    expect(parseGeneration('este modelo es el mejor').text).toBe(
      'este modelo es el mejor'
    );
    expect(parseGeneration('model.').text).toBe('model.');
  });
});

describe('stripModelPrefix', () => {
  it('only removes a standalone leading token, not mid-text occurrences', () => {
    expect(stripModelPrefix('model\nrespuesta')).toBe('respuesta');
    expect(stripModelPrefix('el modelo es este')).toBe('el modelo es este');
  });
});

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(res).toEqual({
      text: 'Sure — happy to help!',
      handoff: false,
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('api.openai.com');
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
  });

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errResponse(401, { error: { message: 'Incorrect API key' } })
        )
    );

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 });
  });

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          okResponse({ choices: [{ message: { content: '' } }] })
        )
    );
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    ).rejects.toBeInstanceOf(AiError);
  });
});

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: 'Hi there!',
      handoff: false,
      toolCalls: [],
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('api.anthropic.com');
    expect(opts.headers['x-api-key']).toBe('sk-ant-x');
    expect(opts.headers['anthropic-version']).toBeTruthy();
  });

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] })
        )
    );
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    });
    expect(res.handoff).toBe(true);
    expect(res.text).toBe('');
  });

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: 'ok' }] })
      );
    vi.stubGlobal('fetch', fetchMock);

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages).toHaveLength(1);
  });
});

describe('generateReply — tool-calling safeguards', () => {
  const tools = [
    {
      name: 'ver_disponibilidad',
      description: 'list slots',
      parameters: { type: 'object' as const, properties: {} },
    },
    {
      name: 'agendar_cita',
      description: 'book',
      parameters: { type: 'object' as const, properties: {} },
    },
  ];

  it('sends tool_choice "auto" to OpenAI when tools are present', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse({ choices: [{ message: { content: 'Hola' } }] })
      );
    vi.stubGlobal('fetch', fetchMock);

    await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hola' }],
      tools,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toHaveLength(2);
  });

  it('sends tool_choice {type:auto} to Anthropic when tools are present', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: 'Hola' }] })
      );
    vi.stubGlobal('fetch', fetchMock);

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hola' }],
      tools,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('strips leaked tool-call text and recovers the call when the provider sent none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          choices: [
            {
              message: {
                content:
                  'step_0: print(default_api.agendar_cita(inicio="2026-09-18T14:00:00-05:00", nombre="Carlos"))',
              },
            },
          ],
        })
      )
    );

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'agenda una cita' }],
      tools,
    });

    expect(res.text).toBe('');
    expect(res.toolCalls).toEqual([
      {
        id: 'text-call-agendar_cita-0',
        name: 'agendar_cita',
        arguments: {
          inicio: '2026-09-18T14:00:00-05:00',
          nombre: 'Carlos',
        },
      },
    ]);
  });

  it('never leaks scaffolding text even when structured tool_calls are present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          choices: [
            {
              message: {
                content:
                  'step_0: print(default_api.ver_disponibilidad(desde="a", hasta="b"))',
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'ver_disponibilidad',
                      arguments: '{"desde":"a","hasta":"b"}',
                    },
                  },
                ],
              },
            },
          ],
        })
      )
    );

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hay cupo?' }],
      tools,
    });

    expect(res.text).not.toContain('step_0');
    expect(res.text).not.toContain('default_api');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls?.[0].id).toBe('call-1');
  });
});

describe('stripInternalReasoning — Chain-of-Thought never reaches WhatsApp', () => {
  it('removes <thinking> blocks while keeping the customer-facing text', () => {
    const raw =
      '<thinking>El cliente quiere agendar martes. Haré la reserva.</thinking>\n' +
      '¡Claro! Tienes una cita el martes a las 3:00 PM.';
    expect(stripInternalReasoning(raw)).toBe(
      '¡Claro! Tienes una cita el martes a las 3:00 PM.'
    );
  });

  it('removes code-fenced reasoning, bracket tags and label-prefixed monologue', () => {
    const raw =
      '```thinking\nusar agendar_cita con inicio=2026-09-18T15:00:00-05:00\n```\n' +
      '[THOUGHT] debo verificar disponibilidad [/THOUGHT]\n' +
      'Pensamiento: confirmo la hora exacta.\n' +
      'Razonamiento: aplicar la política del negocio.\n' +
      'Perfecto, quedó agendado para el viernes a las 3:00 PM.';
    expect(stripInternalReasoning(raw)).toBe(
      'Perfecto, quedó agendado para el viernes a las 3:00 PM.'
    );
  });

  it('removes stray unmatched thinking tags', () => {
    expect(stripInternalReasoning('<thinking> hola </thinking>')).toBe('');
    expect(stripInternalReasoning('</thinking>Hola, ¿cómo estás?')).toBe(
      'Hola, ¿cómo estás?'
    );
  });

  it('leaves ordinary customer-facing text untouched', () => {
    const text = 'Claro, ¿te confirmo la cita para mañana a las 10?';
    expect(stripInternalReasoning(text)).toBe(text);
  });

  it('applies inside parseGeneration so every reply is pre-cleaned', () => {
    const out = parseGeneration(
      '<reasoning>necesito el link</reasoning>\nAquí tienes tu enlace de Meet.'
    );
    expect(out.text).toBe('Aquí tienes tu enlace de Meet.');
  });
});
