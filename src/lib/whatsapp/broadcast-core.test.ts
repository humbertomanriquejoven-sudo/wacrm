import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createBroadcast,
  deliverBroadcast,
  finalizeBroadcastStatus,
  BroadcastError,
  type BroadcastPlan,
} from './broadcast-core';
import type { MessageTemplate } from '@/types';

// Contact resolution and token decryption are exercised elsewhere — stub
// them so these tests focus on the persistence boundary.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-access-token',
}));

// The Inbox mirror renders the template body with each recipient's frozen
// params, so record what it was handed.
vi.mock('@/lib/whatsapp/template-body', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/whatsapp/template-body')>();
  return {
    ...actual,
    templateContentText: (
      row: Parameters<typeof actual.templateContentText>[0],
      params: string[],
    ) => actual.templateContentText(row, params) ?? `fallback:${params.join(',')}`,
  };
});
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({ id: 'c1' })),
}));

// deliverBroadcast fans out through this; stub the transport so the
// mirroring assertions are about the DB side only.
const sendTemplateMessageMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: 'wamid.OUT1' })),
);
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: sendTemplateMessageMock,
}));

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

// Build a Supabase-shaped mock that gets createBroadcast past its config +
// template lookups and into persistence. `rpcResult` is what the atomic
// create_broadcast_with_recipients RPC returns.
function makeDb(rpcResult: { data: unknown; error: unknown }) {
  const calls = {
    rpc: [] as { name: string; args: unknown }[],
    // Incremented if the OLD non-atomic path (a direct broadcasts /
    // broadcast_recipients insert) is ever reached — it must not be.
    usedDirectInsert: 0,
  };
  const database = {
    from(table: string) {
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { phone_number_id: 'pn-1', access_token: 'enc' },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === 'message_templates') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        };
        return chain;
      }
      if (table === 'broadcasts' || table === 'broadcast_recipients') {
        calls.usedDirectInsert++;
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'orphan' }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(name: string, args: unknown) {
      calls.rpc.push({ name, args });
      return Promise.resolve(rpcResult);
    },
  } as unknown as SupabaseClient;
  return { db: database, calls };
}

describe('createBroadcast atomicity (#370)', () => {
  it('creates parent + recipients through the atomic RPC, never a bare parent insert', async () => {
    const { db, calls } = makeDb({
      data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
      error: null,
    });

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    });

    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe('create_broadcast_with_recipients');
    expect(calls.usedDirectInsert).toBe(0);
    expect(plan.broadcastId).toBe('b-1');
    // `contactId` rides along so deliverBroadcast can mirror each send into
    // that recipient's own Inbox thread.
    expect(plan.planned).toEqual([
      {
        recipientRowId: 'r-1',
        contactId: 'c1',
        phone: '14155550123',
        params: [],
      },
    ]);
  });

  it('throws and leaves no orphaned parent when the atomic create fails', async () => {
    const { db, calls } = makeDb({
      data: null,
      error: { message: 'recipient insert failed' },
    });

    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toBeInstanceOf(BroadcastError);

    // The RPC was the only persistence attempt; because it runs both
    // inserts in a single transaction, its failure rolls the parent back —
    // there is no separate parent insert that could survive as an orphan.
    expect(calls.rpc).toHaveLength(1);
    expect(calls.usedDirectInsert).toBe(0);
  });
});

// ============================================================
// Terminal status (#472). Derived from the recipient rows, not from a
// counter local to one delivery pass — a resume only sends the
// leftovers, so "nothing sent this pass" must not condemn a campaign
// that already delivered hundreds.
// ============================================================

function statusDb(
  counts: Record<string, number>,
  total: number,
  writes: { update?: Record<string, unknown> },
) {
  return {
    from(table: string) {
      let status: string | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (col === 'status') status = val as string;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'broadcasts') writes.update = row;
          return b;
        },
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({
            count: status === null ? total : (counts[status] ?? 0),
            error: null,
          }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('finalizeBroadcastStatus', () => {
  it('leaves a capped pass in "sending" while recipients are still pending', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(statusDb({ pending: 25 }, 1025, writes), 'b-1');
    // No write at all — the UI keeps offering Resume.
    expect(writes.update).toBeUndefined();
  });

  it('marks a fully-failed broadcast failed', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 10 }, 10, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('failed');
  });

  it('marks a partially-failed broadcast sent', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 3 }, 10, writes),
      'b-1',
    );
    // 7 people got the message; failed_count carries the other 3.
    expect(writes.update?.status).toBe('sent');
  });

  it('does not condemn a campaign whose resume pass sent nothing new', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    // 800 delivered on the original pass, the 200-recipient resume all
    // failed. Pre-fix this wrote 'failed' off a pass-local counter.
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 200 }, 1000, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('sent');
  });
});

// ============================================================
// Inbox mirroring — every recipient shape, no per-contact special cases.
// ============================================================

// `body_text` is the column `templateContentText` renders.
const TEMPLATE_ROW = {
  body_text: 'Hola {{1}}, tu cita es {{2}}',
} as unknown as MessageTemplate;

/** Records every messages/conversations write, and the conversation lookup. */
function mirrorDb(opts: {
  conversationId?: string | null;
  insertError?: { message: string } | null;
}) {
  const log = {
    messagesInserts: [] as Record<string, unknown>[],
    conversationUpdates: [] as Record<string, unknown>[],
    recipientUpdates: [] as Record<string, unknown>[],
    lookups: [] as Array<Record<string, unknown>>,
  };

  const db = {
    from: (table: string) => {
      if (table === 'conversations') {
        return {
          select: () => {
            // select -> eq(account_id) -> eq(contact_id) -> order -> limit
            // -> maybeSingle; each filter logs and returns the same builder.
            const done = () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data:
                    opts.conversationId === null
                      ? null
                      : { id: opts.conversationId ?? 'conv-1' },
                  error: null,
                }),
            });
            const b: Record<string, unknown> = {
              eq: (c: string, v: unknown) => {
                log.lookups.push({ [c]: v });
                return b;
              },
              order: () => ({ limit: () => done() }),
              limit: () => done(),
              maybeSingle: () => done(),
            };
            return b;
          },
          update: (row: Record<string, unknown>) => {
            log.conversationUpdates.push(row);
            return { eq: () => Promise.resolve({ data: null, error: null }) };
          },
        };
      }
      if (table === 'messages') {
        return {
          insert: (row: Record<string, unknown>) => {
            log.messagesInserts.push(row);
            return Promise.resolve({ data: null, error: opts.insertError ?? null });
          },
        };
      }
      // broadcast_recipients status stamping, and the pending-count probe
      // finalizeBroadcastStatus runs at the end of the pass.
      // broadcast_recipients status stamping, plus the exact-count probes
      // finalizeBroadcastStatus runs to close the campaign out.
      return {
        update: (row: Record<string, unknown>) => {
          log.recipientUpdates.push(row);
          const b: Record<string, unknown> = {
            eq: () => Promise.resolve({ data: null, error: null }),
            in: () => Promise.resolve({ data: null, error: null }),
          };
          return b;
        },
        select: () => {
          const b: Record<string, unknown> = {
            eq: () => b,
            in: () => Promise.resolve({ count: 0, error: null, data: null }),
          };
          return b;
        },
      };
    },
  } as unknown as SupabaseClient;

  return { db, log };
}

function mirrorPlan(
  phone: string,
  params: string[],
  contactId = 'c-generic'
): BroadcastPlan {
  return {
    broadcastId: 'b-1',
    templateName: 'promo',
    templateLanguage: 'es',
    phoneNumberId: 'pn-1',
    accessToken: 'token',
    accountId: 'acct-1',
    templateRow: TEMPLATE_ROW,
    planned: [
      {
        recipientRowId: 'r-1',
        phone,
        params,
        contactId,
        contextMessageId: null,
      },
    ],
    rejected: 0,
  };
}

describe('deliverBroadcast Inbox mirroring', () => {
  it('mirrors a send for an E.164 recipient into that contact thread', async () => {
    const { db, log } = mirrorDb({});

    await deliverBroadcast(db, mirrorPlan('573121828949', ['Ana', 'mar 10']));

    // No `direction` / `metadata` columns exist on `messages`; naming
    // either makes PostgREST reject the insert with 42703.
    expect(log.messagesInserts[0]).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'agent',
      content_type: 'template',
      content_text: 'Hola Ana, tu cita es mar 10',
      template_name: 'promo',
      message_id: 'wamid.OUT1',
      status: 'sent',
    });
    expect(log.messagesInserts[0]).not.toHaveProperty('direction');
    expect(log.messagesInserts[0]).not.toHaveProperty('metadata');
  });

  it('mirrors a BSUID recipient identically, resolved by contact only', async () => {
    // The point of the requirement: no branch on the address shape. An
    // opaque id and a number differ only in the string sent to Meta.
    const { db, log } = mirrorDb({});

    await deliverBroadcast(db, mirrorPlan('CO.1008477715690681', ['Ana']));

    // The thread is located by contact identity alone, never by the
    // address string, so no BSUID/phone special case can creep in here.
    expect(log.lookups).toEqual([
      { account_id: 'acct-1' },
      { contact_id: 'c-generic' },
    ]);
    // Under-supplied params leave later placeholders untouched — a faithful
    // mirror of what was sent, not a crash or a blank row.
    expect(log.messagesInserts[0]).toMatchObject({
      conversation_id: 'conv-1',
      content_text: 'Hola Ana, tu cita es {{2}}',
      message_id: 'wamid.OUT1',
    });
  });

  it('never stamps a recipient sent when Meta rejected it', async () => {
    const { db, log } = mirrorDb({});
    sendTemplateMessageMock.mockRejectedValueOnce(new Error('(#100) Invalid parameter'));

    await deliverBroadcast(db, mirrorPlan('bad-address', ['Ana']));

    expect(log.messagesInserts).toHaveLength(0);
    expect(log.recipientUpdates[0]).toMatchObject({ status: 'failed' });
  });

  it('keeps the send successful when the Inbox insert fails', async () => {
    // Meta already accepted the message. Reporting a send failure here
    // would re-queue it and deliver twice.
    const { db, log } = mirrorDb({ insertError: { message: 'boom' } });

    await deliverBroadcast(db, mirrorPlan('573121828949', ['Ana']));

    expect(log.recipientUpdates[0]).toMatchObject({ status: 'sent' });
  });

  it('skips mirroring when the recipient has no conversation yet', async () => {
    const { db, log } = mirrorDb({ conversationId: null });

    await deliverBroadcast(db, mirrorPlan('573121828949', ['Ana']));

    expect(log.messagesInserts).toHaveLength(0);
    expect(log.recipientUpdates[0]).toMatchObject({ status: 'sent' });
  });
});
