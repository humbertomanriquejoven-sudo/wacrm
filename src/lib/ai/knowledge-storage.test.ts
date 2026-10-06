import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KNOWLEDGE_BUCKET,
  knowledgeObjectPath,
  removeKnowledgeFile,
  sanitizeFilename,
  uploadKnowledgeFile,
} from './knowledge-storage';

/** Minimal storage surface the helpers actually touch. */
function makeStorage(opts: {
  upload?: { error: { message: string } | null };
  remove?: { error: { message: string } | null };
}) {
  const calls = {
    upload: [] as {
      bucket: string;
      path: string;
      file: File;
      options: Record<string, unknown>;
    }[],
    remove: [] as { bucket: string; paths: string[] }[],
  };
  const storage = {
    from: (bucket: string) => ({
      upload: (
        path: string,
        file: File,
        options: Record<string, unknown>
      ) => {
        calls.upload.push({ bucket, path, file, options });
        return Promise.resolve({ error: opts.upload?.error ?? null });
      },
      remove: (paths: string[]) => {
        calls.remove.push({ bucket, paths });
        return Promise.resolve({ error: opts.remove?.error ?? null });
      },
    }),
  };
  return { supabase: { storage } as never, calls };
}

function sampleFile(name = 'lista.xlsx'): File {
  return new File([new Uint8Array([1, 2, 3])], name, {
    type: 'application/vnd.ms-excel',
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('sanitizeFilename', () => {
  it('keeps an ordinary name intact', () => {
    expect(sanitizeFilename('lista-de-precios.xlsx')).toBe(
      'lista-de-precios.xlsx'
    );
  });

  it('strips directory components a crafted multipart part could carry', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\x\\evil.exe')).toBe('evil.exe');
    expect(sanitizeFilename('a/b/c.pdf')).toBe('c.pdf');
  });

  it('never returns an empty segment (that would upload to the folder root)', () => {
    // An empty path segment would store at `{account}/{doc}/` and be
    // undeletable by the path we persist.
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('...')).toBe('file');
    expect(sanitizeFilename('.env')).toBe('env');
  });

  it('removes control characters and caps the length', () => {
    expect(sanitizeFilename('re\u0000port\u001f.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('x'.repeat(300))).toHaveLength(120);
  });
});

describe('knowledgeObjectPath', () => {
  it('lays the object out as {account}/{document}/{filename}', () => {
    // The first segment is the tenancy key, exactly what the storage
    // RLS policies from migration 061 match against.
    expect(
      knowledgeObjectPath('acc-1', 'doc-1', 'lista.xlsx')
    ).toBe('acc-1/doc-1/lista.xlsx');
  });

  it('sanitises the filename segment', () => {
    expect(
      knowledgeObjectPath('acc-1', 'doc-1', '../lista.xlsx')
    ).toBe('acc-1/doc-1/lista.xlsx');
  });
});

describe('uploadKnowledgeFile', () => {
  it('uploads to the knowledge-base bucket and returns the path', async () => {
    const { supabase, calls } = makeStorage({ upload: { error: null } });
    const file = sampleFile();

    const path = await uploadKnowledgeFile(supabase, {
      accountId: 'acc-1',
      documentId: 'doc-1',
      file,
    });

    expect(path).toBe('acc-1/doc-1/lista.xlsx');
    expect(calls.upload).toHaveLength(1);
    expect(calls.upload[0]).toMatchObject({
      bucket: KNOWLEDGE_BUCKET,
      path: 'acc-1/doc-1/lista.xlsx',
      file,
      // upsert:false: a duplicate object path means something is already
      // wrong, and silently overwriting would hide it.
      options: expect.objectContaining({
        upsert: false,
        contentType: 'application/vnd.ms-excel',
      }),
    });
  });

  it('throws with the storage driver message so the route can undo the row', async () => {
    const { supabase } = makeStorage({
      upload: { error: { message: 'Bucket write denied' } },
    });
    await expect(
      uploadKnowledgeFile(supabase, {
        accountId: 'acc-1',
        documentId: 'doc-1',
        file: sampleFile(),
      })
    ).rejects.toThrow(/Bucket write denied/);
  });
});

describe('removeKnowledgeFile', () => {
  it('removes the object from the knowledge-base bucket', async () => {
    const { supabase, calls } = makeStorage({ remove: { error: null } });
    await removeKnowledgeFile(supabase, 'acc-1/doc-1/lista.xlsx');
    expect(calls.remove[0]).toMatchObject({
      bucket: KNOWLEDGE_BUCKET,
      paths: ['acc-1/doc-1/lista.xlsx'],
    });
  });

  it('treats "already gone" as success — the end state is what matters', async () => {
    // Storage versions word this differently; a delete that races an
    // earlier cleanup must not fail the request.
    for (const message of [
      'Object not found',
      'The resource was not found',
      'row not found',
      'no such object',
    ]) {
      const { supabase } = makeStorage({ remove: { error: { message } } });
      await expect(
        removeKnowledgeFile(supabase, 'acc-1/doc-1/x.pdf')
      ).resolves.toBeUndefined();
    }
  });

  it('throws on a real failure so the caller keeps the row', async () => {
    const { supabase } = makeStorage({
      remove: { error: { message: 'permission denied for bucket' } },
    });
    await expect(
      removeKnowledgeFile(supabase, 'acc-1/doc-1/x.pdf')
    ).rejects.toThrow(/permission denied for bucket/);
  });
});
