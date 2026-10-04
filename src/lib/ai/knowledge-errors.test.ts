import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  describeDbError,
  httpStatusForDbError,
  reportKnowledgeDbError,
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

  it('still produces a usable message when the driver gives no code', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = reportKnowledgeDbError(
      { message: '', details: 'connection terminated unexpectedly' },
      'insert knowledge document'
    );
    expect(body.error).toBe('connection terminated unexpectedly');
    expect(body.db_code).toBe('');
  });
});
