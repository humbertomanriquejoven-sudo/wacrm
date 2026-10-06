/**
 * Making knowledge-base database failures VISIBLE.
 *
 * Every route here used to collapse a Supabase/Postgres failure into a generic
 * `{ error: 'Failed to save document' }`. That is the worst possible outcome
 * for the symptom this module exists to explain: an operator whose upload
 * "does not save" sees nothing in the server log and nothing useful in
 * DevTools, so they cannot tell an RLS rejection from an unapplied migration,
 * a constraint violation or a dropped connection — and neither can we.
 *
 * So failures now travel in two directions at once:
 *   1. `KNOWLEDGE_BASE_DB_ERROR` on the server, with the full driver error
 *      (SQLSTATE code, message, details, hint) and the operation that failed.
 *   2. A JSON body to the client carrying the real database message and the
 *      mapped HTTP status, so the browser's Network tab shows the cause.
 *
 * These endpoints are admin-gated (`requireRole('admin')`), so returning the
 * database message leaks nothing a non-admin could not already reach, and the
 * alternative — an opaque 500 — costs far more than it saves.
 */

/** Greppable marker: `grep KNOWLEDGE_BASE_DB_ERROR` finds every one. */
const LOG_TAG = 'KNOWLEDGE_BASE_DB_ERROR';

export interface KnowledgeDbErrorParts {
  /** Postgres SQLSTATE, PostgREST code, or '' when the driver gave none. */
  code: string;
  message: string;
  details: string;
  hint: string;
}

/**
 * Normalise whatever the Supabase client handed back into the four fields
 * worth reporting. PostgREST puts the SQLSTATE in `code`; a transport failure
 * has no code at all, which is itself the diagnosis.
 */
export function describeDbError(error: unknown): KnowledgeDbErrorParts {
  if (!error || typeof error !== 'object') {
    return {
      code: '',
      message: error instanceof Error ? error.message : String(error),
      details: '',
      hint: '',
    };
  }
  const e = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  return {
    code: typeof e.code === 'string' ? e.code : '',
    message: typeof e.message === 'string' ? e.message : '',
    details: typeof e.details === 'string' ? e.details : '',
    hint: typeof e.hint === 'string' ? e.hint : '',
  };
}

/**
 * SQLSTATE → HTTP status.
 *
 * The distinction that matters most in practice: `42501`
 * (insufficient_privilege) is what an RLS policy rejection looks like, and it
 * is reported as 403 rather than a generic 500 — "your role cannot insert
 * here" and "the server broke" call for completely different responses from
 * whoever is debugging it.
 */
export function httpStatusForDbError(error: unknown): number {
  const { code } = describeDbError(error);
  switch (code) {
    // RLS policy rejected the row.
    case '42501':
      return 403;
    // unique_violation / foreign_key_violation / check_violation.
    case '23505':
    case '23503':
    case '23514':
      return 409;
    // not_null_violation, undefined_column, invalid_text_representation,
    // string_data_right_truncation (extracted text longer than the column).
    case '23502':
    case '42703':
    case '22P02':
    case '22001':
      return 400;
    // PostgREST could not resolve the projection (unknown column).
    case 'PGRST204':
    case 'PGRST205':
      return 400;
    // undefined_table. A 500 is the honest status — the server's schema is
    // wrong, not the request — but it now travels with advice naming the
    // missing relation, because this is the single failure that makes
    // EVERY upload fail identically.
    case '42P01':
      return 500;
    // exclusion_violation.
    case '23P01':
      return 409;
    // PGRST116: a single() lookup matched no rows.
    case 'PGRST116':
      return 404;
    // query_canceled — usually a statement timeout on a large upload.
    case '57014':
      return 504;
    // connection_failure / cannot_connect_now / admin_shutdown.
    case '08000':
    case '08003':
    case '08006':
    case '57P01':
      return 503;
    default:
      return 500;
  }
}

/**
 * A short, human-readable next step for the failures that have one known fix.
 * Purely advisory — the raw database message always rides along next to it.
 */
function adviceFor(parts: KnowledgeDbErrorParts): string | undefined {
  if (parts.code === '42P01') {
    // The relation named in the Postgres message is the one to create; it is
    // quoted after `relation "..." does not exist`.
    const relation = parts.message.match(/relation\s+"([^"]+)"/i)?.[1];
    return `The database is missing the table or function "${relation ?? '(unnamed)'}", so every knowledge-base write fails the same way. Apply the knowledge-base migrations in order: supabase/migrations/030_ai_knowledge.sql, then 055_knowledge_document_filename.sql.`;
  }
  if (parts.code === '42501') {
    return 'Row-level security rejected this write. The signed-in user must be an admin member of the account (ai_knowledge_documents INSERT policy requires is_account_member(account_id, \'admin\')).';
  }
  if (
    parts.code === '42703' ||
    parts.code === 'PGRST204' ||
    parts.code === 'PGRST205' ||
    (parts.message.toLowerCase().includes('does not exist') &&
      parts.message.toLowerCase().includes('column'))
  ) {
    // Which column is missing decides WHICH migration to point at:
    //   * filename/source_type → 055
    //   * storage_path/file_size/mime_type/status/error_message → 061
    // Both arrive as 42703/PGRST204, so the column name in the driver's
    // message is the only signal. Two message shapes are read — the
    // Postgres `column x.y does not exist` and PostgREST's
    // `Could not find the 'x' column of 'y' in the schema cache`.
    const missingColumn =
      parts.message.match(/column\s+"?([\w.]+)"?\s+does not exist/i)?.[1] ??
      parts.message.match(/Could not find the '(\w+)' column/i)?.[1] ??
      '';
    const columnName = missingColumn.split('.').pop() ?? '';
    if (
      /^(storage_path|file_size|mime_type|status|error_message)$/i.test(columnName)
    ) {
      return 'The database schema is missing a column this app expects. Apply supabase/migrations/061_knowledge_document_storage.sql (storage_path, file_size, mime_type, status, error_message).';
    }
    return 'The database schema is missing a column this app expects. Apply supabase/migrations/055_knowledge_document_filename.sql (filename, source_type).';
  }
  if (parts.code === '22001') {
    return 'A text value was longer than its column allows. The extracted document text exceeded the column limit; split the file or raise the column width.';
  }
  if (parts.code === '23P01') {
    return 'An exclusion constraint rejected the row — the account already has a knowledge document covering that time range.';
  }
  if (parts.code === 'PGRST116') {
    return 'No matching row was found, or it is not visible under your account/role. The document may belong to another account, or it may have been deleted.';
  }
  if (parts.code === '57014') {
    return 'The statement timed out. The extracted text may be too large to index in one request.';
  }
  if (parts.code === '23502') {
    return 'A NOT NULL column received no value. This is a code bug in the insert payload, not user error.';
  }
  if (parts.code === '08006' || parts.code === '08003') {
    return 'The database was unreachable. Check the Supabase project status and the service_role key.';
  }
  return undefined;
}

/**
 * Report a NON-database failure — an exception thrown outside the guarded
 * database calls (auth, request parsing, a bug in this handler).
 *
 * These routes are admin-gated, so the message reaches only a signed-in admin
 * of the account, and it used to be replaced wholesale by
 * `{ error: "Internal server error" }`. That is the same blind spot this
 * module exists to remove, one layer up: a systemic fault (a missing env
 * var, a broken auth client) fails every upload identically and says nothing
 * about why. The status stays 500 — the server is at fault — but the response
 * now names the cause and points at the server log.
 */
export function reportKnowledgeFatalError(
  error: unknown,
  operation: string,
  context: Record<string, unknown> = {},
): { error: string; db_code: ''; db_message: string; details: string; hint: string } {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'The knowledge base request failed with an unrecognised error.';
  console.error(`${LOG_TAG}: ${operation} threw`, {
    operation,
    ...context,
    message,
    raw: error,
  });
  return {
    error: `${message} (see server logs: ${LOG_TAG})`,
    db_code: '',
    db_message: message,
    details: '',
    hint: '',
  };
}

/**
 * Report a database failure: log it server-side with full context, and return
 * the JSON body the route should hand back to the client.
 *
 * `operation` names the write that failed ("insert document", "list
 * documents") so a log line is actionable without cross-referencing the
 * route that emitted it.
 */
export function reportKnowledgeDbError(
  error: unknown,
  operation: string,
  context: Record<string, unknown> = {},
): {
  error: string;
  db_code: string;
  db_message: string;
  db_details: string;
  db_hint: string;
  advice?: string;
} {
  const parts = describeDbError(error);
  const advice = adviceFor(parts);

  console.error(`${LOG_TAG}: ${operation} failed`, {
    operation,
    ...context,
    code: parts.code || '(none)',
    message: parts.message || '(none)',
    details: parts.details || undefined,
    hint: parts.hint || undefined,
    advice,
    raw: error,
  });

  // Prefer the database's own words. They name the table, the column and the
  // constraint; a hand-written "Failed to save document" names nothing.
  const message =
    parts.message ||
    parts.details ||
    'The knowledge base request failed with no database message.';

  return {
    error: message,
    db_code: parts.code,
    db_message: parts.message,
    db_details: parts.details,
    db_hint: parts.hint,
    ...(advice ? { advice } : {}),
  };
}
