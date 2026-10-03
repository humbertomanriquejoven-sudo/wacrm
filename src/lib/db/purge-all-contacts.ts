/**
 * Definitive purge of all contact data. Rows only — schema, FKs,
 * triggers and API routes are untouched:
 *
 *   TRUNCATE TABLE messages CASCADE;
 *   TRUNCATE TABLE conversations CASCADE;
 *   TRUNCATE TABLE contacts CASCADE;
 *
 * Prefers a direct Postgres connection (DATABASE_URL / SUPABASE_DB_URL)
 * so the TRUNCATE actually executes; falls back to the Supabase service
 * role client (row deletes, same net effect) when no connection string
 * is configured.
 *
 * Usage:  npm run db:purge
 */
import { createClient } from '@supabase/supabase-js'

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file)
  } catch {
    // file absent — values may come from the real environment
  }
}

const databaseUrl =
  process.env.DATABASE_URL ??
  process.env.SUPABASE_DB_URL ??
  process.env.DIRECT_URL ??
  process.env.POSTGRES_URL

async function purgeViaSql(): Promise<void> {
  // Import lazily: pg is only needed on this path.
  const { Client } = await import('pg')
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    // contacts is the root; CASCADE sweeps conversations/messages and
    // every child FK. The extra tables are named explicitly so the log
    // leaves no doubt about what was wiped.
    await client.query(
      'TRUNCATE TABLE messages, conversations, contact_notes, contact_tags, contact_custom_values, broadcast_recipients, flow_runs, contacts CASCADE',
    )
    console.log('[purge] TRUNCATE messages, conversations, contact_notes, contact_tags, contact_custom_values, broadcast_recipients, flow_runs, contacts CASCADE — done')
  } finally {
    await client.end()
  }
}

async function purgeViaSupabase(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Set DATABASE_URL or SUPABASE_SERVICE_ROLE_KEY to run the purge',
    )
  }
  const db = createClient(url, key)
  for (const table of [
    'messages',
    'conversations',
    'contact_notes',
    'contact_tags',
    'contact_custom_values',
    'broadcast_recipients',
    'flow_runs',
    'contacts',
  ] as const) {
    const { error } = await db.from(table).delete().not('id', 'is', null)
    if (error) {
      // flow_runs / broadcast_recipients may not exist on older schemas —
      // a missing table must not abort the rest of the purge.
      if (/could not find the table|does not exist/i.test(error.message)) {
        console.log(`[purge] ${table}: skipped (not present)`)
        continue
      }
      throw new Error(`${table}: ${error.message}`)
    }
    console.log(`[purge] ${table}: deleted`)
  }
}

const main = async () => {
  if (databaseUrl) {
    await purgeViaSql()
  } else {
    console.log('[purge] no DATABASE_URL found — falling back to Supabase service role')
    await purgeViaSupabase()
  }
  console.log('[purge] contacts data wiped. Schema unchanged.')
}

main().catch((err) => {
  console.error('[purge] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
