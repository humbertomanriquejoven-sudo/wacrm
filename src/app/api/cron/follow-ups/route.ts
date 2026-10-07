import { NextResponse } from 'next/server'
import { authorizeCronRequest } from '@/lib/whatsapp/cron-auth'
import { runScheduledFollowUps } from '@/lib/whatsapp/follow-up-worker'

/**
 * Drain BOTH per-conversation timers: the classic follow-up queue
 * (10-minute reminders + the 24-hour second stage) AND the response-wait
 * timers (Timer 2, "wait for the client's reply" — auto-cancelled the
 * moment the customer answers).
 *
 * Meant to be hit on a schedule — Vercel Cron / GitHub Actions / an
 * external pinger — exactly like `/api/automations/cron` and
 * `/api/flows/cron`. Requires the shared `AUTOMATION_CRON_SECRET` via
 * the `x-cron-secret` header so operators provision only one secret.
 *
 * The legacy alias `/api/whatsapp/follow-ups/cron` still works (same
 * secret, same behavior) — this shorter, discoverable path is the one
 * new crons should target.
 *
 * Alternatively an in-process sweep can run instead (or alongside): set
 * `FOLLOW_UP_WORKER_INTERVAL_SECONDS` and `src/instrumentation.ts` starts
 * a `setInterval` for this same function.
 *
 * Auth failures return 401 (wrong/missing secret) or 503 (secret not
 * configured); the run itself never throws, so a healthy sweep always
 * answers 200 with a JSON summary.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request)
  if (!auth.configured) {
    return NextResponse.json(
      { error: 'cron not configured' },
      { status: 503 },
    )
  }
  if (!auth.authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json(await runScheduledFollowUps())
}

export async function POST(request: Request) {
  const auth = authorizeCronRequest(request)
  if (!auth.configured) {
    return NextResponse.json(
      { error: 'cron not configured' },
      { status: 503 },
    )
  }
  if (!auth.authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json(await runScheduledFollowUps())
}