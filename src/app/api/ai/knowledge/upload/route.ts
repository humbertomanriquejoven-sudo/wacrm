import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadEmbeddingsKey } from '@/lib/ai/config';
import { ingestDocument } from '@/lib/ai/knowledge';
import { AiError } from '@/lib/ai/types';
import {
  knowledgeFileExtension,
  parseKnowledgeFile,
} from '@/lib/ai/knowledge-parser';
import { isMissingColumnError } from '@/lib/ai/knowledge-schema';

// 16 MB — the repo-wide upload ceiling. Large enough for catalogs and
// policies, small enough to keep the documents table sane.
const MAX_FILE_BYTES = 16 * 1024 * 1024;
// Hard cap on extracted text per file (~1M chars ≈ ~250k tokens) so a
// huge spreadsheet or PDF can't balloon chunking and embedding.
const MAX_TEXT_CHARS = 1_000_000;

/**
 * The account's document summaries, in the exact shape GET /api/ai/knowledge
 * returns, so a caller can reconcile its list from an upload response.
 *
 * Best-effort by design: if this read fails the upload has STILL succeeded,
 * so it degrades to an empty array rather than turning a good upload into a
 * 500. An empty list makes the client refetch, which is the old behaviour —
 * strictly better than failing the save.
 */
async function listDocuments(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string
) {
  try {
    const rich = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, filename, source_type, created_at, updated_at')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false });
    if (!rich.error) return rich.data ?? [];
    // Same tolerance as the GET route: an unapplied 055 must not break this.
    if (!isMissingColumnError(rich.error)) {
      console.error('[ai/knowledge/upload] could not reload list:', rich.error);
      return [];
    }
    const basic = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, created_at, updated_at')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false });
    return basic.data ?? [];
  } catch (err) {
    // Belt and braces: this list is a convenience for the UI. It must never
    // be able to turn a successful upload into a failed request.
    console.error('[ai/knowledge/upload] list reload threw:', err);
    return [];
  }
}

/**
 * POST /api/ai/knowledge/upload  (admin+)
 *
 * Accept a multipart upload (.xlsx .xls .csv .pdf .docx .doc .txt),
 * extract the document's text, save it as a knowledge document, then
 * chunk + (optionally) embed it — same indexing pipeline as POST
 * /api/ai/knowledge. Title defaults to the file name.
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

    const insertRow = {
      account_id: accountId,
      created_by: userId,
      title,
      content,
      // The real upload name and the parser used, so a weak extraction
      // (e.g. an unreadable image) can be identified and re-uploaded.
      filename: file.name,
      source_type: extension,
    };

    let doc: { id: string } | null = null;
    let degradedSchema = false;
    {
      const attempt = await supabase
        .from('ai_knowledge_documents')
        .insert(insertRow)
        .select('id')
        .single();
      if (!attempt.error && attempt.data) {
        doc = attempt.data;
      } else if (isMissingColumnError(attempt.error)) {
        // Migration 055 is not applied on this database yet. Store the
        // document with the legacy shape instead of failing the request —
        // losing an upload because a cosmetic column is missing would be a
        // far worse outcome than not recording the filename.
        console.warn(
          '[ai/knowledge/upload] 055 not applied; saving without filename/source_type.'
        );
        degradedSchema = true;
        const fallback = await supabase
          .from('ai_knowledge_documents')
          .insert({
            account_id: accountId,
            created_by: userId,
            title,
            content,
          })
          .select('id')
          .single();
        if (fallback.error || !fallback.data) {
          console.error(
            '[ai/knowledge/upload] insert error:',
            fallback.error ?? attempt.error
          );
          return NextResponse.json(
            { error: 'Failed to save document' },
            { status: 500 }
          );
        }
        doc = fallback.data;
      } else {
        console.error('[ai/knowledge/upload] insert error:', attempt.error);
        return NextResponse.json(
          { error: 'Failed to save document' },
          { status: 500 }
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
      const message = err instanceof AiError ? err.message : 'indexing failed';
      console.error('[ai/knowledge/upload] ingest error:', err);
      return NextResponse.json(
        {
          success: true,
          id: doc.id,
          warning: `Saved, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
          documents: await listDocuments(supabase, accountId),
        },
        { status: 200 }
      );
    }

    const base = {
      success: true,
      id: doc.id,
      title,
      chars: content.length,
      // True when migration 055 is missing on this database and the document
      // was stored without its filename/type. Surfaced so the UI can say so
      // instead of silently losing that data.
      degradedSchema,
      // The refreshed list, so the client can reconcile its state from this
      // response instead of issuing a follow-up GET. That follow-up is the
      // step that used to fail (rate limit / remount) and leave the panel
      // reading "No documents yet." right after a successful upload.
      documents: await listDocuments(supabase, accountId),
    };
    if (truncated) {
      return NextResponse.json({
        ...base,
        warning: `File was larger than ${MAX_TEXT_CHARS} characters; only the first part was indexed.${
          degradedSchema ? ' (Database migration 055 pending: filename/type not recorded.)' : ''
        }`,
      });
    }
    if (corrupt) {
      return NextResponse.json({
        ...base,
        warning: `Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).${
          degradedSchema ? ' (Database migration 055 pending: filename/type not recorded.)' : ''
        }`,
      });
    }
    if (degradedSchema) {
      return NextResponse.json({
        ...base,
        warning:
          'Saved, but database migration 055 is not applied yet: the original filename and file type were not recorded. Apply supabase/migrations/055_knowledge_document_filename.sql to enable them.',
      });
    }
    return NextResponse.json(base);
  } catch (err) {
    return toErrorResponse(err);
  }
}
