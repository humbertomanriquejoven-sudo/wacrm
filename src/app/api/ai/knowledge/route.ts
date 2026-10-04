import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'
import { isMissingColumnError } from '@/lib/ai/knowledge-schema'
import {
  httpStatusForDbError,
  reportKnowledgeDbError,
} from '@/lib/ai/knowledge-errors'

/**
 * GET /api/ai/knowledge
 *
 * List the account's knowledge-base documents (any member).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    // Ask for the 055 columns first, but never let their absence break the
    // list: PostgREST rejects the whole projection when one column is unknown,
    // which would leave the panel showing "No documents yet." on a database
    // that has plenty of documents.
    //
    // `created_at` comes from migration 030 (the table's own definition), so
    // unlike filename/source_type it is always present and is safe to depend
    // on. The UI uses it to show when a document was added.
    const rich = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, filename, source_type, created_at, updated_at')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false })

    if (!rich.error) {
      return NextResponse.json({ documents: rich.data ?? [] })
    }

    if (!isMissingColumnError(rich.error)) {
      console.error('[ai/knowledge GET] error:', rich.error)
      return NextResponse.json(
        reportKnowledgeDbError(rich.error, 'list knowledge documents', {
          accountId,
          projection: 'rich',
        }),
        { status: httpStatusForDbError(rich.error) },
      )
    }

    console.warn(
      '[ai/knowledge GET] 055 not applied; listing documents without filename/source_type.',
    )
    const { data, error } = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, created_at, updated_at')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false })
    if (error) {
      console.error('[ai/knowledge GET] error:', error)
      return NextResponse.json(
        reportKnowledgeDbError(error, 'list knowledge documents (legacy shape)', {
          accountId,
          projection: 'legacy',
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
 * fails the document is still saved so the admin can retry via reindex.
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
      const message = err instanceof AiError ? err.message : 'indexing failed'
      console.error('[ai/knowledge POST] ingest error:', err)
      return NextResponse.json(
        {
          success: true,
          id: doc.id,
          warning: `Saved, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
        },
        { status: 200 },
      )
    }

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
 * supported because the id has to travel somewhere: the collection route is
 * the natural target for `?id=`, the dynamic segment for REST purity. They
 * share one implementation so the account scoping and the chunk cascade
 * cannot drift between them.
 *
 * Chunks and their embeddings go with the document: the `document_id`
 * foreign key is ON DELETE CASCADE (migration 030), so the vectors are
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

    const { error } = await supabase
      .from('ai_knowledge_documents')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) {
      console.error('[ai/knowledge DELETE] error:', error)
      return NextResponse.json(
        reportKnowledgeDbError(error, 'delete knowledge document', {
          accountId,
          documentId: id,
        }),
        { status: httpStatusForDbError(error) },
      )
    }
    return NextResponse.json({ success: true, id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
