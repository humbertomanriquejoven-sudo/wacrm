import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { planBroadcastResume } from './broadcast-resume';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

const BROADCAST = {
  id: 'bc-1',
  template_name: 't',
  template_language: 'es',
};

/** Every column the migrations create on `contacts`.
 *
 *  Covers both shapes a column can take: an inline `CREATE TABLE contacts
 *  (...)` definition (001) and a later `ADD COLUMN [IF NOT EXISTS] name`.
 */
function contactColumnsFromMigrations(): Set<string> {
  const columns = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');

    for (const m of sql.matchAll(
      /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi,
    )) {
      columns.add(m[1].toLowerCase());
    }
    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?contacts\s*\(([\s\S]*?)\n\)/gi,
    )) {
      for (const col of m[1].split(',')) {
        const name = col.trim().match(/^([a-z_][a-z0-9_]*)/i);
        if (name) columns.add(name[1].toLowerCase());
      }
    }
  }
  return columns;
}

/** The columns resume asks PostgREST for, as written in its select. */
function resumeProjectionColumns(): string[] {
  const src = readFileSync(
    join(process.cwd(), 'src', 'lib', 'whatsapp', 'broadcast-resume.ts'),
    'utf8',
  );
  const m = src.match(/contact:contacts\(([^)]*)\)/);
  if (!m) throw new Error('resume no longer selects a nested contacts(...) projection');
  return m[1].split(',').map((c) => c.trim()).filter(Boolean);
}

describe('broadcast resume schema contract', () => {
  it('projects contacts columns that some migration actually creates', () => {
    // Regression: `recipient_id` is declared on the `Contact` type and was
    // selected here, but no migration ever created it — 053 adds
    // display_name/wa_id/phone_number_id/identity_type. PostgREST answered
    // 42703 "column does not exist", surfacing as the opaque
    // "Failed to load recipients" (500) that took resume down entirely.
    const known = contactColumnsFromMigrations();
    const missing = resumeProjectionColumns().filter((c) => !known.has(c.toLowerCase()));

    expect(missing).toEqual([]);
  });

  it('still selects the identifier sources the resolver depends on', () => {
    // Guard against "resolving" this by deleting a column instead of
    // creating it: these are what resolveBroadcastAddress reads, in order.
    const projected = resumeProjectionColumns();
    for (const column of ['phone', 'wa_id', 'wa_user_id', 'username', 'recipient_id']) {
      expect(projected).toContain(column);
    }
  });
});

describe('planBroadcastResume recipient load', () => {
  it('reports the PostgREST error instead of masking it as a bare 500', async () => {
    // The 500 shipped as a bare "Failed to load recipients", which sent us
    // looking for an import bug instead of a missing column. The underlying
    // message reaches the console line, so the next occurrence is
    // diagnosable from the log alone.
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(args.map(String).join(' '));
    });

    // `broadcasts` resolves; `broadcast_recipients` fails the way PostgREST
    // does when the projection names a column the database lacks.
    const db = {
      from: (table: string) => {
        if (table === 'broadcasts') {
          return {
            select: () => {
              const b: Record<string, unknown> = {
                eq: () => b,
                maybeSingle: () => Promise.resolve({ data: BROADCAST, error: null }),
              };
              return b;
            },
          };
        }
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          order: () =>
            Promise.resolve({
              data: null,
              error: {
                message: 'column contacts.recipient_id does not exist',
                code: '42703',
              },
            }),
        };
        return chain;
      },
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    await expect(
      planBroadcastResume(db, 'acct-1', 'bc-1', 'pending'),
    ).rejects.toThrow('Failed to load recipients');

    expect(logged.join('\n')).toContain('contacts.recipient_id does not exist');
    spy.mockRestore();
  });
});
