/**
 * Marker embedded in error messages that are caused by a broken
 * Supabase connection (missing env keys, unreachable database, etc.).
 *
 * The app-level error boundaries (`src/app/error.tsx` and
 * `src/app/global-error.tsx`) look for this marker to decide whether
 * the failure is an infrastructure/configuration problem — in which
 * case they offer a direct path back to `/login` instead of just a
 * vague "something broke" screen.
 *
 * Kept as a bare substring (not a class) so it survives the
 * client/server error serialization round-trip that Next.js performs
 * when forwarding an error to an error boundary.
 */
export const SUPABASE_CONFIG_ERROR_MARKER = "[supabase/config]"

/**
 * True when the error message carries the config marker embedded by
 * `src/lib/supabase/server.ts` when the Supabase env keys are missing.
 */
export function isSupabaseConfigError(message?: string): boolean {
  return Boolean(message && message.includes(SUPABASE_CONFIG_ERROR_MARKER))
}

/** Network/connectivity errors we anticipate from Supabase. */
const NETWORK_ERROR_PATTERNS =
  /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|NetworkError|Failed to fetch|fetch is not defined|supabase/i

/**
 * True when the error smells like an infrastructure problem (missing
 * Supabase config or the database not responding) rather than a bug in
 * page code. The error boundaries use this to offer / redirect to
 * /login, since the app cannot operate without a working backend.
 */
export function isInfrastructureError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (isSupabaseConfigError(error.message)) return true
  if (NETWORK_ERROR_PATTERNS.test(error.message)) return true
  return false
}