import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findOrCreateConversation } from './get-or-create';

// This helper replaces three private copies (the inbound webhook's, the manual
// send route's, and the public API's) that had drifted apart. The invariants
// below are the ones that drift broke: a missing thread must be OPENED, a lost
// insert race must be resolved rather than dropped, and a contact with no phone
// number must be handled exactly like one with.

const uniqueViolation = { message: 'duplicate key value', code: '23505' };

function db(opts: {
  existing?: Array<Record<string, unknown>>;
  selectError?: { message: string } | null;
  insertError?: { message: string } | null;
}) {
  const log = {
    inserts: [] as Record<string, unknown>[],
    filters: [] as Array<Record<string, unknown>>,
  };

  const chain: Record<string, unknown> = {
    eq: (c: string, v: unknown) => {
      log.filters.push({ [c]: v });
      return chain;
    },
    order: () => chain,
    limit: () => (opts.selectError ? Promise.resolve({ data: null, error: opts.selectError }) : Promise.resolve({ data: opts.existing ?? [], error: null })),
  };

  return {
    log,
    client: {
      from: (table: string) => {
        if (table !== 'conversations') throw new Error(`unexpected table: ${table}`);
        return {
          select: () => chain,
          insert: (row: Record<string, unknown>) => {
            log.inserts.push(row);
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({ data: opts.insertError ? null : { id: 'conv-new' }, error: opts.insertError ?? null }),
              }),
            };
          },
        };
      },
    } as never,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('findOrCreateConversation', () => {
  it('returns the existing thread without inserting', async () => {
    const d = db({ existing: [{ id: 'conv-1' }] });

    const found = await findOrCreateConversation(d.client, {
      accountId: 'acct-1',
      ownerUserId: 'u-1',
      contactId: 'c-1',
    });

    expect(found).toEqual({ conversation: { id: 'conv-1' }, created: false });
    expect(d.log.inserts).toHaveLength(0);
  });

  it('opens a thread when the contact has none', async () => {
    const d = db({ existing: [] });

    const found = await findOrCreateConversation(d.client, {
      accountId: 'acct-1',
      ownerUserId: 'u-1',
      contactId: 'c-1',
    });

    expect(found).toEqual({ conversation: { id: 'conv-new' }, created: true });
    expect(d.log.inserts[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'u-1',
      contact_id: 'c-1',
    });
  });

  it('keys on contact_id alone, so an opaque-id contact gets a thread too', async () => {
    // No phone number is read anywhere: a contact known only by an `@user`
    // handle or a BSUID is reached through contact_id like anyone else.
    const d = db({ existing: [] });

    await findOrCreateConversation(d.client, {
      accountId: 'acct-1',
      ownerUserId: 'u-1',
      contactId: 'c-bsuid',
    });

    expect(d.log.inserts[0]).toMatchObject({ contact_id: 'c-bsuid' });
    expect(d.log.filters).toEqual([{ account_id: 'acct-1' }, { contact_id: 'c-bsuid' }]);
  });

  it('resolves the winner when a concurrent delivery opened the thread first', async () => {
    // The insert loses the race against the unique index. Re-resolving returns
    // the row that won instead of dropping the message.
    let call = 0;
    const log = { inserts: [] as Record<string, unknown>[] };
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        const chain = () => b;
        for (const m of ['eq', 'order']) b[m] = vi.fn(chain);
        b.limit = vi.fn(() => {
          call += 1;
          return Promise.resolve({
            data: call === 1 ? [] : [{ id: 'conv-won' }],
            error: null,
          });
        });
        return {
          select: () => b,
          insert: (row: Record<string, unknown>) => {
            log.inserts.push(row);
            return {
              select: () => ({
                single: () => Promise.resolve({ data: null, error: uniqueViolation }),
              }),
            };
          },
        };
      },
    } as never;

    const found = await findOrCreateConversation(client, {
      accountId: 'acct-1',
      ownerUserId: 'u-1',
      contactId: 'c-1',
    });

    expect(found).toEqual({ conversation: { id: 'conv-won' }, created: false });
    expect(log.inserts).toHaveLength(1);
  });

  it('returns null on a real insert failure', async () => {
    const d = db({ existing: [], insertError: { message: 'permission denied' } });

    expect(
      await findOrCreateConversation(d.client, {
        accountId: 'acct-1',
        ownerUserId: 'u-1',
        contactId: 'c-1',
      }),
    ).toBeNull();
  });

  it('returns null when the lookup itself fails', async () => {
    // Never fabricate a second thread off a failed read.
    const d = db({ selectError: { message: 'timeout' } });

    expect(
      await findOrCreateConversation(d.client, {
        accountId: 'acct-1',
        ownerUserId: 'u-1',
        contactId: 'c-1',
      }),
    ).toBeNull();
    expect(d.log.inserts).toHaveLength(0);
  });

  it('never uses .single() for the lookup, which errors on duplicate threads', async () => {
    // `.single()` fails on both 0 and >=2 rows, and treating that as "none"
    // is what snowballed duplicate chats for a contact (issue #363).
    const d = db({ existing: [{ id: 'conv-1' }, { id: 'conv-2' }] });

    const found = await findOrCreateConversation(d.client, {
      accountId: 'acct-1',
      ownerUserId: 'u-1',
      contactId: 'c-1',
    });

    expect(found?.created).toBe(false);
    expect(d.log.inserts).toHaveLength(0);
  });
});
