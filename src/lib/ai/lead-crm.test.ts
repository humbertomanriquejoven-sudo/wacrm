import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AI_NOTE_PREFIX,
  applyLeadTags,
  formatLeadNote,
  normalizeTagNames,
  recordContactNote,
} from './lead-crm';

interface FakeState {
  tags: { id: string; name: string }[];
  latestNote: { note_text: string } | null;
  tagInserts: {
    user_id: string;
    account_id: string;
    name: string;
    color: string;
  }[];
  contactTagUpserts: { contact_id: string; tag_id: string }[];
  noteInserts: Record<string, unknown>[];
}

/**
 * Minimal stand-in for the PostgREST query builder used by the helpers.
 * List reads resolve via `then`; `.maybeSingle()` resolves single rows.
 */
function makeDb(state: FakeState): SupabaseClient {
  const builderFor = (table: string) => {
    let op: 'select' | 'insert' | 'upsert' = 'select';
    const builder: Record<string, unknown> = {};
    const chain = (name: string) => (arg?: unknown) => {
      if (name === 'insert') {
        op = 'insert';
        if (table === 'tags') {
          const rows = (
            Array.isArray(arg) ? arg : [arg]
          ) as FakeState['tagInserts'];
          state.tagInserts.push(...rows);
        }
        if (table === 'contact_notes') {
          state.noteInserts.push(
            ...((Array.isArray(arg) ? arg : [arg]) as Record<string, unknown>[])
          );
        }
      }
      if (name === 'upsert') {
        op = 'upsert';
        if (table === 'contact_tags') {
          state.contactTagUpserts.push(
            ...((Array.isArray(arg)
              ? arg
              : [arg]) as FakeState['contactTagUpserts'])
          );
        }
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
      if (table === 'tags' && op === 'insert') {
        // Echo created rows so the caller can map names to ids.
        const created = state.tagInserts.map((t, i) => ({
          id: `created-${i}`,
          name: t.name,
        }));
        return Promise.resolve({ data: created, error: null });
      }
      if (table === 'contact_notes') {
        return Promise.resolve({ data: state.latestNote, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    builder.maybeSingle = single;
    builder.single = single;
    builder.then = (onFulfilled: (v: unknown) => unknown) => {
      let listData: unknown = [];
      if (table === 'tags') {
        listData =
          op === 'insert'
            ? state.tagInserts.map((t, i) => ({
                id: `created-${i}`,
                name: t.name,
              }))
            : state.tags;
      }
      return Promise.resolve({ data: listData, error: null }).then(onFulfilled);
    };
    return builder;
  };
  return {
    from: (table: string) => builderFor(table),
  } as unknown as SupabaseClient;
}

function emptyState(): FakeState {
  return {
    tags: [],
    latestNote: null,
    tagInserts: [],
    contactTagUpserts: [],
    noteInserts: [],
  };
}

describe('normalizeTagNames', () => {
  it('splits delimited strings, trims and dedupes case-insensitively', () => {
    expect(
      normalizeTagNames('En conversacion; en conversacion , Llamar Mañana')
    ).toEqual(['En conversacion', 'Llamar Mañana']);
  });

  it('accepts arrays and drops empties', () => {
    expect(normalizeTagNames([' a ', '', 'A', 'b'])).toEqual(['a', 'b']);
  });

  it('returns an empty list for junk', () => {
    expect(normalizeTagNames(null)).toEqual([]);
    expect(normalizeTagNames(42)).toEqual([]);
  });
});

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

describe('applyLeadTags', () => {
  it('reuses an existing account tag (case-insensitive) without creating it', async () => {
    const state = emptyState();
    state.tags = [{ id: 'tag-1', name: 'En conversacion' }];
    const db = makeDb(state);

    const applied = await applyLeadTags(db, {
      accountId: 'acct-1',
      userId: 'user-1',
      contactId: 'contact-1',
      tagNames: ['en conversacion'],
    });

    expect(applied).toEqual(['en conversacion']);
    expect(state.tagInserts).toHaveLength(0);
    expect(state.contactTagUpserts).toEqual([
      { contact_id: 'contact-1', tag_id: 'tag-1' },
    ]);
  });

  it('creates a missing tag and then applies it', async () => {
    const state = emptyState();
    const db = makeDb(state);

    const applied = await applyLeadTags(db, {
      accountId: 'acct-1',
      userId: 'user-1',
      contactId: 'contact-1',
      tagNames: ['Reunion de Diseño'],
    });

    expect(state.tagInserts).toHaveLength(1);
    expect(state.tagInserts[0]).toMatchObject({
      user_id: 'user-1',
      account_id: 'acct-1',
      name: 'Reunion de Diseño',
    });
    expect(applied).toEqual(['Reunion de Diseño']);
    expect(state.contactTagUpserts).toHaveLength(1);
  });

  it('is a no-op when there are no tags', async () => {
    const state = emptyState();
    const db = makeDb(state);
    const applied = await applyLeadTags(db, {
      accountId: 'acct-1',
      userId: 'user-1',
      contactId: 'contact-1',
      tagNames: [],
    });
    expect(applied).toEqual([]);
    expect(state.contactTagUpserts).toHaveLength(0);
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
