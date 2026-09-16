// eval3.mjs - SMALL real Google Calendar self-eval + Supabase DB probe.
// Uses the SAME key normalization as src/lib/calendar.ts (L96).
// NEVER prints secret values. ASCII. OUT=<temp>. Usage:
//   node eval3.mjs "<abs env file>"
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const p = process.argv[2]
const out = []
const log = (s) => out.push(s)

const env = new Map()
for (const ln of readFileSync(p, 'utf8').split(/\r?\n/)) {
  const m = ln.match(/^\s*([A-Z0-9_]+)\s*=/)
  if (!m) continue
  env.set(m[1], ln.slice(ln.indexOf('=') + 1).trim().replace(/^"|"$/g, ''))
}
const get = (k) => env.get(k) || ''
const calId = get('GOOGLE_CALENDAR_ID').trim()
const jsonRaw = get('GOOGLE_SERVICE_ACCOUNT_JSON').trim()
const sUrl = get('SUPABASE_URL') || get('NEXT_PUBLIC_SUPABASE_URL')
const sKey = get('SUPABASE_SERVICE_ROLE_KEY') || get('SUPABASE_ANON_KEY') || get('NEXT_PUBLIC_SUPABASE_ANON_KEY')

log('E0 CAL_ID=' + (calId && calId.includes('@') ? 'OK' : 'FAIL'))
let svc = null
try { svc = JSON.parse(jsonRaw) } catch (e) { log('E0 SVC_JSON_PARSE=FAIL ' + e.message) }

if (!svc || !svc.client_email || !svc.private_key) {
  log('E0 SVC_FIELDS=FAIL')
} else {
  log('E0 SVC_FIELDS=OK (client_email, private_key present)')
  let { JWT } = {}
  let api = null
  try {
    ;({ JWT } = await import('google-auth-library'))
    const { calendar } = await import('@googleapis/calendar')
    // Normalize key exactly like calendar.ts:96
    const key = (svc.private_key || '').replace(/\\n/g, '\n').trim()
    const auth = new JWT({ email: svc.client_email, key, scopes: ['https://www.googleapis.com/auth/calendar'] })
    api = calendar({ version: 'v3', auth })

    // P1 freebusy = proof of valid auth + valid calendar
    try {
      const fb = await api.freebusy.query({
        requestBody: { timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 3600e3).toISOString(), timeZone: 'America/Lima', items: [{ id: calId }] },
      }, { timeout: 8000 })
      const busy = fb.data.calendars?.[calId]?.busy || []
      log('P1 AUTH_FREEBUSY=OK busy=' + busy.length)
    } catch (e) {
      log('P1 AUTH_FREEBUSY=FAIL ' + e.message)
    }

    // P2 real event with Google Meet (hangoutsMeet, conferenceDataVersion 1)
    try {
      const st = new Date(); st.setMinutes(st.getMinutes() + 10, 0, 0)
      const en = new Date(st.getTime() + 15 * 60e3)
      const res = await api.events.insert({
        calendarId: calId,
        conferenceDataVersion: 1,
        requestBody: {
          summary: 'AUTOEVAL wacrm (borrar)',
          description: 'test autoevaluacion calendar',
          start: { dateTime: st.toISOString(), timeZone: 'America/Lima' },
          end: { dateTime: en.toISOString(), timeZone: 'America/Lima' },
          conferenceData: {
            createRequest: {
              requestId: Math.random().toString(36).slice(2, 14),
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        },
      }, { timeout: 8000 })
      const link = res.data.hangoutLink || ''
      log('P2 EVENT_CREATE=OK id=' + res.data.id)
      log('P2 MEET_LINK=' + (link.includes('meet.google.com') ? 'OK' : 'FAIL'))
      // cleanup: delete the event
      try {
        await api.events.delete({ calendarId: calId, eventId: res.data.id }, { timeout: 8000 })
        log('P2 EVENT_DELETE=OK (cleanup)')
      } catch (e) { log('P2 EVENT_DELETE=FAIL ' + e.message) }
    } catch (e) {
      log('P2 EVENT_CREATE=FAIL ' + e.message)
    }
  } catch (e) {
    log('P0 DEPS_IMPORT=FAIL ' + e.message)
  }
}

// P3 Supabase citas insert/delete
if (sUrl && sKey) {
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const db = createClient(sUrl, sKey)
    const now = new Date()
    const row = { account_id: 'selfcheck', contacto_id: null, google_event_id: 'selfcheck-msg', meet_link: null, fecha_inicio: now.toISOString(), fecha_fin: new Date(now.getTime() + 15 * 60e3).toISOString(), estado: 'confirmada' }
    const ins = await db.from('citas').insert(row).select('id').single()
    if (ins.error) { log('P3 CITA_INSERT=FAIL ' + ins.error.message) }
    else {
      log('P3 CITA_INSERT=OK id=' + ins.data.id)
      const del = await db.from('citas').delete().eq('id', ins.data.id)
      log('P3 CITA_DELETE=' + (del.error ? 'FAIL ' + del.error.message : 'OK (cleanup)'))
    }
  } catch (e) { log('P3 DB=FAIL ' + e.message) }
} else {
  log('P3 DB=SKIP (no supabase url/key en env)')
}

const rep = join(tmpdir(), `eval3_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.txt`)
writeFileSync(rep, out.join('\n') + '\n', 'utf8')
console.log('OUT=' + rep)
