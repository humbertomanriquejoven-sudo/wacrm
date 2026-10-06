import { startFollowUpWorker } from '@/lib/whatsapp/follow-up-worker'
import { SUPABASE_CONFIG_ERROR_MARKER } from '@/lib/errors'

/**
 * Server bootstrap hooks (Next.js instrumentation).
 *
 * The ONLY thing started here is the optional in-process follow-up
 * runner, and it is OFF by default: `docs/docker.md` documents that
 * nothing inside the container is scheduled — production drives all
 * background work via external pingers hitting the `*\/cron` endpoints.
 * Setting `FOLLOW_UP_WORKER_INTERVAL_SECONDS` opts into the internal
 * `setInterval` for deployments (a dedicated long-lived box) where an
 * external scheduler is not worth provisioning.
 *
 * HARD RULE: `register()` must NEVER throw. It runs during server
 * bootstrap, so any exception here would take down every request (a
 * blanket 500) the moment the worker touches a database that is down or
 * behind on its migrations. Bootstrap is best-effort: if the follow-up
 * runner cannot start, the CRM keeps serving pages and the external cron
 * (or a later restart) picks the work up.
 */
export function register() {
  try {
    // If the Supabase env is missing the worker's sweeps would all fail
    // against an unreachable DB anyway. Skip it explicitly (and state
    // why in the logs) rather than spinning up a runner that can only
    // log errors once a minute. Bootstrap never throws either way.
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      console.warn(
        `[follow-up] ${SUPABASE_CONFIG_ERROR_MARKER} NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are missing — in-process runner skipped; the CRM keeps serving and the external cron can still trigger the sweep endpoints.`,
      )
      return
    }

    const raw = process.env.FOLLOW_UP_WORKER_INTERVAL_SECONDS
    const intervalSeconds = raw ? Number(raw) : NaN
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      return
    }

    const stop = startFollowUpWorker({ intervalMs: intervalSeconds * 1000 })
    // Keep the handle reachable for tests / graceful shutdown hooks.
    ;(globalThis as Record<string, unknown>)['__followUpWorkerStop'] = stop
    console.log(
      `[follow-up] in-process runner started (every ${intervalSeconds}s) — driven by FOLLOW_UP_WORKER_INTERVAL_SECONDS.`,
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