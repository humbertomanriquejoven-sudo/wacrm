/**
 * Hard purge of all contact data. Rows only — schema, FKs and API
 * routes are untouched:
 *
 *   messages        — every row
 *   conversations   — every row
 *   contacts        — every row
 *
 * Child tables already CASCADE or SET NULL on contacts(id), so the
 * explicit deletes just make the intent (and the logs) unambiguous.
 *
 * Usage:  npm run db:purge-contacts
 */
import { createClient } from '@supabase/supabase-js'

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file)
  } catch {
    // file absent — fine, values may come from the real environment
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
      'Set them in .env / .env.local or the process environment and retry.',
  )
  process.exit(1)
}

const db = createClient(url, key)

async function purgeTable(table: string): Promise<void> {
  const { count: before, error: countErr } = await db
    .from(table)
    .select('*', { count: 'exact', head: true })
  if (countErr) {
    console.error(`[purge] ${table}: count failed: ${countErr.message}`)
    process.exit(1)
  }

  const { error } = await db.from(table).delete().not('id', 'is', null)
  if (error) {
    console.error(`[purge] ${table}: delete failed: ${error.message}`)
    process.exit(1)
  }
  console.log(`[purge] ${table}: deleted ${before ?? '?'} rows`)
}

const main = async () => {
  await purgeTable('messages')
  await purgeTable('conversations')
  await purgeTable('contacts')
  console.log('[purge] contacts data wiped. Schema unchanged.')
}

main().catch((err) => {
  console.error('[purge] failed:', err)
  process.exit(1)
})
