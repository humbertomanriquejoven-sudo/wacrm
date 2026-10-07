import { timingSafeEqual } from 'node:crypto'

/**
 * Shared authorization for every cron-style endpoint (`/api/automations/cron`,
 * `/api/flows/cron`, `/api/cron/follow-ups`, …). Operators provision ONE
 * secret, `AUTOMATION_CRON_SECRET`, and hit the endpoints with it in the
 * `x-cron-secret` header.
 *
 * Constant-time compare so an attacker who can reach the endpoint can't
 * recover the secret byte-by-byte from response-time deltas; the length
 * pre-check is required by `timingSafeEqual` (it throws otherwise).
 */
export interface CronAuthResult {
  /** False when AUTOMATION_CRON_SECRET is not set (→ 503). */
  configured: boolean
  authorized: boolean
}

export function authorizeCronRequest(request: Request): CronAuthResult {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return { configured: false, authorized: false }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  return {
    configured: true,
    authorized:
      suppliedBuf.length === expectedBuf.length &&
      timingSafeEqual(suppliedBuf, expectedBuf),
  }
}