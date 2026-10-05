import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BroadcastError } from './broadcast-core';
import { NO_DELIVERABLE_ADDRESS } from './broadcast-address';
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
  RESUME_MAX_PER_REQUEST,
} from './broadcast-resume';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));

// ============================================================
// Claim / release — the mutex that stops a double-send.
// ============================================================

interface ClaimCall {
  update: Record<string, unknown>;
  filters: Record<string, unknown>;
  or?: string;
}

function claimDb(returnedRows: unknown[], calls: ClaimCall[]): SupabaseClient {
  return {
    from() {
      const call: ClaimCall = { update: {}, filters: {} };
      const b: Record<string, unknown> = {
        update: (row: Record<string, unknown>) => {
          call.update = row;
          calls.push(call);
          return b;
        },
        eq: (col: string, val: unknown) => {
          call.filters[col] = val;
          return b;
        },
        or: (expr: string) => {
          call.or = expr;
          return b;
        },
        select: async () => ({ data: returnedRows, error: null }),
        then: (resolve: (r: { error: null }) => unknown) =>
          resolve({ error: null }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('claimBroadcastDelivery', () => {
  it('claims when the conditional UPDATE matched a row', async () => {
    const calls: ClaimCall[] = [];
    const ok = await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z'),
    );

    expect(ok).toBe(true);
    expect(calls[0].filters).toEqual({ id: 'bc-1', account_id: 'acct-1' });
    expect(calls[0].update.delivery_locked_at).toBe(
      '2026-08-11T12:00:00.000Z',
    );
  });

  it('refuses when another pass already holds the lock', async () => {
    // The UPDATE's WHERE didn't match — someone else got there first.
    const ok = await claimBroadcastDelivery(
      claimDb([], []),
      'acct-1',
      'bc-1',
    );
    expect(ok).toBe(false);
  });

  it('treats a lock older than the staleness window as abandoned', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z'),
    );
    // 30 minutes before "now" — a pass whose process died is recoverable
    // without touching the database by hand.
    expect(calls[0].or).toBe(
      'delivery_locked_at.is.null,delivery_locked_at.lt.2026-08-11T11:30:00.000Z',
    );
  });

  it('is scoped to the account, so another tenant cannot claim it', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(claimDb([], calls), 'acct-9', 'bc-1');
    expect(calls[0].filters.account_id).toBe('acct-9');
  });
});

describe('releaseBroadcastDelivery', () => {
  it('clears the lock', async () => {
    const calls: ClaimCall[] = [];
    await releaseBroadcastDelivery(claimDb([], calls), 'bc-1');
    expect(calls[0].update).toEqual({ delivery_locked_at: null });
    expect(calls[0].filters).toEqual({ id: 'bc-1' });
  });
});

// ============================================================
// Planning — which recipients a pass picks up, and with what params.
// ============================================================

interface PlanFixture {
  broadcast?: Record<string, unknown> | null;
  recipients?: Record<string, unknown>[];
  config?: Record<string, unknown> | null;
  templates?: Record<string, unknown>[];
  /** Inbound thread rows, for the tier-C WAMID lookup. */
  conversations?: Record<string, unknown>[];
  /** Inbound messages; `message_id` must be set to be usable as an anchor. */
  messages?: Record<string, unknown>[];
}

interface PlanWrites {
  statusFilter?: unknown;
  failedIds?: unknown;
  failedUpdate?: Record<string, unknown>;
}

/**
 * WAMID lookup defaults to one inbound message in `cv-1`, so a tier-C
 * recipient resolves an anchor without every fixture spelling it out.
 */
const DEFAULT_INBOUND: Record<string, unknown> = {
  conversation_id: 'cv-1',
  message_id: 'wamid-anchor',
};

function planDb(fx: PlanFixture, writes: PlanWrites = {}): SupabaseClient {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        not: () => b,
        limit: () => b,
        order: () => b,
        in: (col: string, vals: unknown) => {
          if (col === 'status') writes.statusFilter = vals;
          if (col === 'id') writes.failedIds = vals;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          writes.failedUpdate = row;
          return b;
        },
        maybeSingle: async () => ({
          data: fx.broadcast === undefined ? null : fx.broadcast,
          error: null,
        }),
        single: async () => ({
          data: fx.config === undefined ? null : fx.config,
          error: null,
        }),
then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => {
          if (table === 'broadcast_recipients') {
            return resolve({ data: fx.recipients ?? [], error: null });
          }
          if (table === 'message_templates') {
            return resolve({ data: fx.templates ?? [], error: null });
          }
          if (table === 'conversations') {
            return resolve({ data: fx.conversations ?? [], error: null });
          }
          if (table === 'messages') {
            return resolve({ data: fx.messages ?? [DEFAULT_INBOUND], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const BROADCAST = {
  id: 'bc-1',
  template_name: 'order_update',
  template_language: 'en_US',
};

const CONFIG = { phone_number_id: 'pn-1', access_token: 'tok' };

function recipient(
  id: string,
  phone: string | null,
  params: unknown = ['A123'],
) {
return {
    id,
    template_params: params,
    contact_id: `c-${id}`,
    contact: phone ? { phone } : null,
  };
}

/** A recipient identified by an opaque Meta id rather than a number. */
function identifierRecipient(
  id: string,
  contact: Record<string, string>,
  params: unknown = ['A123'],
) {
  return {
    id,
    template_params: params,
    // Real rows always carry this; it is what scopes the tier-C WAMID
    // lookup, so it cannot be undefined here.
    contact_id: contact.id ?? `c-${id}`,
    contact,
  };
}

/** A recipient whose only address is a bare @handle (tier C). */
function handleRecipient(
  id: string,
  username: string,
  contactId: string,
  params: unknown = ['A123'],
) {
  return {
    id,
    template_params: params,
    contact_id: contactId,
    contact: { phone: 'unknown', username },
  };
}

describe('planBroadcastResume', () => {
  it('resumes a BSUID recipient instead of failing it as unphoneable', async () => {
    // The gap this closes: resume read only contacts.phone and gated it on
    // isValidE164, so a campaign could deliver on the first pass and then
    // stamp every identifier recipient failed on resume.
    const writes: PlanWrites = {};
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            identifierRecipient('r1', {
              phone: 'unknown',
              wa_user_id: 'CO.1008477715690681',
            }),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(unsendable).toBe(0);
    expect(plan.planned).toEqual([
      {
        recipientRowId: 'r1',
        phone: 'CO.1008477715690681',
        params: ['A123'],
        contactId: 'c-r1',
        contextMessageId: null,
      },
    ]);
  });

  it('forwards the identifier verbatim, never digit-stripped', async () => {
    const writes: PlanWrites = {};
    const { plan } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            identifierRecipient('r1', { wa_id: '1486998326437295' }),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    // Not '1486998326437295' with a 'CO.' invented, and not a number.
    expect(plan.planned[0].phone).toBe('1486998326437295');
  });

  it('still fails a recipient with no deliverable address', async () => {
    const writes: PlanWrites = {};
    // Paired with a reachable recipient: an ALL-unsendable plan throws
    // `nothing_to_resume` before it can report, which is intended.
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            identifierRecipient('r1', { phone: 'unknown' }),
            recipient('r2', '+15551234567'),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(unsendable).toBe(1);
    expect(plan.planned.map((p) => p.recipientRowId)).toEqual(['r2']);
  });

  it('plans the outstanding recipients with their frozen params', async () => {
    const writes: PlanWrites = {};
    const { plan, remaining, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+15551234567', ['A123', 'Friday']),
            recipient('r2', '+15559876543', ['B456', 'Monday']),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(writes.statusFilter).toEqual(['pending']);
    // Phones are stored sanitized (no leading '+'), same as the shape
    // createBroadcast plans — deliverBroadcast feeds them to
    // phoneVariants from here.
expect(plan.planned).toEqual([
      {
        recipientRowId: 'r1',
        phone: '15551234567',
        params: ['A123', 'Friday'],
        contactId: 'c-r1',
        contextMessageId: null,
      },
      {
        recipientRowId: 'r2',
        phone: '15559876543',
        params: ['B456', 'Monday'],
        contactId: 'c-r2',
        contextMessageId: null,
      },
    ]);
    expect(plan.accessToken).toBe('decrypted:tok');
    expect(remaining).toBe(0);
    expect(unsendable).toBe(0);
  });

  it('plans a handle recipient with the WAMID to quote it against', async () => {
    // Tier C on resume. Without this the handle was either refused (campaign
    // 4) or sent bare (campaign 3, "(#100)"). The anchor comes from the
    // contact's own inbound history, resolved during planning so the send
    // loop has nothing left to decide.
    const writes: PlanWrites = {};
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            handleRecipient('h1', '@jjuanpablo22222', 'c-h1'),
          ],
          conversations: [{ id: 'cv-1', contact_id: 'c-h1' }],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(unsendable).toBe(0);
    expect(plan.planned[0].phone).toBe('@jjuanpablo22222');
    expect(plan.planned[0].contextMessageId).toBe('wamid-anchor');
  });

  it('fails a handle recipient with no inbound message to quote', async () => {
    // Nothing to anchor on means nothing to deliver, so it must be stamped
    // failed here — NOT sent bare and left to Meta's opaque error, which
    // either rejects or 200s and silently drops it.
    const writes: PlanWrites = {};
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            handleRecipient('h2', '@nohistory', 'c-h2'),
            // A deliverable phone row so the pass itself is still valid.
            recipient('ok', '15551234567'),
          ],
          // A conversation exists, but the contact never wrote in it.
          conversations: [{ id: 'cv-2', contact_id: 'c-h2' }],
          messages: [],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(unsendable).toBe(1);
    expect(plan.planned.map((r) => r.recipientRowId)).toEqual(['ok']);
    expect(writes.failedIds).toEqual(['h2']);
    expect(writes.failedUpdate).toMatchObject({
      status: 'failed',
      error_message: NO_DELIVERABLE_ADDRESS,
    });
  });

  it('scopes to failed rows when retrying, and to both for "all"', async () => {
    const failedWrites: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [recipient('r1', '+15551234567')],
        },
        failedWrites,
      ),
      'acct-1',
      'bc-1',
      'failed',
    );
    expect(failedWrites.statusFilter).toEqual(['failed']);

    const allWrites: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [recipient('r1', '+15551234567')],
        },
        allWrites,
      ),
      'acct-1',
      'bc-1',
      'all',
    );
    expect(allWrites.statusFilter).toEqual(['pending', 'failed']);
  });

  it('treats a missing or malformed params column as no params', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: BROADCAST,
        config: CONFIG,
        recipients: [
          // Rows created before migration 038 carry NULL.
          recipient('r1', '+15551234567', null),
          recipient('r2', '+15559876543', 'not-an-array'),
        ],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned.map((p) => p.params)).toEqual([[], []]);
  });

  it('fails unsendable rows up front so they stop blocking the status', async () => {
    const writes: PlanWrites = {};
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+15551234567'),
            recipient('r2', null),
            recipient('r3', 'nonsense'),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    // Left 'pending', these would keep the broadcast in 'sending'
    // forever — the exact symptom being fixed.
    expect(unsendable).toBe(2);
    expect(writes.failedIds).toEqual(['r2', 'r3']);
    expect(writes.failedUpdate?.status).toBe('failed');
    expect(plan.planned).toHaveLength(1);
  });

  it('caps one pass and reports the leftover', async () => {
    const many = Array.from({ length: RESUME_MAX_PER_REQUEST + 25 }, (_, i) =>
      recipient(`r${i}`, '+1555000' + String(i).padStart(4, '0')),
    );
    const { plan, remaining } = await planBroadcastResume(
      planDb({ broadcast: BROADCAST, config: CONFIG, recipients: many }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned).toHaveLength(RESUME_MAX_PER_REQUEST);
    // Surfaced to the caller rather than silently dropped.
    expect(remaining).toBe(25);
  });

  it('404s a broadcast that is not on this account', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: null }),
        'acct-1',
        'bc-1',
        'pending',
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses when there is nothing outstanding', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: BROADCAST, config: CONFIG, recipients: [] }),
        'acct-1',
        'bc-1',
        'failed',
      ),
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('resolves the template row for header + button components', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: { ...BROADCAST, template_language: 'en_US' },
        config: CONFIG,
        recipients: [recipient('r1', '+15551234567')],
        templates: [
          {
            id: 'tpl-1',
            user_id: 'u-1',
            name: 'order_update',
            // Synced from Meta as bare 'en' — the resolver bridges it.
            language: 'en',
            body_text: 'Your order {{1}} ships on {{2}}',
          },
        ],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.templateRow?.language).toBe('en');
  });
});



