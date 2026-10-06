import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Original-file storage for the knowledge base (migration 061).
 *
 * The document's extracted TEXT lives in `ai_knowledge_documents.content`
 * and is what retrieval searches; the ORIGINAL file lives in the private
 * `knowledge-base` Storage bucket so it can be re-downloaded, re-parsed
 * with a better parser later, or audited. Losing the original while
 * keeping only a one-time extraction is a silent, irreversible failure —
 * this module is what makes the artifact durable.
 *
 * Every function takes the caller's (RLS) Supabase client — the routes
 * run server-side as an authenticated admin, and the storage policies
 * from migration 061 scope access to `{account_id}/…` folders. The
 * service-role key is never involved, and never reaches the browser.
 *
 * Object layout: `{account_id}/{document_id}/{filename}`.
 * This CRM's tenancy key is `accounts.id` (there is no `workspace_id`
 * and no `agents` table — the assistant is account-level), which is why
 * the first path segment is the account, matching the avatars bucket
 * convention from migration 008.
 */

/** Bucket created by `supabase/migrations/061_knowledge_document_storage.sql`. */
export const KNOWLEDGE_BUCKET = 'knowledge-base';

/**
 * Turn an arbitrary uploaded name into a safe single path segment.
 *
 * Strip directory components (browsers normally send just the name, but
 * a crafted multipart part can contain `/` or `\`), control characters
 * and leading dots (so `.env` cannot hide at the start of a segment),
 * then cap the length. Never returns an empty string — an empty segment
 * would silently upload to the folder root and be undeletable by path.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || 'file').slice(0, 120);
}

/** Full object path for a document's original file. */
export function knowledgeObjectPath(
  accountId: string,
  documentId: string,
  filename: string
): string {
  return `${accountId}/${documentId}/${sanitizeFilename(filename)}`;
}

/**
 * Upload the original file. Returns the stored object path (which the
 * caller persists as `ai_knowledge_documents.storage_path`).
 *
 * Throws with the storage driver's own message on failure — the upload
 * route reacts by undoing the document row, so a storage outage during
 * an upload never leaves a row pointing at a file that does not exist.
 *
 * `upsert: false` on purpose: document ids are unique, so an object
 * already being there means something is wrong, and silently
 * overwriting would hide it.
 */
export async function uploadKnowledgeFile(
  supabase: SupabaseClient,
  params: { accountId: string; documentId: string; file: File }
): Promise<string> {
  const { accountId, documentId, file } = params;
  const path = knowledgeObjectPath(accountId, documentId, file.name);
  const { error } = await supabase.storage.from(KNOWLEDGE_BUCKET).upload(path, file, {
    contentType: file.type || undefined,
    cacheControl: '3600',
    upsert: false,
  });
  if (error) {
    throw new Error(
      `Could not store the original file in storage: ${error.message}`
    );
  }
  return path;
}

/**
 * Match the error shapes Supabase Storage returns for "there is nothing
 * to delete": they vary by version (HTTP wording, PostgREST "not found",
 * an empty-result row), and treating any of them as fatal would strand a
 * document the user is actively trying to remove.
 */
const ALREADY_GONE = /not[\s-]?found|does not exist|no rows|no such object/i;

/**
 * Remove a stored original. Resolves even when the object is already
 * gone (the desired end state), throws on any other failure so the
 * caller can abort the database delete — a file whose removal failed
 * must never become an orphan the moment its row is deleted.
 */
export async function removeKnowledgeFile(
  supabase: SupabaseClient,
  path: string
): Promise<void> {
  const { error } = await supabase.storage.from(KNOWLEDGE_BUCKET).remove([path]);
  if (error && !ALREADY_GONE.test(error.message)) {
    throw new Error(
      `Could not remove the stored file from storage: ${error.message}`
    );
  }
}
