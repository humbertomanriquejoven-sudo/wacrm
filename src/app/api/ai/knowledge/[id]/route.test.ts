import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  loadEmbeddingsKey: vi.fn(),
  ingestDocument: vi.fn(),
  removeKnowledgeFile: vi.fn(),
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
  loadEmbeddingsKey: mocks.loadEmbeddingsKey,
}));

vi.mock('@/lib/ai/knowledge', async (importOriginal) => ({
  // Real ingestWarning: the response text must stay asserted.
  ...(await importOriginal<typeof import('@/lib/ai/knowledge')>()),
  ingestDocument: mocks.ingestDocument,
}));

// Storage removal is the first half of DELETE — stub it to assert order.
vi.mock('@/lib/ai/knowledge-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/knowledge-storage')>()),
  removeKnowledgeFile: mocks.removeKnowledgeFile,
}));

// NOTE: @/lib/ai/knowledge-schema is NOT mocked — the real
// isMissingColumnError must recognise the 42703 the fake database
// returns, or the 061-retry path would be untestable.

import { DELETE, PATCH } from './route';

const ACCOUNT = {
  supabase: {} as unknown,
  accountId: 'account-1',
  userId: 'user-1',
  role: 'admin',
  account: { id: 'account-1', name: 'Acme' },
};

const PARAMS = { params: Promise.resolve({ id: 'doc-1' }) };

/** Captures every successful `.update()` payload, in order. */
const updates: { values: Record<string, unknown> }[] = [];

interface DbOptions {
  /**
   * Emulate a database WITHOUT migration 061: any update mentioning a
   * lifecycle column fails with 42703, exactly like Postgres.
   */
  failStatusColumn?: boolean;
  /** Value the PATCH `.select('id').maybeSingle()` resolves with. */
  updatedRow?: { id: string } | null;
  /** storage_path returned by the DELETE load step. */
  storagePath?: string | null;
}

function missingColumn(column: string) {
  return {
    code: '42703',
    message: `column ai_knowledge_documents.${column} does not exist`,
    details: '',
    hint: '',
  };
}

function makeDb(opts: DbOptions = {}) {
  updates.length = 0;
  mocks.deletions.length = 0;
  const updatedRow = opts.updatedRow === undefined ? { id: 'doc-1' } : opts.updatedRow;
  return {
    from: (table: string) => {
      const update = (values: Record<string, unknown>) => {
        const fails =
          !!opts.failStatusColumn &&
          ('status' in values || 'error_message' in values);
        const result = fails
          ? { data: null, error: missingColumn('status') }
          : { data: updatedRow, error: null };
        if (!fails) updates.push({ values });
        const chain: Record<string, unknown> = {
          eq: () => chain,
          select: () => ({
            maybeSingle: () => Promise.resolve(result),
          }),
        };
        return Object.assign(Promise.resolve(result), chain);
      };

      const select = () => {
        const chain: Record<string, unknown> = {
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: { storage_path: opts.storagePath ?? null },
              error: null,
            }),
        };
        return chain;
      };

      const del = () => {
        const entry = { table, filters: {} as Record<string, unknown> };
        mocks.deletions.push(entry);
        const chain: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            entry.filters[col] = val;
            return chain;
          },
        };
        return Object.assign(Promise.resolve({ error: null }), chain);
      };

      return { update, select, delete: del };
    },
  };
}

function patchRequest(body: unknown): Request {
  return new Request('http://localhost/api/ai/knowledge/doc-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  mocks.deletions.length = 0;
  mocks.requireRole.mockResolvedValue({ ...ACCOUNT, supabase: makeDb() });
  mocks.checkRateLimit.mockReturnValue({ success: true });
  mocks.loadEmbeddingsKey.mockResolvedValue({ key: 'emb-key', corrupt: false });
  mocks.ingestDocument.mockResolvedValue(undefined);
  mocks.removeKnowledgeFile.mockResolvedValue(undefined);
});

describe('PATCH /api/ai/knowledge/[id]', () => {
  it('marks the document processing, then ready after a clean re-index', async () => {
    const res = await PATCH(patchRequest({ content: 'Nueva política' }), PARAMS);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true });
    // The row enters the lifecycle the moment the edit lands…
    expect(updates[0].values).toMatchObject({
      content: 'Nueva política',
      status: 'processing',
    });
    // …and leaves it only after the new text is indexed.
    expect(mocks.ingestDocument).toHaveBeenCalledWith(
      expect.anything(),
      'account-1',
      { embeddingsApiKey: 'emb-key' },
      'doc-1',
      'Nueva política'
    );
    expect(updates[updates.length - 1].values).toMatchObject({
      status: 'ready',
      error_message: null,
    });
  });

  it('retries without the lifecycle columns when migration 061 is absent', async () => {
    mocks.requireRole.mockResolvedValue({
      ...ACCOUNT,
      supabase: makeDb({ failStatusColumn: true }),
    });
    const res = await PATCH(patchRequest({ content: 'Texto nuevo' }), PARAMS);

    // The substantive edit still lands — a missing optional column must
    // never fail the user's save.
    expect(res.status).toBe(200);
    const persisted = updates.filter((u) => 'content' in u.values);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].values).toEqual({ content: 'Texto nuevo' });
    expect(mocks.ingestDocument).toHaveBeenCalled();
    // And the degraded status write did not smuggle a column in.
    expect(updates.every((u) => !('status' in u.values))).toBe(true);
  });

  it('records the failure on the row when re-indexing fails', async () => {
    mocks.ingestDocument.mockRejectedValue(new Error('embedding quota'));
    const res = await PATCH(patchRequest({ content: 'Texto' }), PARAMS);

    // 200: the edit itself was saved; the warning says indexing was not.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warning).toContain('indexing failed');
    expect(updates[updates.length - 1].values).toMatchObject({
      status: 'error',
      error_message: expect.stringContaining('embedding quota'),
    });
  });

  it('skips the lifecycle entirely for a title-only edit', async () => {
    const res = await PATCH(patchRequest({ title: 'Título nuevo' }), PARAMS);

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual({ title: 'Título nuevo' });
    // Nothing changed textually, so nothing needs re-chunking.
    expect(mocks.ingestDocument).not.toHaveBeenCalled();
  });

  it('rejects an empty payload with 400', async () => {
    const res = await PATCH(patchRequest({ content: '   ' }), PARAMS);
    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
    expect(mocks.ingestDocument).not.toHaveBeenCalled();
  });

  it('reports 404 when the document does not exist', async () => {
    mocks.requireRole.mockResolvedValue({
      ...ACCOUNT,
      supabase: makeDb({ updatedRow: null }),
    });
    const res = await PATCH(patchRequest({ title: 'X' }), PARAMS);
    expect(res.status).toBe(404);
    expect(mocks.ingestDocument).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/ai/knowledge/[id]', () => {
  it('removes the stored original before the row', async () => {
    mocks.requireRole.mockResolvedValue({
      ...ACCOUNT,
      supabase: makeDb({ storagePath: 'account-1/doc-1/lista.xlsx' }),
    });
    const res = await DELETE(new Request('http://localhost/x'), PARAMS);

    expect(res.status).toBe(200);
    expect(mocks.removeKnowledgeFile).toHaveBeenCalledWith(
      expect.anything(),
      'account-1/doc-1/lista.xlsx'
    );
    expect(mocks.deletions).toHaveLength(1);
  });

  it('keeps the row (no delete) when the original cannot be removed', async () => {
    mocks.removeKnowledgeFile.mockRejectedValueOnce(
      new Error('permission denied for bucket')
    );
    mocks.requireRole.mockResolvedValue({
      ...ACCOUNT,
      supabase: makeDb({ storagePath: 'account-1/doc-1/lista.xlsx' }),
    });
    const res = await DELETE(new Request('http://localhost/x'), PARAMS);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('permission denied for bucket');
    expect(mocks.deletions).toHaveLength(0);
  });
});
