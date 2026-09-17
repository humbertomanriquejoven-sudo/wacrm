import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com'
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
  process.env.GOOGLE_REFRESH_TOKEN = 'test-refresh'
})

const h = vi.hoisted(() => ({
  send: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
}))

vi.mock('@googleapis/gmail', () => ({
  gmail: vi.fn(() => ({
    users: {
      messages: {
        send: h.send,
        list: h.list,
        get: h.get,
      },
    },
  })),
}))

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    setCredentials() {}
  },
}))

import {
  gmailConfigured,
  enviar_correo,
  leer_correos,
  enviarConfirmacionCita,
} from '@/lib/gmail'

function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8')
}

describe('gmailConfigured', () => {
  it('is true when the OAuth env vars are present', () => {
    expect(gmailConfigured()).toBe(true)
  })
})

describe('enviar_correo', () => {
  beforeEach(() => {
    h.send.mockReset()
    h.send.mockResolvedValue({ data: { id: 'msg-1' } })
  })

  it('sends an HTML mail and returns a confirmation', async () => {
    const out = await enviar_correo({
      to: 'ana@x.com',
      subject: 'Confirmacion de cita',
      html: '<strong>Fecha</strong> 10:00 y Meet',
    })
    expect(out).toContain('Correo enviado a ana@x.com')
    expect(h.send).toHaveBeenCalledTimes(1)
    const body = decodeRaw((h.send.mock.calls[0][0] as { requestBody: { raw: string } }).requestBody.raw)
    expect(body).toContain('To: ana@x.com')
    expect(body).toContain('Subject: Confirmacion de cita')
    expect(body).toContain('<strong>Fecha</strong>')
    expect(body).toContain('multipart/alternative')
  })

  it('rejects a missing recipient or subject', async () => {
    const out = await enviar_correo({ to: '', subject: 'X' })
    expect(out).toContain('Error')
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('leer_correos', () => {
  beforeEach(() => {
    h.list.mockReset()
    h.get.mockReset()
    h.list.mockResolvedValue({
      data: {
        messages: [{ id: 'm1' }, { id: 'm2' }],
      },
    })
    h.get.mockResolvedValue({
      data: {
        payload: {
          headers: [
            { name: 'From', value: 'ana@x.com' },
            { name: 'Subject', value: 'Consulta' },
            { name: 'Date', value: 'Mon, 14 Sep 2026' },
          ],
        },
        snippet: 'Hola, quisiera agendar',
      },
    })
  })

  it('lists messages with maxResults=100 and formats them', async () => {
    const out = await leer_correos({})
    expect(out).toContain('De: ana@x.com')
    expect(out).toContain('Asunto: Consulta')
    expect(out).toContain('Hola, quisiera agendar')
    expect(h.list).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 100 }),
      expect.anything(),
    )
    expect(h.get).toHaveBeenCalledTimes(2)
  })

  it('reports no messages gracefully', async () => {
    h.list.mockResolvedValue({ data: {} })
    const out = await leer_correos({})
    expect(out).toContain('No hay correos')
  })
})

describe('enviarConfirmacionCita', () => {
  beforeEach(() => {
    h.send.mockReset()
    h.send.mockResolvedValue({ data: { id: 'msg-2' } })
  })

  it('builds and sends an HTML confirmation', async () => {
    const out = await enviarConfirmacionCita({
      to: 'ana@x.com',
      nombre: 'Ana',
      motivo: 'Cotización',
      inicioIso: '2026-09-20T15:00:00.000Z',
      duracionMin: 45,
      meetUrl: 'https://meet.google.com/abc-def-ghi',
    })
    expect(out).toContain('Correo enviado')
    const body = decodeRaw((h.send.mock.calls[0][0] as { requestBody: { raw: string } }).requestBody.raw)
    expect(body).toContain('Subject: =?UTF-8?B?') // RFC 2047-encoded accent subject
    const subjectB64 = body.match(/Subject: \=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?\=/)?.[1]
    expect(subjectB64 ? Buffer.from(subjectB64, 'base64').toString('utf8') : '').toBe(
      'Confirmación de cita — Cotización',
    )
    expect(body).toContain('https://meet.google.com/abc-def-ghi</a>')
  })
})