import { NextResponse } from 'next/server'
import { authorizeCronRequest } from '@/lib/whatsapp/cron-auth'
import { runScheduledFollowUps } from '@/lib/whatsapp/follow-up-worker'

/**
 * Drain BOTH per-conversation timers (follow-up queue + response-wait
 * timers). Same behavior as `/api/cron/follow-ups`.
 *
 * Legacy alias — the canonical path is `/api/cron/follow-ups` (this
 * route is kept so existing deployed schedules keep working). Requires
 * the shared `AUTOMATION_CRON_SECRET` via the `x-cron-secret` header.
 *
 * Alternatively an in-process sweep can run instead (or alongside): set
 * `FOLLOW_UP_WORKER_INTERVAL_SECONDS` and `src/instrumentation.ts` starts
 * a `setInterval` for this same function.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request)
  if (!auth.configured) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (!auth.authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json(await runScheduledFollowUps())
}

export async function POST(request: Request) {
  const auth = authorizeCronRequest(request)
  if (!auth.configured) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (!auth.authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json(await runScheduledFollowUps())
}