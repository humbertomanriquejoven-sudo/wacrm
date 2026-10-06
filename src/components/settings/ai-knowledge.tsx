'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Plus,
  Trash2,
  Pencil,
  RefreshCw,
  BookOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import { KnowledgeUploader } from '@/components/settings/knowledge-uploader';

interface DocSummary {
  id: string;
  title: string;
  updated_at: string;
  /** When the document was first stored (migration 030, always present). */
  created_at?: string | null;
  /** Original upload name. Absent until migration 055 is applied. */
  filename?: string | null;
  /** Parser that produced the text ('xlsx', 'pdf', 'png', …). */
  source_type?: string | null;
  /** Lifecycle: uploading → processing → ready / error (migration 061). */
  status?: string | null;
  /** Original file size in bytes (migration 061). */
  file_size?: number | null;
  /** Why the document is in 'error' (migration 061). */
  error_message?: string | null;
}

/** Badge tone per file family, so a price sheet reads differently to a photo. */
function fileBadgeKind(
  ext: string
): 'sheet' | 'doc' | 'pdf' | 'image' | 'text' | 'other' {
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'sheet';
  if (['docx', 'doc'].includes(ext)) return 'doc';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'image';
  if (ext === 'txt') return 'text';
  return 'other';
}

const BADGE_CLASS: Record<ReturnType<typeof fileBadgeKind>, string> = {
  sheet: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  doc: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  pdf: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  image: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  text: 'bg-muted text-muted-foreground',
  other: 'bg-muted text-muted-foreground',
};

/**
 * The extension to badge, preferring the stored filename and falling back to
 * the recorded source_type. Documents created before 055 (or hand-typed in the
 * editor) have neither, in which case there is simply no badge — better than
 * showing a wrong one.
 */
function documentExtension(doc: DocSummary): string | null {
  const fromName = doc.filename?.match(/\.([A-Za-z0-9]+)$/)?.[1];
  const ext = (fromName ?? doc.source_type ?? '').toLowerCase();
  return ext || null;
}

/**
 * Status chips (migration 061). A row without `status` is a pre-061
 * document — there is no chip, which keeps the list exactly as it was
 * before the migration rather than inventing a state the server never
 * reported.
 */
const STATUS_LABEL_KEY: Record<string, string> = {
  uploading: 'statusUploading',
  processing: 'statusProcessing',
  ready: 'statusReady',
  error: 'statusError',
};

const STATUS_CHIP_CLASS: Record<string, string> = {
  uploading: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  processing: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  ready: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  error: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
};

/**
 * Human-readable original size — the second half of "this file really
 * exists in storage": the row shows the name AND how big the stored
 * original is. Falls back to nothing for hand-typed documents (no
 * original file) or a malformed value.
 */
function formatFileSize(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

/** Editor target: 'new' when creating, a doc id when editing, null when closed. */
type EditTarget = 'new' | string | null;

/**
 * Print a failed knowledge-base response to the browser console with the
 * database fields the API now returns (`db_code`, `db_message`, `db_details`,
 * `db_hint`, `advice`).
 *
 * The API stopped collapsing failures into "Failed to save document", so the
 * cause is now in the response body — but only if someone looks. Logging it
 * here means the browser's console carries the same SQLSTATE the server log
 * does, which is what turns "the file didn't save" into a diagnosis.
 *
 * Silently ignored: a body that is not JSON, or an older server response
 * without the db_* fields. Never throws — this runs inside error handlers.
 */
function logKnowledgeFailure(
  operation: string,
  body: unknown,
  fallbackMessage?: string
): void {
  const payload =
    body && typeof body === 'object'
      ? (body as {
          error?: string;
          db_code?: string;
          db_message?: string;
          db_details?: string;
          db_hint?: string;
          advice?: string;
        })
      : null;
  if (!payload) {
    console.error(`[knowledge] ${operation} failed`, body ?? fallbackMessage);
    return;
  }
  console.error(
    `[knowledge] ${operation} failed`,
    payload.db_code
      ? {
          sqlstate: payload.db_code,
          message: payload.db_message ?? payload.error,
          details: payload.db_details,
          hint: payload.db_hint,
          advice: payload.advice,
        }
      : payload.error ?? fallbackMessage
  );
}

export function AiKnowledgeCard({
  accountId,
  canEdit,
  hasEmbeddingsKey,
}: {
  accountId: string | null;
  canEdit: boolean;
  hasEmbeddingsKey: boolean;
}) {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  // Row awaiting delete confirmation — a delete here removes the stored
  // original AND the index, so it asks first instead of firing on the
  // first click (the old behaviour).
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null
  );
  // True when the list could not be loaded (as opposed to being empty).
  const [loadError, setLoadError] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);
  const t = useTranslations('Settings.aiKnowledge');

  /**
   * Reload the document list.
   *
   * `silent` is for the reconcile that follows an upload. The default mode
   * flips `loading`, which swaps the WHOLE card body for a spinner and
   * unmounts the uploader — correct for a tab change or a manual retry, but
   * wrong moments after a successful upload: it would blank a list the user
   * is looking at. Silent mode keeps the current rows on screen and never
   * raises the card-level spinner, so a background reconcile is invisible
   * unless it actually finds a difference.
   *
   * A silent failure is logged but NOT toasted and does NOT set `loadError`:
   * the visible list came from the upload response and is still trustworthy,
   * so a failed reconcile must not replace it with an error banner.
   */
  const fetchDocs = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      const silent = opts.silent === true;
      if (!silent) setLoading(true);
      try {
        const res = await fetch('/api/ai/knowledge');
        const data = await res.json();
        if (res.ok) {
          setDocs(data.documents ?? []);
          setLoadError(false);
        } else if (silent) {
          console.error(
            '[knowledge] background list reconcile failed:',
            data?.error
          );
        } else {
          // Keep the failure distinct from "empty": a failed list must never
          // render as "No documents yet." or the user concludes their uploads
          // were deleted.
          setLoadError(true);
          logKnowledgeFailure('list documents', data, t('loadFailed'));
          toast.error(data.error ?? t('loadFailed'));
        }
      } catch (err) {
        if (silent) {
          console.error('[knowledge] background list reconcile threw:', err);
          return;
        }
        setLoadError(true);
        console.error('[knowledge] list documents threw:', err);
        toast.error(t('loadFailed'));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    if (!accountId) {
      loadedAccountIdRef.current = null;
      setDocs([]);
      setLoadError(false);
      setLoading(false);
      return;
    }
    // Fetch whenever the account becomes known (mount, tab change, or after
    // the parent re-mounts). This ensures the list survives a container
    // restart or switching away/ back to the tab.
    loadedAccountIdRef.current = accountId;
    void fetchDocs();
  }, [accountId, fetchDocs]);

  const openNew = () => {
    setEditing('new');
    setTitle('');
    setContent('');
  };

  const openEdit = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`);
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('openFailed'));
        return;
      }
      setEditing(id);
      setTitle(data.title ?? '');
      setContent(data.content ?? '');
    } catch {
      toast.error(t('openFailed'));
    }
  };

  const cancelEdit = () => {
    setEditing(null);
    setTitle('');
    setContent('');
  };

  const save = async () => {
    if (!title.trim() || !content.trim()) {
      toast.error(t('titleContentRequired'));
      return;
    }
    setSaving(true);
    try {
      const isNew = editing === 'new';
      const res = await fetch(
        isNew ? '/api/ai/knowledge' : `/api/ai/knowledge/${editing}`,
        {
          method: isNew ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title.trim(),
            content: content.trim(),
          }),
        }
      );
      const data = await res.json();
      if (res.ok) {
        // A 200 with `warning` means saved but indexing degraded.
        if (data.warning) toast.warning(data.warning);
        else
          toast.success(isNew ? t('saveSuccessNew') : t('saveSuccessUpdate'));
        cancelEdit();
        await fetchDocs();
      } else {
        logKnowledgeFailure(
          isNew ? 'create document' : 'update document',
          data,
          t('saveFailed')
        );
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch (err) {
      console.error('[knowledge] save threw:', err);
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setConfirmingDeleteId(null);
    // Optimistic removal: the row disappears the instant the click lands, and
    // is restored if the server refuses. Deleting is reversible here (the
    // document and its vectors are still on the server until the call
    // returns), so making the user wait on a round trip to see a row
    // disappear reads as an unresponsive panel.
    const previous = docs;
    setDocs((d) => d.filter((x) => x.id !== id));
    try {
      const res = await fetch(
        `/api/ai/knowledge?id=${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );
      if (res.ok) {
        toast.success(t('removeSuccess'));
      } else {
        const data = await res.json();
        setDocs(previous);
        logKnowledgeFailure('delete document', data, t('removeFailed'));
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch (err) {
      setDocs(previous);
      console.error('[knowledge] delete threw:', err);
      toast.error(t('removeFailed'));
    }
  };

  const reindex = async () => {
    setReindexing(true);
    try {
      const res = await fetch('/api/ai/knowledge/reindex', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(t('reindexSuccess', { count: data.reindexed }));
      } else {
        toast.error(data.error ?? t('reindexFailed'));
      }
    } catch {
      toast.error(t('reindexFailed'));
    } finally {
      setReindexing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="text-primary h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>
          {t('description', {
            searchType: hasEmbeddingsKey
              ? t('semanticSearchOn')
              : t('keywordSearchOn'),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="text-muted-foreground flex items-center py-4 text-sm">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            {loadError ? (
          <div className="rounded-md border border-destructive/40 p-3">
            <p className="text-destructive text-sm">{t('loadFailed')}</p>
            <button
              type="button"
              onClick={() => void fetchDocs()}
              className="text-primary mt-2 text-sm underline"
            >
              {t('retry', { default: 'Reintentar' })}
            </button>
          </div>
        ) : docs.length === 0 && editing === null ? (
          <p className="text-muted-foreground text-sm">{t('noDocs')}</p>
        ) : null}

            {canEdit && editing === null && (
              <KnowledgeUploader
                onUploaded={(documents) => {
                  // Two steps, in this order on purpose.
                  //
                  // 1. Paint instantly from the upload response. The server
                  //    re-read the table before answering, so this list is
                  //    authoritative and needs no second round trip to be
                  //    correct. Doing this first is what makes the saved file
                  //    appear without a spinner and without a reload.
                  //
                  // 2. Then reconcile against the database in the background.
                  //    Silent: it cannot blank the list the user is looking
                  //    at, and a failure only logs. This is what would catch
                  //    a row the response could not describe (an unapplied
                  //    migration truncating the projection, say) — without
                  //    risking the "saved but the panel says no documents"
                  //    state that a hard refetch used to cause.
                  if (documents) {
                    setDocs(documents as DocSummary[]);
                    setLoadError(false);
                  }
                  void fetchDocs({ silent: true });
                }}
              />
            )}

            {docs.length > 0 && (
              <ul className="divide-border border-border divide-y rounded-md border">
                {docs.map((doc) => {
                  const ext = documentExtension(doc);
                  const fileSize = formatFileSize(doc.file_size);
                  return (
                  <li
                    key={doc.id}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {ext && (
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${BADGE_CLASS[fileBadgeKind(ext)]}`}
                        >
                          {ext}
                        </span>
                      )}
                      <span className="min-w-0">
                        {/* The real upload name is the most recognisable label;
                            hand-typed documents only have a title. */}
                        <span className="text-foreground block truncate text-sm">
                          {doc.filename || doc.title}
                        </span>
                        {doc.filename && doc.filename !== doc.title && (
                          <span className="text-muted-foreground block truncate text-xs">
                            {doc.title}
                          </span>
                        )}
                        <span className="flex flex-wrap items-center gap-x-2">
                          {/* Proof of persistence: the date comes back from
                              Postgres, so a row that survived a tab switch or
                              a reload is visibly a stored row. Formatted with
                              the browser locale — no translation key needed. */}
                          {doc.created_at && (
                            <span className="text-muted-foreground text-xs">
                              {new Date(doc.created_at).toLocaleDateString()}
                            </span>
                          )}
                          {/* The stored original's size — the second proof
                              that a real file exists in the bucket, not just
                              extracted text. */}
                          {fileSize && (
                            <span className="text-muted-foreground text-xs">
                              {fileSize}
                            </span>
                          )}
                          {doc.status && STATUS_LABEL_KEY[doc.status] && (
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CHIP_CLASS[doc.status] ?? STATUS_CHIP_CLASS.ready}`}
                              /* On failure the reason travels with the chip —
                                 the server stored it in error_message. */
                              title={
                                doc.status === 'error'
                                  ? (doc.error_message ?? undefined)
                                  : undefined
                              }
                            >
                              {t(STATUS_LABEL_KEY[doc.status])}
                            </span>
                          )}
                        </span>
                      </span>
                    </span>
                    {canEdit &&
                      (confirmingDeleteId === doc.id ? (
                        <span className="flex shrink-0 items-center gap-1">
                          <span className="text-muted-foreground text-xs">
                            {t('deleteConfirm')}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmingDeleteId(null)}
                          >
                            {t('cancel')}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => void remove(doc.id)}
                          >
                            {t('deleteYes')}
                          </Button>
                        </span>
                      ) : (
                        <span className="flex shrink-0 gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => void openEdit(doc.id)}
                            title="Edit"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive h-8 w-8 p-0"
                            onClick={() => setConfirmingDeleteId(doc.id)}
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </span>
                      ))}
                  </li>
                  );
                })}
              </ul>
            )}

            {editing !== null ? (
              <div className="border-border space-y-3 rounded-md border p-3">
                <div className="space-y-2">
                  <Label htmlFor="kb-title">{t('editDocTitle')}</Label>
                  <Input
                    id="kb-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t('editDocTitlePlaceholder')}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="kb-content">{t('editDocContent')}</Label>
                  <Textarea
                    id="kb-content"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={t('editDocContentPlaceholder')}
                    rows={8}
                    disabled={saving}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={cancelEdit}
                    disabled={saving}
                  >
                    {t('cancel')}
                  </Button>
                  <Button onClick={save} disabled={saving}>
                    {saving && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    {t('saveDoc')}
                  </Button>
                </div>
              </div>
            ) : (
              canEdit && (
                <div className="flex items-center justify-between">
                  <Button variant="outline" size="sm" onClick={openNew}>
                    <Plus className="mr-2 h-4 w-4" /> {t('addDoc')}
                  </Button>
                  {hasEmbeddingsKey && docs.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={reindex}
                      disabled={reindexing}
                      title={t('reindexTooltip')}
                    >
                      {reindexing ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                      )}
                      {t('reindex')}
                    </Button>
                  )}
                </div>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
