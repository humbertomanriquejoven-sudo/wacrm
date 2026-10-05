import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BroadcastError } from './broadcast-core';
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
  /** Simulate a database without `contacts.recipient_id` (migration 057). */
  missingRecipientId?: boolean;
}

interface PlanWrites {
  statusFilter?: unknown;
  failedIds?: unknown;
  failedUpdate?: Record<string, unknown>;
  selects?: string[];
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
  writes.selects ??= [];
  return {
    from(table: string) {
      // Set by `select` and honoured by `then`, so the whole chain stays on
      // one builder. Returning a second object from `select` would lose the
      // error: `.eq()` on it hands back the original builder, and the await
      // would then resolve with data instead of the 42703.
      let pendingError: { code: string; message: string } | null = null;
      const b: Record<string, unknown> = {
        select: (cols: string) => {
          writes.selects!.push(cols);
          // Simulates a database where migration 057 has not been applied:
          // PostgREST rejects the whole request rather than nulling one
          // column, which is what produced "500 Failed to load recipients".
          if (fx.missingRecipientId && cols.includes('recipient_id')) {
            pendingError = {
              code: '42703',
              message: 'column contacts.recipient_id does not exist',
            };
          }
          return b;
        },
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
          if (pendingError) {
            return resolve({ data: null, error: pendingError } as never);
          }
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
  contact: Record<string, string | null>,
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

  it('recovers a number from the recipient history when no column holds one', async () => {
    // The exact shape of a pre-053/057 contact row: every identity column
    // NULL, and the only address anywhere in the database sitting in
    // `messages.sender_phone`. Resume never consulted history, so this
    // recipient was stamped failed with NO_DELIVERABLE_ADDRESS even though
    // the dashboard resolved the very same contact from its thread.
    const writes: PlanWrites = {};
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            identifierRecipient('r1', {
              id: 'c-r1',
              phone: null,
              wa_id: null,
              wa_user_id: null,
              username: null,
            }),
          ],
          conversations: [{ id: 'cv-1', contact_id: 'c-r1' }],
          messages: [
            {
              conversation_id: 'cv-1',
              sender_phone: '573121828949',
              raw_meta_payload: null,
            },
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(unsendable).toBe(0);
    // The plan must carry the RECOVERED address, not an empty string — the
    // sendable gate approved it, so the destination has to agree.
    expect(plan.planned).toEqual([
      {
        recipientRowId: 'r1',
        phone: '573121828949',
        params: ['A123'],
        contactId: 'c-r1',
      },
    ]);
  });

  it('recovers a BSUID from the recipient history payload', async () => {
    // Same row, but the address only exists inside the stored Meta payload
    // because Meta disclosed no number on the inbound message.
    const writes: PlanWrites = {};
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            identifierRecipient('r1', { id: 'c-r1', phone: 'unknown' }),
          ],
          conversations: [{ id: 'cv-1', contact_id: 'c-r1' }],
          messages: [
            {
              conversation_id: 'cv-1',
              sender_phone: null,
              raw_meta_payload: {
                message: { from: 'unknown', from_user_id: 'CO.1008477715690681' },
                contact: { wa_id: '' },
              },
            },
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(unsendable).toBe(0);
    // Namespaced form is kept verbatim: 	oMetaTargetId strips the 'CO.'
    // at the payload boundary, and stripping it here would lose the
    // namespace that distinguishes a BSUID from a phone number.
    expect(plan.planned[0].phone).toBe('CO.1008477715690681');
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
      },
      {
        recipientRowId: 'r2',
        phone: '15559876543',
        params: ['B456', 'Monday'],
        contactId: 'c-r2',
      },
    ]);
    expect(plan.accessToken).toBe('decrypted:tok');
    expect(remaining).toBe(0);
    expect(unsendable).toBe(0);
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

  it('retries without recipient_id when the column is missing', async () => {
    // PostgREST 42703s the whole projection, so an unapplied migration 057
    // turned every resume into "500 Failed to load recipients". The pass must
    // still plan using the remaining identity columns.
    const writes: PlanWrites = {};
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          missingRecipientId: true,
          recipients: [
            identifierRecipient('r1', { phone: 'unknown', wa_id: '1486998326437295' }),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(unsendable).toBe(0);
    expect(plan.planned[0].phone).toBe('1486998326437295');
    // Recipient projections only: full first, then the legacy fallback.
    const projections = writes.selects!.filter((s) => s.includes('contacts('));
    expect(projections[0]).toContain('recipient_id');
    expect(projections[1]).not.toContain('recipient_id');
    warn.mockRestore();
  });

  it('does not retry on an unrelated query failure', async () => {
    // A blanket retry would mask a real error (RLS, bad filter) behind a
    // second identical failure, so only a missing column triggers the fallback.
    const writes: PlanWrites = {};
    const base = planDb(
      { broadcast: BROADCAST, config: CONFIG, recipients: [recipient('r1', '15551234567')] },
      writes,
    );
    const realFrom = (base as unknown as { from: (t: string) => unknown }).from.bind(base);

    const failing = {
      from: (table: string) => {
        if (table !== 'broadcast_recipients') return realFrom(table);
        const b: Record<string, unknown> = {
          select: (cols: string) => {
            writes.selects!.push(cols);
            return b;
          },
          eq: () => b,
          in: () => b,
          order: () =>
            Promise.resolve({ data: null, error: { message: 'permission denied' } }),
          then: (resolve: (r: unknown) => unknown) =>
            resolve({ data: null, error: { message: 'permission denied' } }),
        };
        return b;
      },
    } as unknown as SupabaseClient;

    await expect(
      planBroadcastResume(failing, 'acct-1', 'bc-1', 'pending'),
    ).rejects.toThrow('Failed to load recipients');
    // Exactly one projection attempted: no fallback was requested.
    expect(writes.selects!.filter((s) => s.includes('contacts('))).toHaveLength(1);
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



