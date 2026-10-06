import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateOpenRouter } from './openrouter';
import { AiError } from '../types';

// Locks the OpenRouter contract the auto-reply worker depends on:
// required headers (Authorization / HTTP-Referer / X-Title), the model id
// sent verbatim (e.g. google/gemini-2.5-flash-lite), and the exact
// upstream HTTP status + provider error message surfaced on failures.

const BASE = {
  apiKey: 'sk-or-v1-test',
  model: 'google/gemini-2.5-flash-lite',
  systemPrompt: 'You are a connectivity check.',
  messages: [{ role: 'user' as const, content: 'ping' }],
  timeoutMs: 5_000,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('generateOpenRouter', () => {
  it('sends the required headers and the configured model id', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    );

    await generateOpenRouter(BASE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-or-v1-test',
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://wacrm.tech',
      'X-Title': 'WACRM AI Assistant',
    });
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('google/gemini-2.5-flash-lite');
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: 'You are a connectivity check.',
    });
  });

  it('maps a 401 to invalid_key/401 and keeps the upstream status + provider message', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { message: 'Invalid API key' } }),
    );

    const err = await generateOpenRouter(BASE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({
      code: 'invalid_key',
      status: 401,
      upstreamStatus: 401,
    });
    expect((err as Error).message).toContain('OpenRouter rejected the API key');
    expect((err as Error).message).toContain('Invalid API key');
  });

  it('keeps non-auth upstream statuses (402/404/500) on the error', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(
      jsonResponse(402, { error: { message: 'Insufficient credits' } }),
    );

    const err = await generateOpenRouter(BASE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({
      code: 'provider_error',
      status: 502,
      upstreamStatus: 402,
    });
    expect((err as Error).message).toContain('(402)');
    expect((err as Error).message).toContain('Insufficient credits');
  });

  it('rejects an empty completion as empty_response so the dispatcher can log and fall back', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: '   ' } }] }),
    );

    const err = await generateOpenRouter(BASE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ code: 'empty_response' });
    expect((err as Error).message).toContain('empty response');
  });
});
