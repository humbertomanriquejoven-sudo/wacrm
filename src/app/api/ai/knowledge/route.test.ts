import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  isMissingColumnError: vi.fn(),
  deletions: [] as { table: string; filters: Record<string, unknown> }[],
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
  RATE_LIMITS: { adminAction: { windowMs: 60000, max: 100 } },
}));

vi.mock('@/lib/ai/config', () => ({
  loadEmbeddingsKey: vi.fn(async () => ({ key: null, corrupt: false })),
}));

vi.mock('@/lib/ai/knowledge', () => ({ ingestDocument: vi.fn() }));

vi.mock('@/lib/ai/knowledge-schema', () => ({
  isMissingColumnError: mocks.isMissingColumnError,
}));

vi.mock('@/lib/ai/types', () => ({ AiError: class extends Error {} }));

import { DELETE, GET } from './route';

const ACCOUNT = {
  supabase: {} as unknown,
  accountId: 'account-1',
  userId: 'user-1',
};

/** Captures the columns each `.select()` asked for, per call. */
const selects: string[] = [];
/** Captures each `.order(column, opts)` call, per call. */
const orders: { column: string; ascending: boolean | undefined }[] = [];

function makeListDb(opts: { richFails?: boolean } = {}) {
  selects.length = 0;
  orders.length = 0;
  mocks.deletions.length = 0;
  return {
    from: (table: string) => {
      // `.delete()` hangs directly off `from()`, `.select()` off the same
      // builder — they are independent query shapes in the client.
      const recordDelete = (): Record<string, unknown> => {
        const entry = { table, filters: {} as Record<string, unknown> };
        mocks.deletions.push(entry);
        const chain: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            entry.filters[col] = val;
            return chain;
          },
        };
        // Awaitable at the end of the eq() chain.
        return Object.assign(Promise.resolve({ error: null }), chain);
      };

      return {
        select: (columns: string) => {
          selects.push(columns);
          const rich = columns.includes('filename');
          const shouldFail = rich && opts.richFails;
          const chain: Record<string, unknown> = {
            eq: () => chain,
            order: (column: string, orderOpts?: { ascending?: boolean }) => {
              orders.push({ column, ascending: orderOpts?.ascending });
              return Promise.resolve({
                data: shouldFail
                  ? null
                  : [
                      {
                        id: 'doc-1',
                        title: 'Catalog',
                        filename: 'Catalog.xlsx',
                        source_type: 'xlsx',
                        created_at: '2026-10-01T12:00:00Z',
                        updated_at: '2026-10-02T12:00:00Z',
                      },
                    ],
                error: shouldFail ? { message: 'column does not exist' } : null,
              });
            },
          };
          return chain;
        },
        delete: recordDelete,
      };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selects.length = 0;
  orders.length = 0;
  mocks.deletions.length = 0;
  mocks.getCurrentAccount.mockResolvedValue(ACCOUNT);
  mocks.requireRole.mockResolvedValue(ACCOUNT);
  mocks.checkRateLimit.mockReturnValue({ success: true });
  mocks.isMissingColumnError.mockReturnValue(false);
});

describe('GET /api/ai/knowledge', () => {
  it('orders by created_at DESC, newest upload first', async () => {
    // This panel is an upload log. Ordering by updated_at made a document
    // edited months later jump to the top as if it had just been added.
    mocks.getCurrentAccount.mockResolvedValue({
      ...ACCOUNT,
      supabase: makeListDb(),
    });
    await GET();
    expect(orders).toEqual([{ column: 'created_at', ascending: false }]);
  });

  it('keeps the same ordering on the 055-degraded path', async () => {
    mocks.isMissingColumnError.mockReturnValue(true);
    mocks.getCurrentAccount.mockResolvedValue({
      ...ACCOUNT,
      supabase: makeListDb({ richFails: true }),
    });
    await GET();
    // Both reads must sort identically, or the list reshuffles itself
    // depending on whether the migration happens to be applied.
    expect(orders).toEqual([
      { column: 'created_at', ascending: false },
      { column: 'created_at', ascending: false },
    ]);
  });

  it('returns created_at so the UI can prove a document is stored', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      ...ACCOUNT,
      supabase: makeListDb(),
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0]).toMatchObject({
      id: 'doc-1',
      filename: 'Catalog.xlsx',
      source_type: 'xlsx',
      created_at: '2026-10-01T12:00:00Z',
    });
    expect(selects[0]).toContain('created_at');
  });

  it('still lists documents when migration 055 columns are missing', async () => {
    // PostgREST rejects the WHOLE projection on one unknown column, so the
    // rich read failing must degrade instead of reporting an empty base.
    mocks.isMissingColumnError.mockReturnValue(true);
    mocks.getCurrentAccount.mockResolvedValue({
      ...ACCOUNT,
      supabase: makeListDb({ richFails: true }),
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents).toHaveLength(1);
    // The reduced projection keeps created_at (migration 030) but drops the
    // 055-only columns.
    expect(selects[1]).not.toContain('filename');
    expect(selects[1]).toContain('created_at');
  });

  it('reports a genuine failure as a 500, not as an empty base', async () => {
    mocks.isMissingColumnError.mockReturnValue(false);
    mocks.getCurrentAccount.mockResolvedValue({
      ...ACCOUNT,
      supabase: {
        from: () => ({
          select: () => ({
            eq: () => ({
              order: () =>
                Promise.resolve({ data: null, error: { message: 'boom' } }),
            }),
          }),
        }),
      },
    });
    const res = await GET();
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/ai/knowledge?id=', () => {
  it('deletes the document scoped to the account', async () => {
    mocks.requireRole.mockResolvedValue({
      ...ACCOUNT,
      supabase: makeListDb(),
    });
    const res = await DELETE(
      new Request('http://localhost/api/ai/knowledge?id=doc-1')
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      id: 'doc-1',
    });
    // account_id scoping is what stops one tenant deleting another's file.
    expect(mocks.deletions[0]).toMatchObject({
      table: 'ai_knowledge_documents',
      filters: { account_id: 'account-1', id: 'doc-1' },
    });
  });

  it('rejects a missing id with a 400 instead of deleting everything', async () => {
    mocks.requireRole.mockResolvedValue({
      ...ACCOUNT,
      supabase: makeListDb(),
    });
    const res = await DELETE(new Request('http://localhost/api/ai/knowledge'));
    expect(res.status).toBe(400);
    expect(mocks.deletions).toHaveLength(0);
  });

  it('honours the rate limit', async () => {
    mocks.checkRateLimit.mockReturnValue({ success: false });
    mocks.rateLimitResponse.mockReturnValue(
      Response.json({ error: 'rate limited' }, { status: 429 })
    );
    mocks.requireRole.mockResolvedValue({
      ...ACCOUNT,
      supabase: makeListDb(),
    });
    const res = await DELETE(
      new Request('http://localhost/api/ai/knowledge?id=doc-1')
    );
    expect(res.status).toBe(429);
    expect(mocks.deletions).toHaveLength(0);
  });
});
