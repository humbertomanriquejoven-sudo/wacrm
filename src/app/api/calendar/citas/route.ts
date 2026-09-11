import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { agendar_cita } from '@/lib/calendar'

// Create an appointment. The frontend posts the picked time; the
// server validates business hours + freeBusy through `agendar_cita`
// (which also writes the Google Calendar event and the `citas` row),
// then returns the new appointment id and a human-readable line.

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const contactoId = typeof body.contactId === 'string' ? body.contactId.trim() : ''
  const inicio = typeof body.inicio === 'string' ? body.inicio.trim() : ''
  const motivo = typeof body.motivo === 'string' ? body.motivo.trim() : undefined

  if (!contactoId || !inicio) {
    return NextResponse.json(
      { error: 'contactId and inicio are required' },
      { status: 400 },
    )
  }

  // Resolve the contact so we can title the remote event with the
  // customer's name (same payload the AI tool uses).
  const { data: contact, error: contactErr } = await ctx.supabase
    .from('contacts')
    .select('id, name')
    .eq('id', contactoId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (contactErr) {
    return NextResponse.json({ error: 'Could not load contact' }, { status: 500 })
  }
  if (!contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  }

  // Service-role client + explicit account scoping, mirroring the AI
  // auto-reply path — the calendar helpers write through the agent
  // RLS gate otherwise.
  const db = supabaseAdmin()
  const result = await agendar_cita({
    db,
    accountId: ctx.accountId,
    contactoId,
    inicio,
    nombre: contact.name ?? 'Cita',
    motivo,
  })

  if (result.startsWith('Error:')) {
    return NextResponse.json({ error: result.replace(/^Error:\s*/, '') }, { status: 400 })
  }

  // Locate the freshly created row so the caller can refresh without
  // guessing an id.
  const { data: row, error: rowErr } = await db
    .from('citas')
    .select('id, fecha_inicio')
    .eq('contact_id', contactoId)
    .eq('account_id', ctx.accountId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (rowErr || !row) {
    return NextResponse.json({ ok: true, message: result })
  }

  return NextResponse.json({ ok: true, id: row.id, message: result })
}