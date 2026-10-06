import { startFollowUpWorker } from '@/lib/whatsapp/follow-up-worker'

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
 */
export function register() {
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
}