// calendar-selfcheck: parse .env.local manually (no dotenv dep), then for real:
//  P0 env presence (OK/FAIL, never values)
//  P1 Google JWT auth (freebusy query proves auth)
//  P2 create real event + conferenceDataVersion:1 + hangoutsMeet ->
//     capture hangoutLink -> DELETE the event (no residue)
//  P3 insert into citas (supabase) -> delete it
// OUT=<tempfile> printed. ASCII only. Never prints secret values.
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const envPath = process.argv[2]
const r = []
const log = (s) => r.push(s)

const env = new Map()
for (const ln of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = ln.match(/^([A-Z0-9_]+)\s*=(.*)$/)
  if (!m) continue
  let v = m[2].trim()
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1)
  env.set(m[1], v)
}
const has = (k) => env.has(k) && env.get(k)?.trim()
log('P0 CALENDAR_ID=' + (has('GOOGLE_CALENDAR_ID') ? 'OK' : 'FAIL'))
log('P0 SERVICE_JSON=' + (has('GOOGLE_SERVICE_ACCOUNT_JSON') ? 'present-len=' + env.get('GOOGLE_SERVICE_ACCOUNT_JSON').length : 'FAIL'))
let svc = null
try { svc = JSON.parse(env.get('GOOGLE_SERVICE_ACCOUNT_JSON') || 'null'); log('P0 SERVICE_JSON_PARSE=' + (svc && svc.client_email && svc.private_key ? 'OK' : 'FAIL')) } catch (e) { log('P0 SERVICE_JSON_PARSE=FAIL ' + e.message) }
log('P0 SUPABASE_KEYS=' + ['SUPABASE_URL','NEXT_PUBLIC_SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','NEXT_PUBLIC_SUPABASE_ANON_KEY','SUPABASE_ANON_KEY'].filter((k) => has(k) || has('NEXT_PUBLIC_' + k)).join(',') + ' (names only)')

if (!svc || !svc.client_email || !svc.private_key) { finish() } else {
  const { JWT } = await import('google-auth-library')
  const { calendar } = await import('@googleapis/calendar')
  const calId = env.get('GOOGLE_CALENDAR_ID')
  const auth = new JWT({ email: svc.client_email, key: svc.private_key.replace(/\\n/g, '\n'), scopes: ['https://www.googleapis.com/auth/calendar'] })
  const api = calendar({ version: 'v3', auth })
  try {
    const fb = await api.freebusy.query({ requestBody: { timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 3600e3).toISOString(), timeZone: 'America/Bogota', items: [{ id: calId }] } }, { timeout: 8000 })
    log('P1 AUTH_FREEBUSY=' + (fb.data.calendars?.[calId] ? 'OK' : 'FAIL'))
  } catch (e) { log('P1 AUTH_FREEBUSY=FAIL ' + e.message) }

  try {
    const st = new Date(); st.setMinutes(st.getMinutes() + 5, 0, 0)
    const en = new Date(st.getTime() + 15 * 60e3)
    const insRes = await api.events.insert({ calendarId: calId, conferenceDataVersion: 1, requestBody: { summary: 'SELFCHECK wacrm (borrar)', description: 'autoevaluacion', start: { dateTime: st.toISOString(), timeZone: 'America/Bogota' }, end: { dateTime: en.toISOString(), timeZone: 'America/Bogota' }, conferenceData: { createRequest: { requestId: Math.random().toString(36).slice(2), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } }, { timeout: 8000 })
    const meet = insRes.data.hangoutLink || insRes.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri
    log('P2 EVENT_CREATE=' + (insRes.data.id ? 'OK' : 'FAIL'))
    log('P2 HANGOUT_LINK=' + (meet ? 'OK (meet.google.com)' : 'FAIL (no generated)'))
    log('P2 CONFERENCE_ID=' + (insRes.data.conferenceData?.conferenceId || 'n/a'))
    if (insRes.data.id) { try { await api.events.delete({ calendarId: calId, eventId: insRes.data.id }, { timeout: 8000 }); log('P2 CLEANUP_DELETE=OK') } catch (e) { log('P2 CLEANUP_DELETE=FAIL ' + e.message) } }
  } catch (e) { log('P2 EVENT_CREATE=FAIL ' + e.message) }
}

// P3 DB: supabase insert+delete into citas
const sUrl = has('SUPABASE_URL') ? env.get('SUPABASE_URL') : (has('NEXT_PUBLIC_SUPABASE_URL') ? env.get('NEXT_PUBLIC_SUPABASE_URL') : '')
const sKey = has('SUPABASE_SERVICE_ROLE_KEY') ? env.get('SUPABASE_SERVICE_ROLE_KEY') : (has('NEXT_PUBLIC_SUPABASE_ANON_KEY') ? env.get('NEXT_PUBLIC_SUPABASE_ANON_KEY') : (has('SUPABASE_ANON_KEY') ? env.get('SUPABASE_ANON_KEY') : ''))
if (!sUrl || !sKey) {
  log('P3 DB=SKIP (no supabase url/key en .env.local)')
} else {
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const db = createClient(sUrl, sKey)
    const now = new Date()
    const row = { account_id: 'selfeval', contacto_id: null, google_event_id: 'selfeval-' + now.getTime(), meet_link: null, fecha_inicio: now.toISOString(), fecha_fin: new Date(now.getTime() + 15 * 60e3).toISOString(), estado: 'confirmada' }
    const ins = await db.from('citas').insert(row).select('id').single()
    if (ins.error) { log('P3 DB_INSERT=FAIL ' + ins.error.message) }
    else {
      log('P3 DB_INSERT=OK id=' + ins.data.id)
      const del = await db.from('citas').delete().eq('id', ins.data.id).select('id').single()
      log('P3 DB_DELETE=' + (del.error ? 'FAIL ' + del.error.message : 'OK'))
    }
  } catch (e) { log('P3 DB=FAIL ' + e.message) }
}

function finish() {
  const t = join(tmpdir(), 'cs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + '.txt')
  writeFileSync(t, r.join('\n') + '\n', 'utf8')
  console.log('OUT=' + t)
}
finish()
