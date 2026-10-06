import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError } from './knowledge-schema';
import { removeKnowledgeFile } from './knowledge-storage';
import {
  httpStatusForDbError,
  reportKnowledgeDbError,
  reportKnowledgeFatalError,
} from './knowledge-errors';

/**
 * Shared row-level operations for knowledge documents.
 *
 * The collection route, the [id] route and the upload route used to
 * each re-implement "list the summaries" / "delete a document", with
 * comments promising they could not drift while nothing actually
 * shared code. Every schema-tolerance decision (which projection to
 * fall back to when migration 055 / 061 is missing) and every
 * cleanup order (storage object BEFORE the row) now lives here, so a
 * change to either is a change everywhere.
 */

export type KnowledgeDocumentStatus =
  | 'uploading'
  | 'processing'
  | 'ready'
  | 'error';

export interface KnowledgeDocumentSummary {
  id: string;
  title: string;
  /** Original upload name (migration 055). */
  filename?: string | null;
  /** Parser that produced the text (migration 055). */
  source_type?: string | null;
  /** Lifecycle state (migration 061). Absent = legacy row = ready. */
  status?: KnowledgeDocumentStatus | null;
  /** Original file size in bytes (migration 061). */
  file_size?: number | null;
  /** Why the document is in 'error' (migration 061). */
  error_message?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * Summary projections, richest first. PostgREST rejects a whole
 * projection when a single column is unknown, so the list degrades one
 * rung at a time as migrations 061 → 055 → 030 are checked:
 *
 *   1. 061 shape — adds status / file_size / error_message.
 *   2. 055 shape — filename / source_type only (061 not applied yet:
 *      the common state right after deploying this code).
 *   3. 030 shape — the columns the table was born with.
 *
 * `content` is deliberately never selected: it can be up to a million
 * characters, and the list only ever renders title, size and status.
 */
export const DOCUMENT_SUMMARY_PROJECTIONS = [
  'id, title, filename, source_type, status, file_size, error_message, created_at, updated_at',
  'id, title, filename, source_type, created_at, updated_at',
  'id, title, created_at, updated_at',
] as const;

/**
 * List the account's document summaries, newest first.
 *
 * Returns `{ data, error }` where `error` is only ever a REAL failure:
 * a missing-column error on the final (030) projection means the table
 * itself is broken, which is worth reporting — while missing-column
 * errors on the richer rungs are just "this migration is not applied
 * yet" and keep degrading silently, exactly like the old two-projection
 * code did.
 */
export async function selectKnowledgeDocumentSummaries(
  supabase: SupabaseClient,
  accountId: string
): Promise<{ data: KnowledgeDocumentSummary[] | null; error: unknown }> {
  let lastMissingColumnError: unknown = null;
  for (const projection of DOCUMENT_SUMMARY_PROJECTIONS) {
    const { data, error } = await supabase
      .from('ai_knowledge_documents')
      .select(projection)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });
    if (!error) {
      // The union of the three parsed projection types is unusable here —
      // the shapes are intentionally partial and the caller only renders
      // them, so cast through `unknown` once, at the boundary.
      return { data: (data ?? []) as unknown as KnowledgeDocumentSummary[], error: null };
    }
    if (!isMissingColumnError(error)) return { data: null, error };
    lastMissingColumnError = error;
  }
  return { data: null, error: lastMissingColumnError };
}

export type KnowledgeDocumentDeleteResult =
  | { ok: true }
  | { ok: false; stage: 'load' | 'storage' | 'delete'; error: unknown };

/**
 * Delete a document with NO orphans in either direction.
 *
 * Order is deliberate and load-bearing:
 *
 *   1. Load `storage_path` (scoped to the account, so one tenant can
 *      never learn another's object paths). A missing 061 column means
 *      there is no stored original to worry about — degrade to step 2.
 *   2. Remove the stored original FIRST. If storage refuses, the whole
 *      delete aborts with the row still present: the user can retry,
 *      and nothing is half-deleted. Removing the row first would leave
 *      an unreachable file with no reference to it.
 *   3. Delete the row. `ai_knowledge_chunks.document_id` is ON DELETE
 *      CASCADE (migration 030), so the chunks and their embeddings go
 *      with it in the same statement.
 *
 * Shared by `DELETE /api/ai/knowledge?id=` and
 * `DELETE /api/ai/knowledge/[id]` so the two cannot drift.
 */
export async function deleteKnowledgeDocument(
  supabase: SupabaseClient,
  accountId: string,
  documentId: string
): Promise<KnowledgeDocumentDeleteResult> {
  let storagePath: string | null = null;

  const { data, error: loadError } = await supabase
    .from('ai_knowledge_documents')
    .select('storage_path')
    .eq('account_id', accountId)
    .eq('id', documentId)
    .maybeSingle();
  if (loadError && !isMissingColumnError(loadError)) {
    return { ok: false, stage: 'load', error: loadError };
  }
  storagePath =
    (data as { storage_path?: string | null } | null)?.storage_path ?? null;

  if (storagePath) {
    try {
      await removeKnowledgeFile(supabase, storagePath);
    } catch (err) {
      return { ok: false, stage: 'storage', error: err };
    }
  }

  const { error: deleteError } = await supabase
    .from('ai_knowledge_documents')
    .delete()
    .eq('account_id', accountId)
    .eq('id', documentId);
  if (deleteError) return { ok: false, stage: 'delete', error: deleteError };
  return { ok: true };
}

/**
 * Map a failed `deleteKnowledgeDocument` onto the response both delete
 * routes return, so the status and the diagnostic body cannot drift:
 *
 *   * storage stage → 500 with the storage driver's message (handled,
 *     retryable; the row is still there on purpose — see the order note
 *     on `deleteKnowledgeDocument`).
 *   * load/delete stage → the database's own status via
 *     `httpStatusForDbError`, with the usual KNOWLEDGE_BASE_DB_ERROR
 *     diagnostics (SQLSTATE, message, advice).
 */
export function knowledgeDeleteFailureResponse(
  result: Extract<KnowledgeDocumentDeleteResult, { ok: false }>,
  context: { accountId: string; documentId: string }
): { body: Record<string, unknown>; status: number } {
  if (result.stage === 'storage') {
    return {
      body: reportKnowledgeFatalError(
        result.error,
        'delete knowledge document (stored file)',
        context
      ),
      status: 500,
    };
  }
  return {
    body: reportKnowledgeDbError(
      result.error,
      result.stage === 'load' ? 'load knowledge document for delete' : 'delete knowledge document',
      context
    ),
    status: httpStatusForDbError(result.error),
  };
}

/**
 * Best-effort status bookkeeping (`status`, `error_message`).
 *
 * Used on paths where the response must NOT depend on bookkeeping:
 * after an ingest failure the document is already saved, so a rejected
 * status write degrades to a server log instead of converting a
 * successful save into an error the operator cannot act on. A
 * missing-column error (061 not applied) is expected and ignored
 * silently — there is no column to write to, which is the whole point
 * of the tolerance.
 *
 * Throws NOTHING by design: every caller is inside a response path
 * that is already committed to answering the request.
 */
export async function markKnowledgeDocumentStatus(
  supabase: SupabaseClient,
  accountId: string,
  documentId: string,
  status: KnowledgeDocumentStatus,
  errorMessage: string | null = null
): Promise<void> {
  try {
    const { error } = await supabase
      .from('ai_knowledge_documents')
      .update({ status, error_message: errorMessage })
      .eq('account_id', accountId)
      .eq('id', documentId);
    if (error && !isMissingColumnError(error)) {
      console.error(
        '[knowledge] could not record document status',
        { documentId, status, code: error.code, message: error.message }
      );
    }
  } catch (err) {
    console.error('[knowledge] status update threw', { documentId, status, err });
  }
}
