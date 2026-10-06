import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument, ingestWarning } from '@/lib/ai/knowledge'
import {
  httpStatusForDbError,
  reportKnowledgeDbError,
} from '@/lib/ai/knowledge-errors'
import {
  deleteKnowledgeDocument,
  knowledgeDeleteFailureResponse,
  markKnowledgeDocumentStatus,
  selectKnowledgeDocumentSummaries,
} from '@/lib/ai/knowledge-documents'

/**
 * GET /api/ai/knowledge
 *
 * List the account's knowledge-base documents (any member).
 *
 * The projection degrades through the tiers in
 * `DOCUMENT_SUMMARY_PROJECTIONS` (061 → 055 → 030): PostgREST rejects
 * the whole projection when one column is unknown, which would leave
 * the panel showing "No documents yet." on a database that has plenty
 * of documents. `created_at` (migration 030, always present) drives the
 * ordering — this panel is an upload log ("what did I add, most recent
 * first"), so a document edited months later must not jump to the top
 * as if it had just been added.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await selectKnowledgeDocumentSummaries(
      supabase,
      accountId,
    )
    if (error) {
      console.error('[ai/knowledge GET] error:', error)
      return NextResponse.json(
        reportKnowledgeDbError(error, 'list knowledge documents', {
          accountId,
        }),
        { status: httpStatusForDbError(error) },
      )
    }
    return NextResponse.json({ documents: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/knowledge  (admin+)
 *
 * Create a document, then chunk + (optionally) embed it. If indexing
 * fails the document is still saved so the admin can retry via reindex —
 * and (migration 061) the failure is recorded on the row as
 * status='error' with the reason, so the list shows it instead of
 * pretending everything is fine.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!title || !content) {
      return NextResponse.json(
        { error: 'title and content are required' },
        { status: 400 },
      )
    }

    const { data: doc, error } = await supabase
      .from('ai_knowledge_documents')
      .insert({ account_id: accountId, created_by: userId, title, content })
      .select('id')
      .single()
    if (error || !doc) {
      console.error('[ai/knowledge POST] insert error:', error)
      return NextResponse.json(
        reportKnowledgeDbError(error, 'create knowledge document', {
          accountId,
          userId,
          title,
          contentChars: content.length,
        }),
        { status: httpStatusForDbError(error) },
      )
    }

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      supabase,
      accountId,
    )
    try {
      await ingestDocument(
        supabase,
        accountId,
        { embeddingsApiKey },
        doc.id,
        content,
      )
    } catch (err) {
      console.error('[ai/knowledge POST] ingest error:', err)
      // Record the failure on the row (best-effort — 061 may be absent),
      // then tell the caller. The document is saved either way.
      const warning = ingestWarning('Saved', err)
      await markKnowledgeDocumentStatus(supabase, accountId, doc.id, 'error', warning)
      return NextResponse.json(
        {
          success: true,
          id: doc.id,
          warning,
        },
        { status: 200 },
      )
    }
    await markKnowledgeDocumentStatus(supabase, accountId, doc.id, 'ready', null)

    if (corrupt) {
      return NextResponse.json({
        success: true,
        id: doc.id,
        warning:
          'Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
      })
    }
    return NextResponse.json({ success: true, id: doc.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/knowledge?id={id}  (admin+)
 *
 * Query-param alias of DELETE /api/ai/knowledge/[id]. Both forms are
 * supported because the id has to travel somewhere: the collection route
 * is the natural target for `?id=`, the dynamic segment for REST purity.
 * They share `deleteKnowledgeDocument` so the account scoping, the
 * stored-file removal and the chunk cascade cannot drift between them.
 *
 * Cleanup order (see the function for the full note): stored original
 * first, then the row — the `document_id` foreign key is ON DELETE
 * CASCADE (migration 030), so the chunks and their embeddings are
 * physically removed and cannot still be retrieved.
 */
export async function DELETE(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const id = new URL(request.url).searchParams.get('id')
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    const result = await deleteKnowledgeDocument(supabase, accountId, id)
    if (!result.ok) {
      const { body, status } = knowledgeDeleteFailureResponse(result, {
        accountId,
        documentId: id,
      })
      return NextResponse.json(body, { status })
    }
    return NextResponse.json({ success: true, id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
