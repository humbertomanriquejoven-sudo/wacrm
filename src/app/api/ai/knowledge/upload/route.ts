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

// 16 MB — the repo-wide upload ceiling. Large enough for catalogs and
// policies, small enough to keep the documents table sane.
const MAX_FILE_BYTES = 16 * 1024 * 1024;
// Hard cap on extracted text per file (~1M chars ≈ ~250k tokens) so a
// huge spreadsheet or PDF can't balloon chunking and embedding.
const MAX_TEXT_CHARS = 1_000_000;

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
            'Unsupported file type. Use .xlsx, .xls, .csv, .pdf, .docx, .doc or .txt',
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

    const { data: doc, error } = await supabase
      .from('ai_knowledge_documents')
      .insert({ account_id: accountId, created_by: userId, title, content })
      .select('id')
      .single();
    if (error || !doc) {
      console.error('[ai/knowledge/upload] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to save document' },
        { status: 500 }
      );
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
        },
        { status: 200 }
      );
    }

    const base = {
      success: true,
      id: doc.id,
      title,
      chars: content.length,
    };
    if (truncated) {
      return NextResponse.json({
        ...base,
        warning: `File was larger than ${MAX_TEXT_CHARS} characters; only the first part was indexed.`,
      });
    }
    if (corrupt) {
      return NextResponse.json({
        ...base,
        warning:
          'Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
      });
    }
    return NextResponse.json(base);
  } catch (err) {
    return toErrorResponse(err);
  }
}
