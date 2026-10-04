import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import { chunkText } from './chunk'
import {
  EMBEDDING_DIMENSIONS,
  embedTexts,
  toVectorLiteral,
} from './embeddings'
import { AiError } from './types'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical full-text search).
// ============================================================

interface MatchRow {
  id: string
  content: string
}

/**
 * Build the user-facing warning for a document that was saved but whose
 * index did not fully build.
 *
 * This distinguishes the two failure classes, because they are NOT
 * equivalent for the reader:
 *  - semantic-only failure → the chunks exist, keyword search answers, so
 *    the document is usable;
 *  - chunk-write failure → the document has zero chunks and is invisible to
 *    every retrieval path, so saying "lexical search still works" would be
 *    a lie the operator then debugs for an hour.
 *
 * `prefix` is the route's own lead-in ("Saved", "Updated").
 */
export function ingestWarning(prefix: string, err: unknown): string {
  const detail =
    err instanceof AiError ? err.message : err instanceof Error ? err.message : 'indexing failed'
  if (err instanceof AiError && err.code === 'knowledge_chunk_write_failed') {
    return `${prefix}, but it is NOT searchable yet — ${detail} Fix the storage error, then use Reindex.`
  }
  return `${prefix}, but semantic indexing failed (${detail}). Keyword search still works; use Reindex to retry.`
}

/**
 * True when `vectors` can actually be written to a `vector(1536)` column:
 * one vector per chunk, every one exactly EMBEDDING_DIMENSIONS wide.
 *
 * pgvector rejects the WHOLE statement on a single bad vector, so this is
 * checked as an all-or-nothing precondition rather than per row.
 */
function embeddingsFitColumn(
  vectors: number[][],
  expectedCount: number
): boolean {
  if (vectors.length !== expectedCount) return false
  return vectors.every(
    (v) => Array.isArray(v) && v.length === EMBEDDING_DIMENSIONS
  )
}

/** A precise, actionable reason the semantic payload was rejected. */
function describeEmbeddingMismatch(
  vectors: number[][],
  expectedCount: number
): AiError {
  if (vectors.length !== expectedCount) {
    return new AiError(
      `The embeddings provider returned ${vectors.length} vectors for ${expectedCount} chunks.`,
      { code: 'knowledge_embedding_count_mismatch' }
    )
  }
  const widths = [...new Set(vectors.map((v) => (Array.isArray(v) ? v.length : -1)))]
  return new AiError(
    `The embeddings provider returned ${widths.join('/')} dimensions but the knowledge base column is vector(${EMBEDDING_DIMENSIONS}). Check EMBEDDING_MODEL in src/lib/ai/embeddings.ts matches the applied migration.`,
    { code: 'knowledge_embedding_dimension_mismatch' }
  )
}

/**
 * (Re)build the chunks for one document. Deletes the document's
 * existing chunks, re-chunks the content, and — when the account has an
 * embeddings key — embeds each chunk. Runs under whatever client the
 * caller passes (service-role for ingest routes).
 *
 * Throws on embedding failure so the ingest route can report it; the
 * chunks are only written once embedding (if attempted) succeeds, so a
 * failed embed never leaves half-indexed rows.
 */
export async function ingestDocument(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  documentId: string,
  content: string,
): Promise<void> {
  const chunks = chunkText(content)

  // Embed FIRST, before touching any stored state: this is a remote call and
  // the slowest step, so nothing should be at risk while it is in flight.
  //
  // Embed if a key is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically. We record the error and rethrow it
  // AFTER inserting (embedding-less) rows, so the route can warn
  // "semantic indexing failed" — which is now truthful, because lexical
  // search really does still work.
  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (chunks.length > 0 && config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks)
    } catch (err) {
      embedError = err
    }
  }

  // The column is `vector(1536)` (migration 030). A provider that answers
  // with a different width would fail the ENTIRE chunk insert below — one
  // mismatched vector and the document gets ZERO chunks, which makes it
  // invisible to BOTH retrieval paths while the document row itself still
  // exists and still shows in the UI.
  //
  // That is the worst possible outcome: a file that looks saved, is listed,
  // and is never once quoted by the agent. So the payload is checked here,
  // before it can reach the insert, and a mismatch degrades to lexical-only
  // instead of taking the whole index down with it.
  if (embeddings && !embeddingsFitColumn(embeddings, chunks.length)) {
    embedError = describeEmbeddingMismatch(embeddings, chunks.length)
    console.error(
      `[knowledge] document ${documentId}: ${embedError instanceof Error ? embedError.message : embedError} — indexing without semantic search so keyword search still works.`
    )
    embeddings = null
  }

  // No content left: the document genuinely has nothing to index, so clearing
  // its chunks is the correct end state.
  if (chunks.length === 0) {
    const { error: delErr } = await db
      .from('ai_knowledge_chunks')
      .delete()
      .eq('document_id', documentId)
    if (delErr) throw delErr
    return
  }

  // WRITE-THEN-PRUNE, not delete-then-insert.
  //
  // The previous order (DELETE old → remote embed → INSERT new) had a window
  // where the document had ZERO chunks: if the insert failed or the process
  // restarted mid-flight, the document row survived, the route still answered
  // 200, and the content became permanently unretrievable — a silent,
  // unrecoverable data loss. Reindex ran that destructive cycle across every
  // document in the account.
  //
  // New rows are written into a high, disjoint index range first, so they can
  // never collide with the rows being replaced. Only once they are safely in
  // the database do we remove the superseded ones. If the prune then fails,
  // the worst case is duplicate chunks — retrieval still works.
  const NEW_INDEX_BASE = 1_000_000;
  // `vectors?.[i]` may be undefined if the provider returned fewer vectors
  // than chunks; store NULL rather than letting toVectorLiteral(undefined)
  // throw and lose the entire batch.
  const buildRows = (vectors: number[][] | null) =>
    chunks.map((chunkContent, i) => ({
      document_id: documentId,
      account_id: accountId,
      chunk_index: NEW_INDEX_BASE + i,
      content: chunkContent,
      embedding: vectors?.[i] ? toVectorLiteral(vectors[i] as number[]) : null,
    }));

  let rows = buildRows(embeddings);
  let { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows);

  // The insert failed WHILE embeddings were attached. Retry without them.
  //
  // This is what makes the route's promise — "semantic indexing failed,
  // lexical search still works" — actually true. Without the retry the whole
  // batch is lost, the document keeps zero chunks, and neither
  // match_ai_knowledge_fts nor match_ai_knowledge_semantic can ever return
  // it: the file is listed in the UI and permanently invisible to the agent.
  if (insErr && embeddings) {
    console.error(
      `[knowledge] document ${documentId}: chunk insert failed with embeddings attached (${insErr.message ?? insErr.code}); retrying without semantic vectors so keyword search still works.`
    );
    rows = buildRows(null);
    const retry = await db.from('ai_knowledge_chunks').insert(rows);
    insErr = retry.error;
    if (!insErr) {
      embedError = new AiError(
        'The database rejected the semantic vectors; stored as keyword-only. Reindex once the cause is fixed.',
        { code: 'knowledge_embedding_insert_failed' }
      );
    }
  }
  if (insErr) {
    // Both the vector attempt and the keyword-only retry failed, so the
    // document has NO chunks at all. Flag it distinctly: the ingest routes
    // must not promise that keyword search works in this state.
    throw new AiError(
      `No chunks could be stored for this document (${insErr.message ?? insErr.code}).`,
      { code: 'knowledge_chunk_write_failed' }
    )
  };

  // Prune everything outside the freshly written range (i.e. all pre-existing
  // rows for this document).
  const { error: pruneErr } = await db
    .from('ai_knowledge_chunks')
    .delete()
    .eq('document_id', documentId)
    .or(`chunk_index.lt.${NEW_INDEX_BASE},chunk_index.gte.${NEW_INDEX_BASE + chunks.length}`)
  if (pruneErr) {
    // The new chunks are already stored and searchable; only the stale ones
    // linger. Surface it, but do NOT throw — throwing here would make the route
    // report a failed save for what is really a successful, usable index.
    console.error(
      `[knowledge] stale chunks for document ${documentId} were not pruned:`,
      pruneErr
    )
  }

  if (embedError) throw embedError
}

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`.
 *
 * Semantic-primary when an embeddings key is configured (embed the
 * query → cosine-nearest chunks), then topped up with lexical full-text
 * matches to fill `k`. Lexical-only when there's no key. Best-effort:
 * any failure (no KB, embedding error, RPC error) degrades to fewer or
 * zero results and never throws into the draft / auto-reply path.
 */
export async function retrieveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5,
): Promise<string[]> {
  const query = queryText.trim()
  if (!query || k <= 0) return []

  // Skip everything when the account has no knowledge base — otherwise
  // every draft / auto-reply would pay for a query embedding + two RPCs
  // just to get []. One cheap indexed COUNT (head, no rows) instead of a
  // paid embeddings call on the hot path.
  try {
    const { count, error } = await db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (error || !count) return []
  } catch {
    return []
  }

  const picked = new Map<string, string>() // id → content, preserves order

  // Semantic path.
  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [query])
      if (queryEmbedding) {
        const { data, error } = await db.rpc('match_ai_knowledge_semantic', {
          p_account_id: accountId,
          p_query_embedding: toVectorLiteral(queryEmbedding),
          p_match_count: k,
        })
        if (!error && Array.isArray(data)) {
          for (const row of data as MatchRow[]) picked.set(row.id, row.content)
        }
      }
    } catch (err) {
      console.error('[ai knowledge] semantic retrieval failed, falling back to FTS:', err)
    }
  }

  // Lexical top-up (also the sole path when there's no embeddings key).
  if (picked.size < k) {
    try {
      const { data, error } = await db.rpc('match_ai_knowledge_fts', {
        p_account_id: accountId,
        p_query: query,
        p_match_count: k,
      })
      if (!error && Array.isArray(data)) {
        for (const row of data as MatchRow[]) {
          if (picked.size >= k) break
          if (!picked.has(row.id)) picked.set(row.id, row.content)
        }
      }
    } catch (err) {
      console.error('[ai knowledge] lexical retrieval failed:', err)
    }
  }

  return Array.from(picked.values()).slice(0, k)
}
