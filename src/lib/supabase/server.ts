import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { SUPABASE_CONFIG_ERROR_MARKER } from '@/lib/errors'

/**
 * Server-side Supabase client (auth-aware, cookie-backed).
 *
 * Server components that gate on the session already ran through
 * middleware, so in normal flow the env vars are present. But a
 * misconfigured deploy must not take the page down with a generic 500:
 * if either NEXT_PUBLIC_SUPABASE_* value is missing we throw a clear,
 * actionable error that carries `SUPABASE_CONFIG_ERROR_MARKER` so the
 * app-level error boundaries can detect it and pivot the visitor to
 * the /login screen instead of a blank failure. (No default client is
 * returned: a client with an undefined URL would just make every query
 * fail later anyway.)
 */
export async function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      `${SUPABASE_CONFIG_ERROR_MARKER} NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set — cannot create the server client.`,
    )
  }

  const cookieStore = await cookies()

  return createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  )
}
