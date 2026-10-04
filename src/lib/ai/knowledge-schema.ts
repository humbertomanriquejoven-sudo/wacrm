/**
 * Tolerating an out-of-date schema for the knowledge base.
 *
 * `filename` and `source_type` are added by
 * `supabase/migrations/055_knowledge_document_filename.sql`. Until that
 * migration is applied to a given database, any statement that MENTIONS those
 * columns fails — including a plain `SELECT`, because PostgREST resolves the
 * whole projection up front.
 *
 * That makes a hard dependency on the new columns actively harmful: a user who
 * has not run the migration could not upload a file, nor even load the
 * document list. So the knowledge routes probe with the richer shape and fall
 * back to the legacy one, which keeps the feature working before AND after the
 * migration instead of only after it.
 *
 * Once 055 is applied everywhere these helpers become no-ops: the first
 * attempt succeeds and the fallback never runs.
 */

/** Postgres SQLSTATE for "column does not exist". */
const UNDEFINED_COLUMN = '42703';
/** PostgREST's schema-cache miss for a column it does not know about. */
const SCHEMA_CACHE_MISS_CODES = new Set(['PGRST204', 'PGRST205']);

/**
 * True when `error` means "this column doesn't exist here" rather than a real
 * failure. Both the raw SQLSTATE and PostgREST's own codes are checked,
 * because the surfaced code differs depending on whether the query reached
 * Postgres or was rejected by PostgREST while resolving the projection.
 */
export function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown; details?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === UNDEFINED_COLUMN || SCHEMA_CACHE_MISS_CODES.has(code)) {
    return true;
  }
  // Supabase sometimes surfaces only a message, e.g.
  // `column ai_knowledge_documents.filename does not exist`.
  const message = `${typeof e.message === 'string' ? e.message : ''} ${
    typeof e.details === 'string' ? e.details : ''
  }`.toLowerCase();
  return (
    message.includes('does not exist') && message.includes('column')
  );
}

/** Column names added by 055, in the order they are probed. */
export const OPTIONAL_DOCUMENT_COLUMNS = ['filename', 'source_type'] as const;