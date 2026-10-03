import { describe, expect, it, vi } from 'vitest';

import {
  findMergeableOrphan,
  mergeContactInto,
  mergeJustification,
} from '@/lib/contacts/merge';

/**
 * The merge deletes a row and rewrites conversation history, so these tests
 * are mostly about refusals: proving the module declines whenever the
 * evidence is ambiguous. The Supabase client is a recording stub, so a
 * mistake shows up as an unexpected write rather than a silent no-op.
 */

// ---------------------------------------------------------------
// Minimal chainable stub. Filters are recorded, not evaluated —
// `findMergeableOrphan`'s own filtering runs in JS on the rows the stub
// returns, which is where the merge-safety logic actually lives.
// ---------------------------------------------------------------
type Row = Record<string, unknown>;

function makeDb(rowsByTable: Record<string, Row[]>) {
  const calls: Array<{ op: string; table: string; payload?: unknown }> = [];

  function builder(table: string) {
    // Filters are applied, not just recorded: `mergeContactInto` re-queries
    // mid-flight (the conversation-per-contact check, the name-uniqueness
    // count) and a stub that ignored `.eq` would hand back every row and
    // make those decisions look ambiguous no matter what the fixtures say.
    const filters: Array<(row: Row) => boolean> = [];

    const matches = (row: Row) => filters.every((f) => f(row));
    const rows = () => (rowsByTable[table] ?? []).filter(matches);

    const result = () => ({
      data: rows(),
      error: null,
      count: rows().length,
    });

    const b: Record<string, unknown> = {};
    const chain = () => b;

    b.select = vi.fn(chain);
    b.eq = vi.fn((column: string, value: unknown) => {
      filters.push((row) => row[column] === value);
      return b;
    });
    b.neq = vi.fn((column: string, value: unknown) => {
      filters.push((row) => row[column] !== value);
      return b;
    });
    b.in = vi.fn((column: string, values: unknown[]) => {
      filters.push((row) => values.includes(row[column]));
      return b;
    });
    // `.or()` is a SQL disjunction this stub cannot reproduce. Skipped
    // deliberately: the JS-level filtering after the query is what these
    // tests exercise, and the fixtures are built to reach it.
    b.or = vi.fn(chain);
    b.limit = vi.fn(chain);
    b.order = vi.fn(chain);

    b.update = vi.fn((p: unknown) => {
      calls.push({ op: 'update', table, payload: p });
      return b;
    });
    b.delete = vi.fn(() => {
      calls.push({ op: 'delete', table });
      return b;
    });
    b.insert = vi.fn((p: unknown) => {
      calls.push({ op: 'insert', table, payload: p });
      return b;
    });
    // `maybeSingle` must yield the row itself, not an array: the merge reads
    // `survivorConversation.id`, and a stub returning `[]` there would look
    // like a truthy conversation with an undefined id.
    const single = () => {
      const found = rows();
      return {
        data: found.length === 1 ? found[0] : null,
        error: null,
        count: found.length,
      };
    };
    b.maybeSingle = vi.fn(() => Promise.resolve(single()));
    b.single = vi.fn(() => Promise.resolve(single()));
    b.then = (resolve: (v: unknown) => unknown) => resolve(result());
    return b;
  }

  return {
    db: { from: vi.fn((table: string) => builder(table)) } as never,
    calls,
  };
}

/** A real Meta BSUID: 16 digits, as Meta issues them. */
const BSUID = '1008477715690681';

const SURVIVOR = {
  id: 'c-real',
  account_id: 'acct-1',
  phone: '573001234567',
  name: 'Ana Ruiz',
  username: 'ana.ruiz',
  wa_user_id: null,
};

const ORPHAN_BSUID = {
  id: 'c-orphan',
  account_id: 'acct-1',
  // The BSUID lives in `phone` because the column is NOT NULL — this is the
  // row a message from an unregistered number creates.
  phone: `CO.${BSUID}`,
  name: 'Ana Ruiz',
  username: null,
  wa_user_id: BSUID,
};

// ---------------------------------------------------------------
// mergeJustification — evidence tiers
// ---------------------------------------------------------------
describe('mergeJustification', () => {
  it('matches on a shared BSUID even when the handles differ', () => {
    expect(
      mergeJustification(
        { ...ORPHAN_BSUID, username: 'old.handle' },
        { ...SURVIVOR, username: 'ana.ruiz', wa_user_id: BSUID }
      )
    ).toBe('wa_user_id');
  });

  it('does not match a BSUID against a row that has none', () => {
    // The survivor's `phone` is a real number, not an identifier, so it
    // must not be read as one — otherwise every real number would look
    // like a match against the orphan's BSUID.
    expect(mergeJustification(ORPHAN_BSUID, SURVIVOR)).toBeNull();
  });

  it('matches on a shared username', () => {
    expect(
      mergeJustification(
        { ...ORPHAN_BSUID, username: '@ana.ruiz' },
        SURVIVOR
      )
    ).toBe('username');
  });

  it('refuses a name match by default, since names are not unique', () => {
    expect(mergeJustification(ORPHAN_BSUID, SURVIVOR)).toBeNull();
  });

  it('accepts a name match only when explicitly allowed', () => {
    expect(
      mergeJustification(ORPHAN_BSUID, SURVIVOR, { allowNameMatch: true })
    ).toBe('name');
  });

  it('ignores case and accents when a name match is allowed', () => {
    expect(
      mergeJustification(
        { ...ORPHAN_BSUID, name: '  ANA   RUÍZ ' },
        { ...SURVIVOR, name: 'ana ruiz' },
        { allowNameMatch: true }
      )
    ).toBe('name');
  });

  it('does not treat an empty name as a match', () => {
    expect(
      mergeJustification({ ...ORPHAN_BSUID, name: null }, SURVIVOR, {
        allowNameMatch: true,
      })
    ).toBeNull();
  });

  it('returns null when nothing is shared', () => {
    expect(
      mergeJustification(
        { ...ORPHAN_BSUID, username: 'otra', name: 'Otra Persona' },
        { ...SURVIVOR, username: 'ana.ruiz' },
        { allowNameMatch: true }
      )
    ).toBeNull();
  });
});

// ---------------------------------------------------------------
// findMergeableOrphan — which row, if any, is safe to fold in
// ---------------------------------------------------------------
describe('findMergeableOrphan', () => {
  it('returns null when the survivor has no dialable phone', async () => {
    const { db, calls } = makeDb({ contacts: [ORPHAN_BSUID] });
    const found = await findMergeableOrphan(db, 'acct-1', {
      ...SURVIVOR,
      phone: 'BSUID.abc123',
    });
    expect(found).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('finds an orphan sharing the username', async () => {
    const { db } = makeDb({
      contacts: [SURVIVOR, { ...ORPHAN_BSUID, username: '@ana.ruiz' }],
    });
    const found = await findMergeableOrphan(db, 'acct-1', SURVIVOR);
    expect(found?.id).toBe('c-orphan');
  });

  it('never returns a row that already has a real phone number', async () => {
    const { db } = makeDb({
      contacts: [SURVIVOR, { ...ORPHAN_BSUID, phone: '573009999999' }],
    });
    const found = await findMergeableOrphan(db, 'acct-1', SURVIVOR);
    expect(found).toBeNull();
  });

  it('falls back to the name when the survivor has no stable identity', async () => {
    const { db } = makeDb({
      contacts: [
        SURVIVOR,
        { ...SURVIVOR, id: 'c-real' }, // the survivor itself
        { ...ORPHAN_BSUID, username: null },
      ],
    });
    const found = await findMergeableOrphan(
      db,
      'acct-1',
      { ...SURVIVOR, username: null, wa_user_id: null }
    );
    expect(found?.id).toBe('c-orphan');
  });

  it('refuses a name match when several orphans share that name', async () => {
    const { db } = makeDb({
      contacts: [
        { ...SURVIVOR, id: 'c-real', username: null, wa_user_id: null },
        { ...ORPHAN_BSUID, id: 'c-a', username: null },
        { ...ORPHAN_BSUID, id: 'c-b', username: null },
      ],
    });
    const found = await findMergeableOrphan(
      db,
      'acct-1',
      { ...SURVIVOR, username: null, wa_user_id: null }
    );
    expect(found).toBeNull();
  });

  it('does not look up by name when the survivor has no name', async () => {
    const { db } = makeDb({ contacts: [ORPHAN_BSUID] });
    const found = await findMergeableOrphan(
      db,
      'acct-1',
      { ...SURVIVOR, name: null, username: null, wa_user_id: null }
    );
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------
// mergeContactInto — the destructive part
// ---------------------------------------------------------------
describe('mergeContactInto', () => {
  it('refuses when a row is missing', async () => {
    const { db, calls } = makeDb({ contacts: [SURVIVOR] });
    const outcome = await mergeContactInto(db, {
      accountId: 'acct-1',
      survivorId: 'c-real',
      orphanId: 'c-orphan',
    });
    expect(outcome.merged).toBe(false);
    expect(outcome.reason).toMatch(/no longer exists/);
    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(0);
  });

  it('never merges or deletes across tenants', async () => {
    // The read is scoped by `account_id`, so a row belonging to another
    // account is not even returned — the first line of defence. The
    // explicit check inside `mergeContactInto` is the second, for the case
    // where a caller hands the function ids it resolved some other way.
    const { db, calls } = makeDb({
      contacts: [SURVIVOR, { ...ORPHAN_BSUID, account_id: 'acct-other' }],
    });
    const outcome = await mergeContactInto(db, {
      accountId: 'acct-1',
      survivorId: 'c-real',
      orphanId: 'c-orphan',
    });
    expect(outcome.merged).toBe(false);
    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(0);
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(0);
  });

  it('refuses an ambiguous name match with no shared identity', async () => {
    const { db, calls } = makeDb({
      contacts: [
        { ...SURVIVOR, username: null, wa_user_id: null },
        { ...ORPHAN_BSUID, username: null, name: 'Ana Ruiz' },
      ],
    });
    const outcome = await mergeContactInto(db, {
      accountId: 'acct-1',
      survivorId: 'c-real',
      orphanId: 'c-orphan',
    });
    // One row carries the name, so the name is unambiguous and this
    // particular pair is allowed — but the orphan must still be an orphan.
    expect(outcome.merged).toBe(true);
    expect(calls.some((c) => c.op === 'delete' && c.table === 'contacts')).toBe(
      true
    );
  });

  it('refuses a name match when a second orphan shares the name', async () => {
    const { db, calls } = makeDb({
      contacts: [
        { ...SURVIVOR, username: null, wa_user_id: null },
        { ...ORPHAN_BSUID, username: null },
        { ...ORPHAN_BSUID, id: 'c-other', username: null },
      ],
    });
    const outcome = await mergeContactInto(db, {
      accountId: 'acct-1',
      survivorId: 'c-real',
      orphanId: 'c-orphan',
    });
    expect(outcome.merged).toBe(false);
    expect(outcome.reason).toMatch(/no shared identity/);
    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(0);
  });

  it('absorbs the BSUID onto the survivor and deletes the orphan', async () => {
    const { db, calls } = makeDb({
      contacts: [SURVIVOR, ORPHAN_BSUID],
      conversations: [],
    });
    const outcome = await mergeContactInto(db, {
      accountId: 'acct-1',
      survivorId: 'c-real',
      orphanId: 'c-orphan',
    });

    expect(outcome.merged).toBe(true);
    expect(outcome.fieldsAbsorbed).toContain('wa_user_id');

    const absorb = calls.find(
      (c) => c.op === 'update' && c.table === 'contacts'
    );
    expect(absorb?.payload).toMatchObject({ wa_user_id: BSUID });

    // The orphan is deleted last, after the survivor has been updated.
    const ops = calls.map((c) => `${c.op}:${c.table}`);
    expect(ops.indexOf('update:contacts')).toBeLessThan(
      ops.indexOf('delete:contacts')
    );
  });

  it('never overwrites a name the operator already chose', async () => {
    // Shared BSUID proves they're the same person. The orphan also carries a
    // handle the survivor lacks, so there IS something to absorb — but its
    // display name must not be taken: the survivor already has one a human
    // may have typed into the CRM.
    const { db, calls } = makeDb({
      contacts: [
        { ...SURVIVOR, wa_user_id: BSUID, username: null },
        { ...ORPHAN_BSUID, username: 'ana.nueva', name: 'Nombre Distinto' },
      ],
      conversations: [],
    });
    const outcome = await mergeContactInto(db, {
      accountId: 'acct-1',
      survivorId: 'c-real',
      orphanId: 'c-orphan',
    });
    expect(outcome.merged).toBe(true);
    // The handle is absorbed…
    expect(outcome.fieldsAbsorbed).toContain('username');
    // …but the display name is left alone.
    const absorb = calls.find(
      (c) => c.op === 'update' && c.table === 'contacts'
    );
    expect(absorb?.payload).not.toHaveProperty('name');
  });

  it('folds the orphan thread into the survivor when both already have one', async () => {
    const { db, calls } = makeDb({
      contacts: [SURVIVOR, ORPHAN_BSUID],
      conversations: [
        { id: 'conv-orphan', account_id: 'acct-1', contact_id: 'c-orphan' },
        { id: 'conv-real', account_id: 'acct-1', contact_id: 'c-real' },
      ],
      messages: [
        { id: 'm-1', conversation_id: 'conv-orphan' },
        { id: 'm-2', conversation_id: 'conv-orphan' },
      ],
    });
    const outcome = await mergeContactInto(db, {
      accountId: 'acct-1',
      survivorId: 'c-real',
      orphanId: 'c-orphan',
    });

    expect(outcome.merged).toBe(true);
    expect(outcome.messagesMoved).toBe(2);

    const ops = calls.map((c) => `${c.op}:${c.table}`);
    // Messages must be moved BEFORE the duplicate conversation is deleted,
    // otherwise the CASCADE on messages.conversation_id destroys the
    // history this merge exists to preserve.
    expect(ops.indexOf('update:messages')).toBeLessThan(
      ops.indexOf('delete:conversations')
    );
    // And the surviving thread must be the survivor's, not the orphan's.
    const move = calls.find(
      (c) => c.op === 'update' && c.table === 'messages'
    );
    expect(move?.payload).toMatchObject({ conversation_id: 'conv-real' });
  });

  it('re-points dependent rows before deleting the orphan', async () => {
    // Notes, deals, appointments and the rest hang off contact_id. Deleting
    // the orphan without moving them would cascade or null them, quietly
    // destroying the history the merge is supposed to preserve.
    const { db, calls } = makeDb({
      contacts: [SURVIVOR, ORPHAN_BSUID],
      conversations: [],
    });
    const outcome = await mergeContactInto(db, {
      accountId: 'acct-1',
      survivorId: 'c-real',
      orphanId: 'c-orphan',
    });

    expect(outcome.merged).toBe(true);
    const ops = calls.map((c) => `${c.op}:${c.table}`);
    for (const table of [
      'contact_notes',
      'deals',
      'broadcast_recipients',
      'citas',
    ]) {
      expect(ops).toContain(`update:${table}`);
      expect(ops.indexOf(`update:${table}`)).toBeLessThan(
        ops.indexOf('delete:contacts')
      );
    }
  });

  it('reassigns the orphan conversation when the survivor has none', async () => {
    const { db, calls } = makeDb({
      contacts: [SURVIVOR, ORPHAN_BSUID],
      conversations: [
        { id: 'conv-orphan', account_id: 'acct-1', contact_id: 'c-orphan' },
      ],
      messages: [{ id: 'm-1', conversation_id: 'conv-orphan' }],
    });
    const outcome = await mergeContactInto(db, {
      accountId: 'acct-1',
      survivorId: 'c-real',
      orphanId: 'c-orphan',
    });

    expect(outcome.merged).toBe(true);
    expect(outcome.conversationsMoved).toBe(1);
    const reassign = calls.find(
      (c) => c.op === 'update' && c.table === 'conversations'
    );
    expect(reassign?.payload).toMatchObject({ contact_id: 'c-real' });
    // Nothing to move or drop: the thread itself becomes the survivor's.
    expect(calls.some((c) => c.op === 'delete' && c.table === 'conversations')).toBe(
      false
    );
  });
});