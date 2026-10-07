import { SUPABASE_CONFIG_ERROR_MARKER } from '@/lib/errors'

/**
 * Server bootstrap hooks (Next.js instrumentation).
 *
 * The ONLY thing started here is the in-process follow-up runner, and it
 * is ON by default (every 60s). Timed reminders are stored in the DB and
 * must be delivered even when no external scheduler is configured, so the
 * standalone container self-drives its own sweep. Operators can opt out
 * with `FOLLOW_UP_WORKER_DISABLED=true` (then drive the sweep from an
 * external pinger hitting `*\/cron` instead) or tune the cadence with
 * `FOLLOW_UP_WORKER_INTERVAL_SECONDS`.
 *
 * HARD RULE: `register()` must NEVER throw. It runs during server
 * bootstrap, so any exception here would take down every request (a
 * blanket 500) the moment the worker touches a database that is down or
 * behind on its migrations. Bootstrap is best-effort: if the follow-up
 * runner cannot start, the CRM keeps serving pages and the external cron
 * (or a later restart) picks the work up.
 */
export async function register() {
  // Node.js runtime only. `register()` is invoked in BOTH the Node and
  // Edge runtimes, and Next compiles this file into the Edge
  // instrumentation bundle too. The follow-up runner transitively
  // imports Node built-ins (`crypto`, through the WhatsApp token
  // decryptor). Importing it at the top of this module pulls that graph
  // into the Edge bundle, where `crypto` compiles to a call to an
  // undefined `__import_unsupported` helper — the edge bundle then
  // throws `ReferenceError: __import_unsupported is not defined` while
  // it is evaluated, before any request is routed, so EVERY page
  // (including / and /login) returns a bare HTTP 500.
  //
  // Guard on the runtime and import lazily so the Edge bundle never
  // evaluates it. See Next.js docs → "Importing runtime-specific code".
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return
  }

  try {
    // If the Supabase env is missing the worker's sweeps would all fail
    // against an unreachable DB anyway. Skip it explicitly (and state
    // why in the logs) rather than spinning up a runner that can only
    // log errors once a minute. The worker sends through the service
    // role, so THAT is the key it needs. Bootstrap never throws either way.
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.warn(
        `[follow-up] ${SUPABASE_CONFIG_ERROR_MARKER} NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing — in-process runner skipped; the CRM keeps serving and an external cron can still trigger the sweep endpoints.`,
      )
      return
    }

    if (process.env.FOLLOW_UP_WORKER_DISABLED === 'true') {
      console.log(
        '[follow-up] in-process runner disabled via FOLLOW_UP_WORKER_DISABLED=true; drive the sweep from an external cron instead.',
      )
      return
    }

    // Guard against a duplicate interval when `register()` runs more than
    // once in the same process (dev hot-reload, repeated bootstrap).
    if ((globalThis as Record<string, unknown>)['__followUpWorkerStop']) {
      return
    }

    // Default cadence: one minute. Override with a positive integer.
    const raw = process.env.FOLLOW_UP_WORKER_INTERVAL_SECONDS
    const parsed = raw ? Number(raw) : NaN
    const intervalSeconds =
      Number.isFinite(parsed) && parsed > 0 ? parsed : 60

    const { startFollowUpWorker } = await import('@/lib/whatsapp/follow-up-worker')
    const stop = startFollowUpWorker({ intervalMs: intervalSeconds * 1000 })
    // Keep the handle reachable for tests / graceful shutdown hooks.
    ;(globalThis as Record<string, unknown>)['__followUpWorkerStop'] = stop
    console.log(
      `[follow-up] in-process runner started (every ${intervalSeconds}s) — set FOLLOW_UP_WORKER_DISABLED=true to opt out.`,
    )
  } catch (err) {
    // Bootstrap must stay green: the site opens, and the missed sweeps
    // are retried by the external cron or the next deploy.
    console.error(
      '[follow-up] in-process runner failed to start — continuing without it:',
      err instanceof Error ? err.message : err,
    )
  }
}