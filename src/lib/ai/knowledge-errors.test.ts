import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  describeDbError,
  httpStatusForDbError,
  reportKnowledgeDbError,
  reportKnowledgeFatalError,
} from './knowledge-errors';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Shape the Supabase client returns for a Postgres failure. */
function pgError(code: string, message: string, extra: object = {}) {
  return { code, message, details: '', hint: '', ...extra };
}

describe('describeDbError', () => {
  it('pulls apart a Supabase error object', () => {
    expect(
      describeDbError(
        pgError('23502', 'null value in column "title" violates not-null constraint')
      )
    ).toEqual({
      code: '23502',
      message: 'null value in column "title" violates not-null constraint',
      details: '',
      hint: '',
    });
  });

  it('survives a non-object (a thrown string or a transport failure)', () => {
    expect(describeDbError('socket hang up')).toEqual({
      code: '',
      message: 'socket hang up',
      details: '',
      hint: '',
    });
    expect(describeDbError(null).message).toBe('null');
  });
});

describe('httpStatusForDbError', () => {
  it('reports an RLS rejection as 403, not a generic 500', () => {
    // This is the distinction that matters most: "your role cannot write
    // here" and "the server broke" need completely different responses.
    expect(httpStatusForDbError(pgError('42501', 'new row violates row-level security policy'))).toBe(403);
  });

  it('maps constraint violations to 409', () => {
    expect(httpStatusForDbError(pgError('23505', 'duplicate key'))).toBe(409);
    expect(httpStatusForDbError(pgError('23503', 'foreign key violation'))).toBe(409);
  });

  it('maps schema and value problems to 400', () => {
    expect(httpStatusForDbError(pgError('42703', 'column does not exist'))).toBe(400);
    expect(httpStatusForDbError(pgError('PGRST204', 'schema cache miss'))).toBe(400);
    expect(httpStatusForDbError(pgError('23502', 'not-null violation'))).toBe(400);
  });

  it('maps a statement timeout to 504 and a dead connection to 503', () => {
    expect(httpStatusForDbError(pgError('57014', 'canceling statement due to statement timeout'))).toBe(504);
    expect(httpStatusForDbError(pgError('08006', 'connection failure'))).toBe(503);
  });

  it('falls back to 500 for anything unrecognised', () => {
    expect(httpStatusForDbError(pgError('XX000', 'something odd'))).toBe(500);
    expect(httpStatusForDbError(undefined)).toBe(500);
  });
});

describe('reportKnowledgeDbError', () => {
  it('logs the greppable tag with full context', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportKnowledgeDbError(
      pgError('42501', 'new row violates row-level security policy'),
      'insert knowledge document',
      { accountId: 'account-1', userId: 'user-1', filename: 'precios.xlsx' }
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [tag, detail] = spy.mock.calls[0];
    expect(tag).toContain('KNOWLEDGE_BASE_DB_ERROR');
    expect(tag).toContain('insert knowledge document');
    expect(detail).toMatchObject({
      operation: 'insert knowledge document',
      accountId: 'account-1',
      filename: 'precios.xlsx',
      code: '42501',
    });
  });

  it('returns the real database message, not a generic string', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = reportKnowledgeDbError(
      pgError('23502', 'null value in column "title" violates not-null constraint'),
      'insert knowledge document'
    );
    // The whole point: DevTools must show WHY, not "Failed to save document".
    expect(body.error).toBe(
      'null value in column "title" violates not-null constraint'
    );
    expect(body.db_code).toBe('23502');
  });

  it('adds actionable advice for the RLS case', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = reportKnowledgeDbError(
      pgError('42501', 'new row violates row-level security policy'),
      'insert knowledge document'
    );
    expect(body.advice).toMatch(/admin member/i);
  });

  it('adds actionable advice pointing at migration 055 for a missing column', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = reportKnowledgeDbError(
      pgError('42703', 'column ai_knowledge_documents.filename does not exist'),
      'insert knowledge document'
    );
    expect(body.advice).toContain('055_knowledge_document_filename.sql');
  });

  it('points at migration 061 when the missing column belongs to it', () => {
    // 42703 is ambiguous: BOTH 055 (filename/source_type) and 061
    // (storage_path/status/file_size/…) report it. The column name in the
    // message is the only signal — pointing an operator at 055 when 061 is
    // the gap sends them to re-apply a migration that is already there.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const column of [
      'storage_path',
      'file_size',
      'mime_type',
      'status',
      'error_message',
    ]) {
      const body = reportKnowledgeDbError(
        pgError('42703', `column ai_knowledge_documents.${column} does not exist`),
        'insert knowledge document'
      );
      expect(body.advice).toContain('061_knowledge_document_storage.sql');
      expect(body.advice).not.toContain('055_knowledge_document_filename.sql');
    }
  });

  it('recognises the PostgREST wording of a missing column too', () => {
    // PostgREST answers a projection with PGRST204 and its own phrasing —
    // no "column … does not exist" to match, and no SQLSTATE 42703.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = reportKnowledgeDbError(
      pgError(
        'PGRST204',
        "Could not find the 'status' column of 'ai_knowledge_documents' in the schema cache"
      ),
      'list knowledge documents'
    );
    expect(body.advice).toContain('061_knowledge_document_storage.sql');
  });

  it('still produces a usable message when the driver gives no code', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = reportKnowledgeDbError(
      { message: '', details: 'connection terminated unexpectedly' },
      'insert knowledge document'
    );
    expect(body.error).toBe('connection terminated unexpectedly');
    expect(body.db_code).toBe('');
  });

  it('names the missing table when the whole table is absent (42P01)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The failure that makes EVERY upload fail identically when the
    // knowledge-base migrations were never applied.
    const body = reportKnowledgeDbError(
      pgError('42P01', 'relation "ai_knowledge_documents" does not exist'),
      'insert knowledge document'
    );
    expect(body.advice).toContain('ai_knowledge_documents');
    expect(body.advice).toContain('030_ai_knowledge.sql');
    expect(body.advice).toContain('055_knowledge_document_filename.sql');
    // 500 is honest — the server's schema is wrong — but it is no longer blank.
    expect(httpStatusForDbError(pgError('42P01', 'x'))).toBe(500);
  });

  it('maps the newly handled codes to meaningful statuses', () => {
    expect(httpStatusForDbError(pgError('22001', 'value too long'))).toBe(400);
    expect(httpStatusForDbError(pgError('23P01', 'conflict'))).toBe(409);
    expect(httpStatusForDbError(pgError('PGRST116', 'no rows'))).toBe(404);
  });

  it('explains a truncation and an exclusion conflict', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      reportKnowledgeDbError(pgError('22001', 'value too long'), 'insert').advice
    ).toMatch(/column/i);
    expect(
      reportKnowledgeDbError(pgError('23P01', 'conflict'), 'insert').advice
    ).toMatch(/exclusion/i);
  });
});

describe('reportKnowledgeFatalError', () => {
  it('surfaces the real message instead of "Internal server error"', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = reportKnowledgeFatalError(
      new Error('supabaseUrl is required'),
      'POST /api/ai/knowledge/upload'
    );
    // The whole point: a systemic fault fails every upload the same way, so
    // a generic message leaves nothing to act on.
    expect(body.error).toContain('supabaseUrl is required');
    expect(body.error).not.toMatch(/^Internal server error$/);
    expect(body.error).toContain('KNOWLEDGE_BASE_DB_ERROR');
  });

  it('logs the failure server-side with its operation', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportKnowledgeFatalError(new Error('boom'), 'POST /api/ai/knowledge/upload');
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('KNOWLEDGE_BASE_DB_ERROR'),
      expect.objectContaining({ operation: 'POST /api/ai/knowledge/upload' })
    );
  });

  it('handles a thrown non-Error without producing an empty message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(reportKnowledgeFatalError('plain string', 'op').error).toContain(
      'plain string'
    );
    expect(reportKnowledgeFatalError(undefined, 'op').error).not.toBe('');
  });

  it('reports empty db_* fields so clients cannot mistake it for a DB error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = reportKnowledgeFatalError(new Error('x'), 'op');
    expect(body.db_code).toBe('');
    expect(body.db_message).toBe('x');
  });
});
