import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  loadEmbeddingsKey: vi.fn(),
  ingestDocument: vi.fn(),
  parseKnowledgeFile: vi.fn(),
  uploadKnowledgeFile: vi.fn(),
  removeKnowledgeFile: vi.fn(),
}));

const SUPPORTED_EXTENSIONS = [
  'xlsx',
  'xls',
  'csv',
  'pdf',
  'docx',
  'doc',
  'txt',
];

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
  // Real classes: the route's outer catch does `instanceof` on these to keep
  // 401/403 instead of turning an auth rejection into a 500. Omitting them
  // made `instanceof` receive undefined and threw.
  UnauthorizedError: class UnauthorizedError extends Error {
    status = 401;
  },
  ForbiddenError: class ForbiddenError extends Error {
    status = 403;
  },
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
  // Spread the real module so `ingestWarning` keeps its real implementation:
  // stubbing it would let the route's actual warning text go unasserted.
  ...(await importOriginal<typeof import('@/lib/ai/knowledge')>()),
  ingestDocument: mocks.ingestDocument,
}));

vi.mock('@/lib/ai/knowledge-parser', () => ({
  parseKnowledgeFile: mocks.parseKnowledgeFile,
  knowledgeFileExtension: (name: string) => {
    const dot = name.lastIndexOf('.');
    const ext = (dot >= 0 ? name.slice(dot + 1) : name).toLowerCase();
    return SUPPORTED_EXTENSIONS.includes(ext) ? ext : null;
  },
}));

// Storage calls are stubbed (so no real Storage is touched), but
// knowledgeObjectPath and sanitizeFilename stay REAL: the cleanup path
// builds its path with them, and that path must round-trip.
vi.mock('@/lib/ai/knowledge-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/knowledge-storage')>()),
  uploadKnowledgeFile: mocks.uploadKnowledgeFile,
  removeKnowledgeFile: mocks.removeKnowledgeFile,
}));

import { POST } from './route';
import { AiError } from '@/lib/ai/types';

const context = {
  supabase: { name: 'scoped-client' },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'admin',
  account: { id: 'account-1', name: 'Acme' },
};

const FILE_BYTES = 16 * 1024 * 1024;

const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
const updates: Array<{
  table: string;
  values: Record<string, unknown>;
  filters: Record<string, unknown>;
}> = [];
const deletions: Array<{ table: string; filters: Record<string, unknown> }> = [];

interface DbOptions {
  /**
   * Columns the "database" does not have — every insert/update payload
   * carrying one fails exactly like Postgres would (42703 + the column
   * name), which is what drives the 061 → 055 → 030 degradation tiers.
   */
  failColumns?: string[];
  /** Documents the list reload returns. */
  documents?: Record<string, unknown>[];
}

function missingColumnError(column: string) {
  return {
    code: '42703',
    message: `column ai_knowledge_documents.${column} does not exist`,
    details: '',
    hint: '',
  };
}

/**
 * Chain stub with the shape the route actually uses:
 * `.update(v).eq().eq()` / `.delete().eq().eq()` — awaitable once the
 * eq filters are applied.
 */
function eqChainTo(
  entry: { filters: Record<string, unknown> },
  result: { data?: unknown; error: unknown }
) {
  const chain: Record<string, unknown> = {
    eq: (col: string, val: unknown) => {
      entry.filters[col] = val;
      return chain;
    },
  };
  return Object.assign(Promise.resolve(result), chain);
}

function makeDb(opts: DbOptions = {}) {
  inserted.length = 0;
  updates.length = 0;
  deletions.length = 0;
  const failColumns = opts.failColumns ?? [];
  const documents =
    opts.documents ??
    ([
      {
        id: 'doc-1',
        title: 'lista-precios',
        filename: 'lista-precios.xlsx',
        source_type: 'xlsx',
        status: 'ready',
        file_size: 32,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ] as Record<string, unknown>[]);
  return {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        const missing = failColumns.find((column) => column in row);
        if (missing) {
          return {
            select: () => ({
              single: () =>
                Promise.resolve({ data: null, error: missingColumnError(missing) }),
            }),
          };
        }
        inserted.push({ table, row });
        return {
          select: () => ({
            single: () =>
              Promise.resolve({ data: { id: 'doc-1' }, error: null }),
          }),
        };
      },
      update: (values: Record<string, unknown>) => {
        const entry = { table, values, filters: {} as Record<string, unknown> };
        const missing = failColumns.find((column) => column in values);
        if (missing) {
          return eqChainTo(entry, { data: null, error: missingColumnError(missing) });
        }
        updates.push(entry);
        return eqChainTo(entry, { data: null, error: null });
      },
      delete: () => {
        const entry = { table, filters: {} as Record<string, unknown> };
        deletions.push(entry);
        return eqChainTo(entry, { error: null });
      },
      // The list reload: .select().eq().order().
      select: () => {
        const chain: Record<string, unknown> = {
          eq: () => chain,
          order: () => Promise.resolve({ data: documents, error: null }),
        };
        return chain;
      },
    }),
  };
}

function uploadRequest(fd: FormData): Request {
  return new Request('http://localhost/api/ai/knowledge/upload', {
    method: 'POST',
    body: fd,
  });
}

function multipart(file?: File, title?: string): Request {
  const fd = new FormData();
  if (file) fd.append('file', file);
  if (title) fd.append('title', title);
  return uploadRequest(fd);
}

function xlsxFile(name = 'lista-precios.xlsx', size = 32): File {
  return new File([new Uint8Array(size)], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.ingestDocument.mockReset();
  mocks.ingestDocument.mockResolvedValue(undefined);
  mocks.loadEmbeddingsKey.mockReset();
  mocks.loadEmbeddingsKey.mockResolvedValue({ key: 'emb-key', corrupt: false });
  mocks.parseKnowledgeFile.mockReset();
  mocks.parseKnowledgeFile.mockResolvedValue({
    text: 'Producto, Precio\nMolino, 300',
    extension: 'xlsx',
  });
  mocks.uploadKnowledgeFile.mockReset();
  mocks.uploadKnowledgeFile.mockResolvedValue(
    'account-1/doc-1/lista-precios.xlsx'
  );
  mocks.removeKnowledgeFile.mockReset();
  mocks.removeKnowledgeFile.mockResolvedValue(undefined);
  updates.length = 0;
  deletions.length = 0;
  mocks.checkRateLimit.mockReset();
  mocks.checkRateLimit.mockReturnValue({ success: true });
  mocks.rateLimitResponse.mockReset();
  mocks.rateLimitResponse.mockReturnValue(
    Response.json({ error: 'rate limited' }, { status: 429 })
  );
  mocks.requireRole.mockResolvedValue({
    ...context,
    supabase: makeDb(),
  });
});

describe('/api/ai/knowledge/upload', () => {
  it('saves a parsed file and indexes it, defaulting title to the file name', async () => {
    const response = await POST(multipart(xlsxFile()));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      id: 'doc-1',
      title: 'lista-precios',
    });

    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual({
      table: 'ai_knowledge_documents',
      row: {
        account_id: 'account-1',
        created_by: 'user-1',
        title: 'lista-precios',
        content: 'Producto, Precio\nMolino, 300',
        // The real upload name and the parser used, so a weak extraction
        // (e.g. an unreadable image) can be identified and re-uploaded.
        filename: 'lista-precios.xlsx',
        source_type: 'xlsx',
        // 061 lifecycle: the row enters the world as 'uploading'.
        file_size: 32,
        mime_type:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        status: 'uploading',
      },
    });
    expect(mocks.ingestDocument).toHaveBeenCalledWith(
      expect.anything(),
      'account-1',
      { embeddingsApiKey: 'emb-key' },
      'doc-1',
      'Producto, Precio\nMolino, 300'
    );
    // …and the list in the response is the SAME shape GET returns, so the
    // client can reconcile from this response alone.
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0]).toMatchObject({
      id: 'doc-1',
      status: 'ready',
      file_size: 32,
    });
  });

  it('honors an explicit title from the form', async () => {
    const response = await POST(multipart(xlsxFile(), 'Catálogo 2026'));

    expect(response.status).toBe(200);
    expect(inserted[0].row.title).toBe('Catálogo 2026');
  });

  it('rejects a request without a file', async () => {
    const response = await POST(multipart());
    expect(response.status).toBe(400);
    expect(mocks.parseKnowledgeFile).not.toHaveBeenCalled();
  });

  it('rejects an unsupported extension before parsing', async () => {
    const response = await POST(
      multipart(new File([new Uint8Array([1])], 'x.exe'))
    );
    expect(response.status).toBe(400);
    expect(mocks.parseKnowledgeFile).not.toHaveBeenCalled();
  });

  it('rejects an empty file', async () => {
    const response = await POST(multipart(new File([], 'empty.csv')));
    expect(response.status).toBe(400);
    expect(mocks.parseKnowledgeFile).not.toHaveBeenCalled();
  });

  it('rejects files over the 16 MB ceiling', async () => {
    const response = await POST(
      multipart(xlsxFile('big.xlsx', FILE_BYTES + 1))
    );
    expect(response.status).toBe(400);
    expect(mocks.parseKnowledgeFile).not.toHaveBeenCalled();
  });

  it('returns 422 with the parser message when extraction fails', async () => {
    mocks.parseKnowledgeFile.mockRejectedValueOnce(
      new Error('No table data could be read from big.xlsx.')
    );
    const response = await POST(multipart(xlsxFile()));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toContain('No table data');
    expect(mocks.ingestDocument).not.toHaveBeenCalled();
  });

  it('still saves when semantic indexing fails, reporting a warning', async () => {
    mocks.ingestDocument.mockRejectedValue(
      new Error('embedding quota exceeded')
    );
    const response = await POST(multipart(xlsxFile()));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.warning).toContain('indexing failed');
    // The chunks exist, so keyword search really does still answer.
    expect(body.warning).toContain('Keyword search still works');
  });

  it('does not promise keyword search when the document got zero chunks', async () => {
    mocks.ingestDocument.mockRejectedValue(
      new AiError('row-level security on ai_knowledge_chunks', {
        code: 'knowledge_chunk_write_failed',
      })
    );
    const response = await POST(multipart(xlsxFile()));

    // Still a 200: the document row was saved, so the UI shows it in the list.
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    // But it is unsearchable, and the warning has to say so — the previous
    // wording claimed keyword search still worked, sending the operator to
    // debug the wrong layer.
    expect(body.warning).toContain('NOT searchable');
    expect(body.warning).not.toContain('still works');
    expect(body.warning).toContain('row-level security');
  });

  it('responds 429 when the admin rate limit is hit', async () => {
    mocks.checkRateLimit.mockReturnValue({ success: false });
    const response = await POST(multipart(xlsxFile()));
    expect(response.status).toBe(429);
    expect(response.headers.get('x-ratelimit-remaining')).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it('keeps 403 for a real ForbiddenError instead of masking it as a 500', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account');
    mocks.requireRole.mockRejectedValueOnce(
      new ForbiddenError('admin role required')
    );
    const response = await POST(multipart(xlsxFile()));
    // An auth rejection must not read as a server fault.
    expect(response.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it('keeps 401 for a real UnauthorizedError', async () => {
    const { UnauthorizedError } = await import('@/lib/auth/account');
    mocks.requireRole.mockRejectedValueOnce(new UnauthorizedError('sign in'));
    const response = await POST(multipart(xlsxFile()));
    expect(response.status).toBe(401);
  });

  it('reports the cause of a non-auth failure instead of "Internal server error"', async () => {
    // A systemic fault (missing env var, broken auth client) fails EVERY
    // upload identically. The old path returned a bare 500 whose body said
    // nothing, which is why this class of bug was undiagnosable.
    mocks.requireRole.mockRejectedValueOnce(
      new Error('supabaseUrl is required')
    );
    const response = await POST(multipart(xlsxFile()));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('supabaseUrl is required');
    expect(body.error).not.toBe('Internal server error');
  });

  // ---------------------------------------------------------------------
  // Diagnosability: a failed insert must name the database's own reason.
  // These used to collapse into `{ error: 'Failed to save document' }`,
  // which is why "my file doesn't save" could not be diagnosed from either
  // the server log or DevTools.
  // ---------------------------------------------------------------------
  describe('insert failures are surfaced, not swallowed', () => {
    function dbFailingWith(error: object) {
      return {
        from: () => ({
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: null, error }),
            }),
          }),
        }),
      };
    }

    it('returns the SQLSTATE and message for an RLS rejection', async () => {
      mocks.requireRole.mockResolvedValue({
        ...context,
        supabase: dbFailingWith({
          code: '42501',
          message: 'new row violates row-level security policy for table "ai_knowledge_documents"',
          details: '',
          hint: '',
        }),
      });
      const response = await POST(multipart(xlsxFile()));

      // 403, not 500: "your role cannot write here" is a different problem
      // from "the server broke".
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.db_code).toBe('42501');
      expect(body.error).toContain('row-level security policy');
      expect(body.advice).toMatch(/admin member/i);
    });

    it('returns 400 and names migration 055 when a column is missing', async () => {
      mocks.requireRole.mockResolvedValue({
        ...context,
        supabase: dbFailingWith({
          code: '42703',
          message: 'column ai_knowledge_documents.filename does not exist',
          details: '',
          hint: '',
        }),
      });
      const response = await POST(multipart(xlsxFile()));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.db_code).toBe('42703');
      expect(body.advice).toContain('055_knowledge_document_filename.sql');
    });

    it('never returns the old opaque message', async () => {
      mocks.requireRole.mockResolvedValue({
        ...context,
        supabase: dbFailingWith({
          code: '23505',
          message: 'duplicate key value violates unique constraint "ai_knowledge_documents_pkey"',
          details: '',
          hint: '',
        }),
      });
      const response = await POST(multipart(xlsxFile()));
      const body = await response.json();
      expect(body.error).not.toBe('Failed to save document');
    });

    it('logs KNOWLEDLEDGE_BASE_DB_ERROR with the failing filename', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mocks.requireRole.mockResolvedValue({
        ...context,
        supabase: dbFailingWith({
          code: '42501',
          message: 'new row violates row-level security policy',
          details: '',
          hint: '',
        }),
      });
      await POST(multipart(xlsxFile('tarifario.xlsx')));

      const tagged = spy.mock.calls.filter((c) =>
        String(c[0]).includes('KNOWLEDGE_BASE_DB_ERROR')
      );
      expect(tagged.length).toBeGreaterThan(0);
      expect(tagged[0][1]).toMatchObject({
        filename: 'tarifario.xlsx',
        code: '42501',
      });
      spy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------
  // Stored originals + the status lifecycle (migration 061).
  // ---------------------------------------------------------------------
  describe('stores the original file and tracks document status', () => {
    it('uploads the original to storage and records the path before indexing', async () => {
      const response = await POST(multipart(xlsxFile()));
      expect(response.status).toBe(200);

      expect(mocks.uploadKnowledgeFile).toHaveBeenCalledTimes(1);
      const [client, params] = mocks.uploadKnowledgeFile.mock.calls[0];
      // The caller's RLS client, so the 061 storage policies decide.
      expect(client).toBeInstanceOf(Object);
      expect(params).toMatchObject({
        accountId: 'account-1',
        documentId: 'doc-1',
      });
      expect(params.file).toBeInstanceOf(File);

      // The row points at the object AND moves to 'processing' — the
      // moment the original is durable and indexing is under way.
      expect(updates[0]).toMatchObject({
        table: 'ai_knowledge_documents',
        values: {
          storage_path: 'account-1/doc-1/lista-precios.xlsx',
          status: 'processing',
        },
        filters: { account_id: 'account-1', id: 'doc-1' },
      });
      // After a clean index run the document lands on 'ready'.
      expect(updates[updates.length - 1].values).toMatchObject({
        status: 'ready',
        error_message: null,
      });
      expect(mocks.removeKnowledgeFile).not.toHaveBeenCalled();
    });

    it('undoes the row and reports 500 when the original cannot be stored', async () => {
      mocks.uploadKnowledgeFile.mockRejectedValueOnce(
        new Error('Bucket write denied')
      );
      const response = await POST(multipart(xlsxFile()));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain('Bucket write denied');
      // The cleanup tries to drop whatever partial object exists…
      expect(mocks.removeKnowledgeFile).toHaveBeenCalledWith(
        expect.anything(),
        'account-1/doc-1/lista-precios.xlsx'
      );
      // …and the row itself: nothing may reference a file that was never
      // stored, and no half-saved document may linger in the list.
      expect(deletions).toHaveLength(1);
      expect(deletions[0]).toMatchObject({
        table: 'ai_knowledge_documents',
        filters: { account_id: 'account-1', id: 'doc-1' },
      });
      // The storage_path update never ran, and nothing was indexed.
      expect(updates).toHaveLength(0);
      expect(mocks.ingestDocument).not.toHaveBeenCalled();
    });

    it('marks the document failed with the reason when indexing fails', async () => {
      mocks.ingestDocument.mockRejectedValue(
        new Error('embedding quota exceeded')
      );
      const response = await POST(multipart(xlsxFile()));

      // Still a 200: the document (original file included) is saved.
      expect(response.status).toBe(200);
      const statusWrites = updates.filter((u) => 'status' in u.values);
      expect(statusWrites[statusWrites.length - 1].values).toMatchObject({
        status: 'error',
        error_message: expect.stringContaining('embedding quota exceeded'),
      });
    });
  });

  describe('degrades gracefully when migration 061 / 055 is not applied', () => {
    it('061 missing: skips storage and status, warns which migration to apply', async () => {
      mocks.requireRole.mockResolvedValue({
        ...context,
        supabase: makeDb({ failColumns: ['status'] }),
      });
      const response = await POST(multipart(xlsxFile()));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.warning).toContain('061_knowledge_document_storage.sql');
      // 055 columns still exist, so this is NOT the filename-degraded shape.
      expect(body.degradedSchema).toBe(false);
      expect(inserted[0].row).toMatchObject({
        filename: 'lista-precios.xlsx',
      });
      expect(inserted[0].row).not.toHaveProperty('status');
      // An object with nowhere to record its path would be an orphan.
      expect(mocks.uploadKnowledgeFile).not.toHaveBeenCalled();
      expect(mocks.removeKnowledgeFile).not.toHaveBeenCalled();
      // The status writes (processing/ready) all fail with 42703 and
      // degrade silently — no row was ever touched after the insert.
      expect(updates).toHaveLength(0);
    });

    it('055 missing: stores no filename/type and degradedSchema says so', async () => {
      mocks.requireRole.mockResolvedValue({
        ...context,
        supabase: makeDb({ failColumns: ['filename', 'status'] }),
      });
      const response = await POST(multipart(xlsxFile()));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.warning).toContain('055_knowledge_document_filename.sql');
      expect(body.degradedSchema).toBe(true);
      expect(inserted[0].row).toEqual({
        account_id: 'account-1',
        created_by: 'user-1',
        title: 'lista-precios',
        content: 'Producto, Precio\nMolino, 300',
      });
      expect(mocks.uploadKnowledgeFile).not.toHaveBeenCalled();
    });
  });
});
