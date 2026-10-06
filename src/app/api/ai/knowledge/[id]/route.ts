import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument, ingestWarning } from '@/lib/ai/knowledge'
import { isMissingColumnError } from '@/lib/ai/knowledge-schema'
import {
  httpStatusForDbError,
  reportKnowledgeDbError,
} from '@/lib/ai/knowledge-errors'
import {
  deleteKnowledgeDocument,
  knowledgeDeleteFailureResponse,
  markKnowledgeDocumentStatus,
} from '@/lib/ai/knowledge-documents'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/ai/knowledge/[id] — full document (any member).
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params
    const { data, error } = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, content, updated_at')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      console.error('[ai/knowledge/[id] GET] error:', error)
      return NextResponse.json(
        reportKnowledgeDbError(error, 'load knowledge document', {
          accountId,
          documentId: id,
        }),
        { status: httpStatusForDbError(error) },
      )
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(data)
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/ai/knowledge/[id]  (admin+) — update title/content and
 * re-index when the content changed.
 *
 * When the content changes the row also walks the lifecycle: it is
 * marked 'processing' while the new text is being chunked, then 'ready'
 * or 'error' with the reason. A database without migration 061 has no
 * status columns — the first update is retried without them (missing
 * column is a schema gap, not a failure), and every later status write
 * degrades silently through `markKnowledgeDocumentStatus`.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined
    const content = typeof body?.content === 'string' ? body.content.trim() : undefined
    if (title === undefined && content === undefined) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    if (title !== undefined && !title) {
      return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 })
    }
    if (content !== undefined && !content) {
      return NextResponse.json({ error: 'content cannot be empty' }, { status: 400 })
    }

    const update: Record<string, string> = {}
    if (title !== undefined) update.title = title
    if (content !== undefined) {
      update.content = content
      // 061 lifecycle: re-indexing is under way from this moment.
      update.status = 'processing'
      update.error_message = ''
    }

    let { data: updated, error } = await supabase
      .from('ai_knowledge_documents')
      .update(update)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error && isMissingColumnError(error) && 'status' in update) {
      // Migration 061 not applied yet: drop the lifecycle columns and
      // retry the substantive part of the update — an edit must not
      // fail because an optional column is absent.
      const rest = { ...update };
      delete rest.status;
      delete rest.error_message;
      ;({ data: updated, error } = await supabase
        .from('ai_knowledge_documents')
        .update(rest)
        .eq('account_id', accountId)
        .eq('id', id)
        .select('id')
        .maybeSingle())
    }
    if (error) {
      console.error('[ai/knowledge/[id] PATCH] error:', error)
      return NextResponse.json(
        reportKnowledgeDbError(error, 'update knowledge document', {
          accountId,
          userId,
          documentId: id,
          fields: Object.keys(update),
        }),
        { status: httpStatusForDbError(error) },
      )
    }
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (content !== undefined) {
      const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
        supabase,
        accountId,
      )
      try {
        await ingestDocument(supabase, accountId, { embeddingsApiKey }, id, content)
      } catch (err) {
        console.error('[ai/knowledge/[id] PATCH] ingest error:', err)
        const warning = ingestWarning('Updated', err)
        await markKnowledgeDocumentStatus(supabase, accountId, id, 'error', warning)
        return NextResponse.json(
          {
            success: true,
            warning,
          },
          { status: 200 },
        )
      }
      await markKnowledgeDocumentStatus(supabase, accountId, id, 'ready', null)
      if (corrupt) {
        return NextResponse.json({
          success: true,
          warning:
            'Updated with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
        })
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/knowledge/[id]  (admin+) — stored original first,
 * then the row; chunks cascade. Shares `deleteKnowledgeDocument` with
 * DELETE /api/ai/knowledge?id= so cleanup cannot drift between them.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const result = await deleteKnowledgeDocument(supabase, accountId, id)
    if (!result.ok) {
      const { body, status } = knowledgeDeleteFailureResponse(result, {
        accountId,
        documentId: id,
      })
      return NextResponse.json(body, { status })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
