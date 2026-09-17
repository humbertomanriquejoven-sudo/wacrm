import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  loadEmbeddingsKey: vi.fn(),
  ingestDocument: vi.fn(),
  parseKnowledgeFile: vi.fn(),
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
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
  RATE_LIMITS: { adminAction: { windowMs: 60000, max: 100 } },
}));

vi.mock('@/lib/ai/config', () => ({
  loadEmbeddingsKey: mocks.loadEmbeddingsKey,
}));

vi.mock('@/lib/ai/knowledge', () => ({
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

import { POST } from './route';

const context = {
  supabase: { name: 'scoped-client' },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'admin',
  account: { id: 'account-1', name: 'Acme' },
};

const FILE_BYTES = 16 * 1024 * 1024;

const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];

function makeDb() {
  inserted.length = 0;
  return {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, row });
        return {
          select: () => ({
            single: () =>
              Promise.resolve({ data: { id: 'doc-1' }, error: null }),
          }),
        };
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
      },
    });
    expect(mocks.ingestDocument).toHaveBeenCalledWith(
      expect.anything(),
      'account-1',
      { embeddingsApiKey: 'emb-key' },
      'doc-1',
      'Producto, Precio\nMolino, 300'
    );
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
  });

  it('responds 429 when the admin rate limit is hit', async () => {
    mocks.checkRateLimit.mockReturnValue({ success: false });
    const response = await POST(multipart(xlsxFile()));
    expect(response.status).toBe(429);
    expect(response.headers.get('x-ratelimit-remaining')).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it('returns toErrorResponse for auth failures', async () => {
    mocks.requireRole.mockRejectedValueOnce(new Error('nope'));
    const response = await POST(multipart(xlsxFile()));
    expect(response.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });
});
