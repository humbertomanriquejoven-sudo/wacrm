// ces2.mjs - calendar self-eval (real Google API, real Meet, real cleanup).
// Normaliza private_key como calendar.ts (replace /\\n/g -> newline) y TAMBIEN
// corrige doble-escape (\\n literal). Borra SIEMPRE el evento/fila creados.
// ASCII. OUT=<temp>. Nunca imprime valores.
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const envPath = process.argv[2]
const out = []
const log = (s) => out.push(s)

const env = new Map()
for (const ln of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = ln.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/)
  if (!m) continue
  env.set(m[1], m[2].trim())
}
const envGet = (k) => {
  const v = env.get(k) || ''
  const t = v.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1)
  return t
}
const calId = envGet('GOOGLE_CALENDAR_ID')

let svc = null
try { svc = JSON.parse(envGet('GOOGLE_SERVICE_ACCOUNT_JSON')) } catch (e) { log('SVC_PARSE=FAIL ' + e.message) }
if (svc && svc.client_email && svc.private_key) {
  // MUST mirror src/lib/calendar.ts#canonicalizePrivateKey so the eval
  // tests the EXACT production key canonicalization (strip ALL whitespace
  // from the base64 body, re-wrap at 64 cols). Kept as a pure copy since
  // .mjs vs .ts cannot share the import here.
  const norm = (k) => {
    let s = (k ?? '').replace(/\\n/g, '\n').trim()
    const begin = s.indexOf('-----BEGIN')
    const end = s.indexOf('-----END')
    if (begin === -1 || end === -1 || end < begin) {
      return s.replace(/\s+/g, ' ').trim()
    }
    const header = s.slice(begin, s.indexOf('\n', begin) === -1 ? begin + '-----BEGIN PRIVATE KEY-----'.length : s.indexOf('\n', begin)).trim()
    const footer = s.slice(end, s.indexOf('\n', end) === -1 ? s.length : s.indexOf('\n', end)).trim()
    const body = s.slice(begin + header.length, end).replace(/\s+/g, '')
    const lines = body.match(/.{1,64}/g) ?? []
    return `${header}\n${lines.join('\n')}\n${footer}`
  }
  const key = norm(svc.private_key)
  log('KEY_NORM=OK len=' + key.length + ' header=' + (key.startsWith('-----BEGIN') ? 'PEM_OK' : 'PEM_BAD'))
  try {
    const { JWT } = await import('google-auth-library')
    const { calendar } = await import('@googleapis/calendar')
    const auth = new JWT({ email: svc.client_email, key, scopes: ['https://www.googleapis.com/auth/calendar'] })
    const api = calendar({ version: 'v3', auth })
    // P1 auth+freebusy
    try {
      const fb = await api.freebusy.query({ requestBody: { timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 3600e3).toISOString(), timeZone: 'America/Lima', items: [{ id: calId }] } }, { timeout: 8000 })
      const busy = fb.data.calendars?.[calId]?.busy || []
      log('P1 AUTH_FREE_BUSY=OK busy=' + busy.length)
    } catch (e) { log('P1 AUTH_FREE_BUSY=FAIL ' + e.message) }
    // P2 create event with Meet
    try {
      const st = new Date(); st.setMinutes(st.getMinutes() + 10, 0, 0)
      const en = new Date(st.getTime() + 15 * 60e3)
      const created = await api.events.insert({ calendarId: calId, conferenceDataVersion: 1, requestBody: { summary: 'AUTOEVAL wacrm', description: 'test autoevaluacion', start: { dateTime: st.toISOString(), timeZone: 'America/Lima' }, end: { dateTime: en.toISOString(), timeZone: 'America/Lima' }, conferenceData: { createRequest: { requestId: Math.random().toString(36).slice(2), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } }, { timeout: 8000 })
      const link = created.data.hangoutLink || created.data.conferenceData?.entryPoints?.[0]?.uri || null
      log('P2 EVENT_CREATE=OK id=' + created.data.id)
      log('P2 HANGOUT_LINK=' + (link && link.includes('meet.google.com') ? 'OK meet.google.com' : 'FAIL'))
      if (created.data.id) {
        try { await api.events.delete({ calendarId: calId, eventId: created.data.id }, { timeout: 8000 }); log('P2 EVENT_DELETE=OK (cleanup)') }
        catch (e) { log('P2 EVENT_DELETE=FAIL ' + e.message) }
      }
    } catch (e) { log('P2 EVENT_CREATE=FAIL ' + e.message) }
  } catch (e) { log('P0 DEPS_IMPORT=FAIL ' + e.message) }
} else {
  log('SVC_PARSE=FAIL (no client_email/private_key)')
}
const rep = join(tmpdir(), 'ces2_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + '.txt')
writeFileSync(rep, out.join('\n') + '\n', 'utf8')
console.log('OUT=' + rep)