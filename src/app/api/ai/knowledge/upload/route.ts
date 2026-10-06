import { NextResponse } from 'next/server';
import {
  ForbiddenError,
  requireRole,
  UnauthorizedError,
} from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadEmbeddingsKey } from '@/lib/ai/config';
import { ingestDocument, ingestWarning } from '@/lib/ai/knowledge';
import {
  knowledgeFileExtension,
  parseKnowledgeFile,
} from '@/lib/ai/knowledge-parser';
import { isMissingColumnError } from '@/lib/ai/knowledge-schema';
import {
  httpStatusForDbError,
  reportKnowledgeDbError,
  reportKnowledgeFatalError,
} from '@/lib/ai/knowledge-errors';
import {
  markKnowledgeDocumentStatus,
  selectKnowledgeDocumentSummaries,
} from '@/lib/ai/knowledge-documents';
import {
  knowledgeObjectPath,
  removeKnowledgeFile,
  uploadKnowledgeFile,
} from '@/lib/ai/knowledge-storage';

// 16 MB — the repo-wide upload ceiling. Large enough for catalogs and
// policies, small enough to keep the documents table sane. The
// `knowledge-base` bucket's file_size_limit (migration 061) matches it.
const MAX_FILE_BYTES = 16 * 1024 * 1024;
// Hard cap on extracted text per file (~1M chars ≈ ~250k tokens) so a
// huge spreadsheet or PDF can't balloon chunking and embedding.
const MAX_TEXT_CHARS = 1_000_000;

/**
 * The account's document summaries, in the exact shape GET
 * /api/ai/knowledge returns, so a caller can reconcile its list from an
 * upload response.
 *
 * Best-effort by design: if this read fails the upload has STILL
 * succeeded, so it degrades to an empty array rather than turning a good
 * upload into a 500. An empty list makes the client refetch, which is
 * strictly better than failing the save.
 */
async function listDocuments(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string
) {
  try {
    const { data, error } = await selectKnowledgeDocumentSummaries(
      supabase,
      accountId
    );
    if (error) {
      console.error('[ai/knowledge/upload] could not reload list:', error);
      return [];
    }
    return data ?? [];
  } catch (err) {
    // Belt and braces: this list is a convenience for the UI. It must
    // never be able to turn a successful upload into a failed request.
    console.error('[ai/knowledge/upload] list reload threw:', err);
    return [];
  }
}

/**
 * Best-effort undo used when the upload cannot be completed: drop the
 * row (chunks cascade — there are none yet) and, if it was already
 * written, the stored original. Swallows its own failures: it runs
 * inside error paths whose response is already decided, and a cleanup
 * hiccup must never mask the original cause. The server log keeps both.
 */
async function undoPartialUpload(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string,
  documentId: string,
  storagePath: string | null
) {
  try {
    if (storagePath) await removeKnowledgeFile(supabase, storagePath);
  } catch (err) {
    console.error('[ai/knowledge/upload] cleanup: storage remove failed:', err);
  }
  try {
    await supabase
      .from('ai_knowledge_documents')
      .delete()
      .eq('account_id', accountId)
      .eq('id', documentId);
  } catch (err) {
    console.error('[ai/knowledge/upload] cleanup: row delete failed:', err);
  }
}

/**
 * POST /api/ai/knowledge/upload  (admin+)
 *
 * Accept a multipart upload (.xlsx .xls .csv .pdf .docx .doc .txt and
 * images), extract the document's text, save it as a knowledge document,
 * store the ORIGINAL file in the `knowledge-base` bucket (migration
 * 061), then chunk + (optionally) embed it — same indexing pipeline as
 * POST /api/ai/knowledge. Title defaults to the file name.
 *
 * The row walks a real lifecycle when migration 061 is applied:
 * 'uploading' (row inserted) → 'processing' (original stored, indexing
 * under way) → 'ready' / 'error'. Without 061 the code degrades to the
 * pre-061 behaviour (text + indexing only, no stored original, no
 * status) instead of failing — the fallback tiers exist so a database
 * that has not caught up still accepts uploads.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const formData = await request.formData().catch(() => null);
    const file = formData?.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: 'file is empty' }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        {
          error: `File exceeds the ${MAX_FILE_BYTES / (1024 * 1024)} MB limit`,
        },
        { status: 400 }
      );
    }

    const extension = knowledgeFileExtension(file.name);
    if (!extension) {
      return NextResponse.json(
        {
          error:
            'Unsupported file type. Use .xlsx, .xls, .csv, .pdf, .docx, .doc, .txt, .png, .jpg, .jpeg or .webp',
        },
        { status: 400 }
      );
    }

    const rawTitle = formData?.get('title');
    let title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    if (!title) {
      title = file.name.replace(/\.[^.]+$/, '').trim() || file.name;
    }

    // Parse BEFORE touching the database: a file whose text cannot be
    // extracted never becomes a row, so there is nothing to clean up and
    // no half-saved document lingering in the list. The 422 carries the
    // parser's own message, which is actionable (fix the file, retry).
    let content: string;
    try {
      content = (await parseKnowledgeFile(file)).text.trim();
    } catch (err) {
      console.error('[ai/knowledge/upload] parse error:', err);
      return NextResponse.json(
        {
          error:
            err instanceof Error ? err.message : 'Could not parse the file',
        },
        { status: 422 }
      );
    }
    if (!content) {
      return NextResponse.json(
        { error: 'No readable text could be extracted from this file' },
        { status: 422 }
      );
    }

    const truncated = content.length > MAX_TEXT_CHARS;
    if (truncated) content = content.slice(0, MAX_TEXT_CHARS);

    // ---------------------------------------------------------------
    // Insert, richest shape first: 061 columns → 055 columns → 030
    // columns. PostgREST rejects a projection (and an insert payload's
    // unknown keys) the moment one column is unknown, so each rung is
    // only reached because the richer one reported exactly that — any
    // other failure is real and reported immediately.
    //
    // `schemaTier` records which rung landed: tier 1 means the database
    // has 061, so the stored original and the status lifecycle below
    // are safe to write; tiers 2/3 skip both rather than reference
    // columns that do not exist.
    // ---------------------------------------------------------------
    const baseRow = {
      account_id: accountId,
      created_by: userId,
      title,
      content,
      // The real upload name and the parser used, so a weak extraction
      // (e.g. an unreadable image) can be identified and re-uploaded.
      filename: file.name,
      source_type: extension,
    };
    const insertTiers: { schemaTier: 1 | 2 | 3; row: Record<string, unknown>; operation: string }[] = [
      {
        schemaTier: 1,
        row: {
          ...baseRow,
          file_size: file.size,
          mime_type: file.type || null,
          status: 'uploading',
        },
        operation: 'insert knowledge document',
      },
      { schemaTier: 2, row: baseRow, operation: 'insert knowledge document (061 columns missing)' },
      {
        schemaTier: 3,
        row: {
          account_id: accountId,
          created_by: userId,
          title,
          content,
        },
        operation: 'insert knowledge document (legacy shape, 055 not applied)',
      },
    ];

    let doc: { id: string } | null = null;
    let schemaTier: 1 | 2 | 3 = 1;
    let lastInsertError: unknown = null;
    for (const tier of insertTiers) {
      const attempt = await supabase
        .from('ai_knowledge_documents')
        .insert(tier.row)
        .select('id')
        .single();
      if (!attempt.error && attempt.data) {
        doc = attempt.data;
        schemaTier = tier.schemaTier;
        break;
      }
      if (!isMissingColumnError(attempt.error)) {
        console.error('[ai/knowledge/upload] insert error:', attempt.error);
        return NextResponse.json(
          reportKnowledgeDbError(attempt.error, tier.operation, {
            accountId,
            userId,
            title,
            contentChars: content.length,
            filename: file.name,
            sourceType: extension,
          }),
          { status: httpStatusForDbError(attempt.error) }
        );
      }
      console.warn(
        `[ai/knowledge/upload] ${tier.operation}: column missing, degrading to the next shape.`
      );
      lastInsertError = attempt.error;
    }
    if (!doc) {
      // Every tier reported a missing column — the table itself is
      // broken (a column the OLDEST projection needs). Report it.
      console.error('[ai/knowledge/upload] insert error:', lastInsertError);
      return NextResponse.json(
        reportKnowledgeDbError(
          lastInsertError,
          'insert knowledge document (all projection tiers failed)',
          {
            accountId,
            userId,
            title,
            contentChars: content.length,
            filename: file.name,
            sourceType: extension,
          }
        ),
        { status: httpStatusForDbError(lastInsertError) }
      );
    }

    // ---------------------------------------------------------------
    // Store the ORIGINAL file — only when 061 landed. Uploading without
    // a storage_path column would create an object nothing can ever
    // delete (an orphan), so tiers 2/3 skip it and say so in the
    // response warning instead.
    //
    // Both failure paths below UNDO the row: a row without its file is
    // exactly the "records referencing nothing" state this module must
    // never produce. No stored original + no row + a clear error is the
    // honest outcome of a storage outage.
    // ---------------------------------------------------------------
    if (schemaTier === 1) {
      let storagePath: string;
      try {
        storagePath = await uploadKnowledgeFile(supabase, {
          accountId,
          documentId: doc.id,
          file,
        });
      } catch (err) {
        console.error('[ai/knowledge/upload] storage upload error:', err);
        // The upload may have died halfway — try the path anyway;
        // removeKnowledgeFile treats "already gone" as success.
        await undoPartialUpload(
          supabase,
          accountId,
          doc.id,
          knowledgeObjectPath(accountId, doc.id, file.name)
        );
        return NextResponse.json(
          reportKnowledgeFatalError(err, 'store original knowledge file', {
            accountId,
            userId,
            documentId: doc.id,
            filename: file.name,
          }),
          { status: 500 }
        );
      }

      const { error: pathError } = await supabase
        .from('ai_knowledge_documents')
        .update({ storage_path: storagePath, status: 'processing' })
        .eq('account_id', accountId)
        .eq('id', doc.id);
      if (pathError) {
        // The object exists but the row does not know it — undo both,
        // or the file would outlive every reference to it.
        console.error(
          '[ai/knowledge/upload] storage_path write failed:',
          pathError
        );
        await undoPartialUpload(supabase, accountId, doc.id, storagePath);
        return NextResponse.json(
          reportKnowledgeDbError(pathError, 'record knowledge document storage path', {
            accountId,
            userId,
            documentId: doc.id,
            storagePath,
          }),
          { status: httpStatusForDbError(pathError) }
        );
      }
    }

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      supabase,
      accountId
    );
    try {
      await ingestDocument(
        supabase,
        accountId,
        { embeddingsApiKey },
        doc.id,
        content
      );
    } catch (err) {
      console.error('[ai/knowledge/upload] ingest error:', err);
      // The document is saved but (per ingestWarning) may not be
      // searchable — record WHY on the row, so the list can show
      // "Error" with the real cause instead of a healthy blank.
      // Best-effort: a failed status write must not mask the warning
      // the operator needs to see in this very response.
      const warning = ingestWarning('Saved', err);
      await markKnowledgeDocumentStatus(
        supabase,
        accountId,
        doc.id,
        'error',
        warning
      );
      return NextResponse.json(
        {
          success: true,
          id: doc.id,
          warning,
          documents: await listDocuments(supabase, accountId),
        },
        { status: 200 }
      );
    }
    await markKnowledgeDocumentStatus(supabase, accountId, doc.id, 'ready', null);

    const degradedTier2 = schemaTier === 2;
    const degradedTier3 = schemaTier === 3;

    const base = {
      success: true,
      id: doc.id,
      title,
      chars: content.length,
      // True when migration 055 is missing on this database and the
      // document was stored without its filename/type. Surfaced so the
      // UI can say so instead of silently losing that data.
      degradedSchema: degradedTier3,
      // The refreshed list, so the client can reconcile its state from
      // this response instead of issuing a follow-up GET. That follow-up
      // is the step that used to fail (rate limit / remount) and leave
      // the panel reading "No documents yet." right after a successful
      // upload.
      documents: await listDocuments(supabase, accountId),
    };
    if (truncated) {
      return NextResponse.json({
        ...base,
        warning: `File was larger than ${MAX_TEXT_CHARS} characters; only the first part was indexed.${
          degradedTier3 ? ' (Database migration 055 pending: filename/type not recorded.)' : ''
        }`,
      });
    }
    if (corrupt) {
      return NextResponse.json({
        ...base,
        warning: `Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).${
          degradedTier3 ? ' (Database migration 055 pending: filename/type not recorded.)' : ''
        }`,
      });
    }
    if (degradedTier3) {
      return NextResponse.json({
        ...base,
        warning:
          'Saved, but database migration 055 is not applied yet: the original filename and file type were not recorded. Apply supabase/migrations/055_knowledge_document_filename.sql to enable them.',
      });
    }
    if (degradedTier2) {
      return NextResponse.json({
        ...base,
        warning:
          'Saved, but database migration 061 is not applied yet: the original file was not stored and the document has no processing status. Apply supabase/migrations/061_knowledge_document_storage.sql to enable them.',
      });
    }
    return NextResponse.json(base);
  } catch (err) {
    // Auth failures keep their real status — a non-admin must see 401/403,
    // not a 500 that reads like a server fault.
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // Everything else previously collapsed into `toErrorResponse`, which
    // answers a bare 500 `{ error: "Internal server error" }`. A systemic
    // fault here fails EVERY upload the same way and named nothing, so
    // there was no way to tell a missing env var from a broken auth
    // client. Admin-gated, so the message is safe to return.
    return NextResponse.json(
      reportKnowledgeFatalError(err, 'POST /api/ai/knowledge/upload'),
      { status: 500 }
    );
  }
}
