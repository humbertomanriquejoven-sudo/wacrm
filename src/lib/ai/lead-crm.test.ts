import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AI_NOTE_PREFIX,
  formatLeadNote,
  recordContactNote,
} from './lead-crm';

interface FakeState {
  latestNote: { note_text: string } | null;
  noteInserts: Record<string, unknown>[];
}

/**
 * Minimal stand-in for the PostgREST query builder used by the helpers.
 * List reads resolve via `then`; `.maybeSingle()` resolves single rows.
 */
function makeDb(state: FakeState): SupabaseClient {
  const builderFor = (table: string) => {
    const builder: Record<string, unknown> = {};
    const chain = (name: string) => (arg?: unknown) => {
      if (name === 'insert' && table === 'contact_notes') {
        state.noteInserts.push(
          ...((Array.isArray(arg) ? arg : [arg]) as Record<string, unknown>[])
        );
      }
      return builder;
    };
    for (const m of [
      'select',
      'eq',
      'order',
      'limit',
      'not',
      'insert',
      'upsert',
    ]) {
      builder[m] = chain(m);
    }
    const single = () => {
      if (table === 'contact_notes') {
        return Promise.resolve({ data: state.latestNote, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    builder.maybeSingle = single;
    builder.single = single;
    builder.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(onFulfilled);
    return builder;
  };
  return {
    from: (table: string) => builderFor(table),
  } as unknown as SupabaseClient;
}

function emptyState(): FakeState {
  return {
    latestNote: null,
    noteInserts: [],
  };
}

describe('formatLeadNote', () => {
  it('prefixes a non-empty note', () => {
    expect(formatLeadNote('  Remodelación en Chía  ')).toBe(
      `${AI_NOTE_PREFIX} Remodelación en Chía`
    );
  });

  it('returns empty for blank input', () => {
    expect(formatLeadNote('   ')).toBe('');
  });
});

describe('recordContactNote', () => {
  it('inserts a new note', async () => {
    const state = emptyState();
    const db = makeDb(state);
    const inserted = await recordContactNote(db, {
      accountId: 'acct-1',
      userId: 'user-1',
      contactId: 'contact-1',
      noteText: 'Proyecto: remodelación; Ubicación: Chía',
    });
    expect(inserted).toBe(true);
    expect(state.noteInserts).toHaveLength(1);
    expect(state.noteInserts[0]).toMatchObject({
      contact_id: 'contact-1',
      user_id: 'user-1',
      account_id: 'acct-1',
      note_text: 'Proyecto: remodelación; Ubicación: Chía',
    });
  });

  it('collapses a consecutive identical note', async () => {
    const state = emptyState();
    state.latestNote = { note_text: 'Proyecto: remodelación' };
    const db = makeDb(state);
    const inserted = await recordContactNote(db, {
      accountId: 'acct-1',
      userId: 'user-1',
      contactId: 'contact-1',
      noteText: 'Proyecto: remodelación',
    });
    expect(inserted).toBe(false);
    expect(state.noteInserts).toHaveLength(0);
  });

  it('is a no-op for blank text', async () => {
    const state = emptyState();
    const db = makeDb(state);
    const inserted = await recordContactNote(db, {
      accountId: 'acct-1',
      userId: 'user-1',
      contactId: 'contact-1',
      noteText: '   ',
    });
    expect(inserted).toBe(false);
  });
});
