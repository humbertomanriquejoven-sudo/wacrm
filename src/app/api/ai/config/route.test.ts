import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression guard for the "Failed to load AI configuration" incident:
 * the GET projection named `ai_configs.follow_up_enabled` (migration 063)
 * unconditionally, so on a database that had not applied 063 PostgREST
 * rejected the whole select with 42703 and Setup went blank.
 *
 * The route must now retry without the new column and always answer 200
 * with a fail-open `follow_up_enabled`.
 */

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : 'error' },
      { status: 500 },
    ),
  ),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn((v: string) => `enc(${v})`),
  decrypt: vi.fn((v: string) => v),
}));

vi.mock('@/lib/ai/validate', () => ({ validateAiCredentials: vi.fn() }));
vi.mock('@/lib/ai/key-fingerprint', () => ({ apiKeyFingerprint: vi.fn(() => 'fp') }));
vi.mock('@/lib/ai/embeddings', () => ({ embedTexts: vi.fn() }));
vi.mock('@/lib/ai/types', () => ({ AiError: class extends Error {} }));

import { GET } from './route';

const ROW = {
  provider: 'openrouter',
  model: 'openai/gpt-4o-mini',
  system_prompt: 'Eres el asistente.',
  is_active: true,
  auto_reply_enabled: true,
  auto_reply_max_per_conversation: 10,
  handoff_agent_id: null,
  api_key: 'encrypted-key',
  embeddings_api_key: null,
};

/** A Supabase-like client whose ai_configs select behaves like PostgREST. */
function makeDb(opts: {
  columnExists: boolean;
  row?: Record<string, unknown> | null;
  hardError?: { message: string };
}) {
  const selects: string[] = [];
  const db = {
    from: () => ({
      select: (columns: string) => {
        selects.push(columns);
        const namesColumn = columns.includes('follow_up_enabled');
        const chain = {
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve(
              opts.hardError
                ? { data: null, error: opts.hardError }
                : namesColumn && !opts.columnExists
                  ? {
                      data: null,
                      error: {
                        code: '42703',
                        message:
                          'column ai_configs.follow_up_enabled does not exist',
                      },
                    }
                  : { data: opts.row ?? null, error: null },
            ),
        };
        return chain;
      },
    }),
  };
  return { db, selects };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAccount.mockResolvedValue({
    supabase: null,
    accountId: 'account-1',
    userId: 'user-1',
  });
});

describe('GET /api/ai/config — schema tolerance', () => {
  it('returns 200 and the config when migration 063 is NOT applied', async () => {
    const { db, selects } = makeDb({ columnExists: false, row: ROW });
    mocks.getCurrentAccount.mockResolvedValue({
      supabase: db,
      accountId: 'account-1',
      userId: 'user-1',
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.system_prompt).toBe('Eres el asistente.');
    expect(body.has_key).toBe(true);
    expect(body.follow_up_enabled).toBe(true);
    // The first projection names the new column; the retry must not.
    expect(selects[0]).toContain('follow_up_enabled');
    expect(selects[1]).not.toContain('follow_up_enabled');
  });

  it('honours an explicit false when the column exists', async () => {
    const { db } = makeDb({
      columnExists: true,
      row: { ...ROW, follow_up_enabled: false },
    });
    mocks.getCurrentAccount.mockResolvedValue({
      supabase: db,
      accountId: 'account-1',
      userId: 'user-1',
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.follow_up_enabled).toBe(false);
  });

  it('still reports a genuine (non missing-column) failure as 500', async () => {
    const { db } = makeDb({
      columnExists: true,
      hardError: { message: 'permission denied for relation ai_configs' },
    });
    mocks.getCurrentAccount.mockResolvedValue({
      supabase: db,
      accountId: 'account-1',
      userId: 'user-1',
    });

    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed to load AI configuration');
  });
});
