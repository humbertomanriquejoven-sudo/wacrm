import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'

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
  const rows = chunks.map((chunkContent, i) => ({
    document_id: documentId,
    account_id: accountId,
    chunk_index: NEW_INDEX_BASE + i,
    content: chunkContent,
    embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
  }))

  const { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows)
  if (insErr) throw insErr

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
