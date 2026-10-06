import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { runDueFollowUps } from '@/lib/whatsapp/follow-up-worker'

/**
 * Drain due DID-follow-up rows (the 10-minute reminders).
 *
 * Meant to be hit on a schedule — Vercel Cron / GitHub Actions /
 * external pinger — exactly like `/api/automations/cron` and
 * `/api/flows/cron`. Requires the shared `AUTOMATION_CRON_SECRET` via
 * the `x-cron-secret` header so operators provision only one secret.
 *
 * Alternatively an in-process sweep can run instead (or alongside):
 * set `FOLLOW_UP_WORKER_INTERVAL_SECONDS` and `src/instrumentation.ts`
 * starts a `setInterval` for this same function.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Constant-time compare so an attacker who can hit the endpoint can't
  // recover the secret byte-by-byte from response-time deltas. Length
  // pre-check is required by timingSafeEqual (throws otherwise).
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await runDueFollowUps()
  return NextResponse.json(result)
}