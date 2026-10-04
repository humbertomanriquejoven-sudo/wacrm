'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, FileText, Loader2, Upload } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';

const ACCEPTED_EXTENSIONS = [
  '.xlsx',
  '.xls',
  '.csv',
  '.pdf',
  '.docx',
  '.doc',
  '.txt',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
];
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * The `accept` attribute, derived from ACCEPTED_EXTENSIONS so the two can
 * never drift apart.
 *
 * This was a hard-coded literal that had fallen behind: it listed only the
 * document types, so the native file picker FILTERED OUT every image the
 * uploader otherwise accepted. Validation, the backend parser and the UI
 * badges all allowed .png/.jpg/.jpeg/.webp, but a user could not actually
 * pick one — the dialog simply hid them. Deriving it here makes adding an
 * extension in one place enough.
 */
const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(',');

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function truncateFilename(name: string): string {
  return name.length > 44 ? `${name.slice(0, 20)}…${name.slice(-20)}` : name;
}

/**
 * Drop zone (click or drag & drop) that uploads a knowledge document
 * immediately on selection. The backend extracts the file's text and
 * indexes it; the title field is optional (defaults to the file name).
 */
export function KnowledgeUploader({
  onUploaded,
}: {
  /**
   * Called after a successful upload so the parent can refresh its list.
   * Receives the already-reloaded document list when the API returned one,
   * which spares the client a second request (and the rate-limit slot).
   */
  onUploaded: (documents?: unknown[]) => void | Promise<void>;
}) {
  const t = useTranslations('Settings.aiKnowledge');
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Name of the file that was just persisted, kept on screen next to the
  // dropzone instead of only in a toast.
  //
  // The dropzone deliberately returns to its idle state after every upload
  // (it must be ready for the next file), so right after a successful save
  // it looks EXACTLY as it did before — which is what made "saved" read as
  // "nothing happened" whenever the toast was missed or had already
  // auto-dismissed. This line is the evidence, and it sits where the user's
  // eye already is.
  const [savedName, setSavedName] = useState<string | null>(null);

  const upload = useCallback(
    async (selected: File) => {
      setFile(selected);
      setUploading(true);
      // Clear the previous confirmation as soon as a new upload starts, so
      // it can never be mistaken for the result of the file in flight.
      setSavedName(null);
      try {
        const fd = new FormData();
        fd.append('file', selected);
        if (title.trim()) fd.append('title', title.trim());
        const res = await fetch('/api/ai/knowledge/upload', {
          method: 'POST',
          body: fd,
        });
        const data = await res.json();
        if (res.ok) {
          setTitle('');
          setFile(null);
          // Persistent proof of the save. The list below re-renders from the
          // same response, but it can sit off-screen; this cannot.
          setSavedName(title.trim() || selected.name);
          if (data.warning) toast.warning(data.warning);
          else toast.success(t('uploadSuccess'));
          // Prefer the list the upload response already carries; only fall
          // back to a refetch when the server could not produce one.
          await onUploaded(Array.isArray(data.documents) ? data.documents : undefined);
        } else {
          // A failed insert used to surface only as a generic toast, which
          // made "my file didn't save" undiagnosable. The API now returns
          // the SQLSTATE and the database message; print them so the browser
          // console carries the same detail as the server log.
          console.error('[knowledge] upload failed', {
            file: selected.name,
            bytes: selected.size,
            httpStatus: res.status,
            sqlstate: data?.db_code,
            message: data?.db_message ?? data?.error,
            details: data?.db_details,
            hint: data?.db_hint,
            advice: data?.advice,
          });
          toast.error(data.error ?? t('uploadFailed'));
        }
      } catch (err) {
        console.error('[knowledge] upload threw:', err);
        toast.error(t('uploadFailed'));
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [title, t, onUploaded]
  );

  const handleSelect = (selected: File | null) => {
    if (!selected || uploading) return;
    if (!ACCEPTED_EXTENSIONS.includes(extensionOf(selected.name))) {
      toast.error(t('uploadUnsupported'));
      return;
    }
    if (selected.size === 0) {
      toast.error(t('uploadEmpty'));
      return;
    }
    if (selected.size > MAX_FILE_BYTES) {
      toast.error(t('uploadTooLarge'));
      return;
    }
    void upload(selected);
  };

  return (
    <div className="border-border space-y-3 rounded-md border p-3">
      <div
        role="button"
        tabIndex={0}
        aria-label={t('uploadDropzone')}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!uploading) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!uploading) handleSelect(e.dataTransfer.files?.[0] ?? null);
        }}
        className={cn(
          'group flex cursor-pointer items-center justify-center gap-3 rounded-lg border border-dashed p-4 transition-colors',
          dragging
            ? 'border-primary bg-primary/5'
            : 'border-border/80 hover:border-primary/40 hover:bg-background/70'
        )}
      >
        {uploading ? (
          <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
        ) : file ? (
          <FileText className="text-primary size-4 shrink-0" />
        ) : (
          <Upload className="text-muted-foreground group-hover:text-foreground size-4 shrink-0" />
        )}
        <div className="min-w-0 text-left">
          {uploading ? (
            <p className="text-muted-foreground text-sm">{t('uploading')}</p>
          ) : file ? (
            <p className="text-foreground max-w-full truncate text-sm font-medium">
              {truncateFilename(file.name)}
            </p>
          ) : (
            <>
              <p className="text-foreground text-sm">{t('uploadDropzone')}</p>
              <p className="text-muted-foreground text-[11px]">
                {t('uploadHint')}
              </p>
            </>
          )}
        </div>
      </div>

      {savedName && !uploading && (
        <p
          data-testid="knowledge-saved-confirmation"
          className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400"
        >
          <CheckCircle2 className="size-4 shrink-0" />
          <span className="min-w-0 truncate">
            {t('savedAs')} {savedName}
          </span>
        </p>
      )}

      <div className="space-y-1">
        <Label
          htmlFor="kb-upload-title"
          className="text-muted-foreground text-xs"
        >
          {t('uploadTitle')}
        </Label>
        <Input
          id="kb-upload-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('uploadTitlePlaceholder')}
          disabled={uploading}
        />
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        onChange={(e) => handleSelect(e.target.files?.[0] ?? null)}
        className="hidden"
        disabled={uploading}
      />
    </div>
  );
}
