import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { reagendar_cita, cancelar_cita } from '@/lib/calendar'

// Reschedule / cancel an existing appointment. Both go through the
// calendar helpers so the remote event and the `citas` row stay in
// sync (reagendar moves the Google event, cancelar deletes it and
// flips the row to 'cancelada').

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const nuevoInicio = typeof body.nuevoInicio === 'string' ? body.nuevoInicio.trim() : ''
  if (!nuevoInicio) {
    return NextResponse.json(
      { error: 'nuevoInicio is required' },
      { status: 400 },
    )
  }

  const db = supabaseAdmin()
  const result = await reagendar_cita({
    db,
    accountId: ctx.accountId,
    idCita: id,
    nuevoInicio,
  })

  if (result.startsWith('Error:')) {
    return NextResponse.json({ error: result.replace(/^Error:\s*/, '') }, { status: 400 })
  }

  return NextResponse.json({ ok: true, message: result })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const db = supabaseAdmin()
  const result = await cancelar_cita({
    db,
    accountId: ctx.accountId,
    idCita: id,
  })

  if (result.startsWith('Error:')) {
    return NextResponse.json({ error: result.replace(/^Error:\s*/, '') }, { status: 400 })
  }

  return NextResponse.json({ ok: true, message: result })
}