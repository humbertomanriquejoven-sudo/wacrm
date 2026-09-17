'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FileText, Loader2, Upload } from 'lucide-react';
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
];
const MAX_FILE_BYTES = 16 * 1024 * 1024;

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
  /** Called after a successful upload so the parent can refresh its list. */
  onUploaded: () => void | Promise<void>;
}) {
  const t = useTranslations('Settings.aiKnowledge');
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);

  const upload = useCallback(
    async (selected: File) => {
      setFile(selected);
      setUploading(true);
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
          if (data.warning) toast.warning(data.warning);
          else toast.success(t('uploadSuccess'));
          await onUploaded();
        } else {
          toast.error(data.error ?? t('uploadFailed'));
        }
      } catch {
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
        accept=".xlsx,.xls,.csv,.pdf,.docx,.doc,.txt"
        onChange={(e) => handleSelect(e.target.files?.[0] ?? null)}
        className="hidden"
        disabled={uploading}
      />
    </div>
  );
}
