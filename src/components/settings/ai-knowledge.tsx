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

/** Editor target: 'new' when creating, a doc id when editing, null when closed. */
type EditTarget = 'new' | string | null;

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
  // True when the list could not be loaded (as opposed to being empty).
  const [loadError, setLoadError] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);
  const t = useTranslations('Settings.aiKnowledge');

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/knowledge');
      const data = await res.json();
      if (res.ok) {
        setDocs(data.documents ?? []);
        setLoadError(false);
      } else {
        // Keep the failure distinct from "empty": a failed list must never
        // render as "No documents yet." or the user concludes their uploads
        // were deleted.
        setLoadError(true);
        toast.error(data.error ?? t('loadFailed'));
      }
    } catch {
      setLoadError(true);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setDocs((d) => d.filter((x) => x.id !== id));
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
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
                  // A list handed back by the upload response is authoritative:
                  // apply it directly instead of risking a second request that
                  // could fail and leave the panel reading "No documents yet.".
                  if (documents) {
                    setDocs(documents as DocSummary[]);
                    setLoadError(false);
                    return;
                  }
                  void fetchDocs();
                }}
              />
            )}

            {docs.length > 0 && (
              <ul className="divide-border border-border divide-y rounded-md border">
                {docs.map((doc) => {
                  const ext = documentExtension(doc);
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
                        {/* Proof of persistence: the date comes back from
                            Postgres, so a row that survived a tab switch or
                            a reload is visibly a stored row. Formatted with
                            the browser locale — no translation key needed. */}
                        {doc.created_at && (
                          <span className="text-muted-foreground block truncate text-xs">
                            {new Date(doc.created_at).toLocaleDateString()}
                          </span>
                        )}
                      </span>
                    </span>
                    {canEdit && (
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
                          onClick={() => void remove(doc.id)}
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </span>
                    )}
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
