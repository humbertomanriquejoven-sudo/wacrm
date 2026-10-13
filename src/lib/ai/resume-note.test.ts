import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildResumeNote, recordResumeNote } from './resume-note';

describe('buildResumeNote', () => {
  it('summarizes the human messages', () => {
    const note = buildResumeNote(['Hola, te atiendo yo', 'Te comparto el PDF']);
    expect(note).toContain('IA reanudada');
    expect(note).toContain('2 mensajes');
    expect(note).toContain('“Hola, te atiendo yo”');
    expect(note).toContain('“Te comparto el PDF”');
  });

  it('uses the singular label for one message', () => {
    expect(buildResumeNote(['solo uno'])).toContain('1 mensaje');
  });

  it('handles no human messages', () => {
    expect(buildResumeNote([])).toContain('no se registraron mensajes humanos');
    expect(buildResumeNote(['   '])).toContain(
      'no se registraron mensajes humanos'
    );
  });

  it('truncates very long messages', () => {
    const long = 'x'.repeat(300);
    const note = buildResumeNote([long]);
    expect(note).toContain('…');
    expect(note.length).toBeLessThan(300);
  });
});

function makeDb(messages: { content_text: string }[]) {
  const noteInserts: Record<string, unknown>[] = [];
  const db = {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => () => builder;
      for (const m of ['select', 'eq', 'order', 'limit', 'not']) {
        builder[m] = chain();
      }
      builder.insert = (arg: unknown) => {
        if (table === 'contact_notes') {
          noteInserts.push(arg as Record<string, unknown>);
        }
        return builder;
      };
      builder.then = (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve({
          data: table === 'messages' ? messages : [],
          error: null,
        }).then(onFulfilled);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, noteInserts };
}

describe('recordResumeNote', () => {
  it('reads human messages and stores the resume note', async () => {
    const { db, noteInserts } = makeDb([{ content_text: 'te ayudo yo' }]);
    const ok = await recordResumeNote(db, {
      accountId: 'acct-1',
      userId: 'user-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
    });
    expect(ok).toBe(true);
    expect(noteInserts).toHaveLength(1);
    expect(noteInserts[0]).toMatchObject({
      contact_id: 'contact-1',
      user_id: 'user-1',
      account_id: 'acct-1',
    });
    expect(String(noteInserts[0].note_text)).toContain('IA reanudada');
  });
});
