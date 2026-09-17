// calendar-selfeval.mjs - autoevaluacion real (Google API + Meet + cleanup).
// ASCII. MIGRADO A OAuth2: si estan GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/
// GOOGLE_REFRESH_TOKEN usa OAuth2Client (permite crear Meet REAL con
// hangoutsMeet en calendarios personales). Si no estan, reporta OAUTH_KEYS=NO
// y cae al camino JWT (service-account, sin Meet - documentado).
// Normaliza private_key como calendar.ts. Borra SIEMPRE el evento/fila.
// OUT=<temp>. Nunca imprime valores.
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const envPath = process.argv[2]
if (!envPath) { console.log('USAGE: node calendar-selfeval.mjs <path/to/.env.local>'); process.exit(2) }
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
  if (t.startsWith('"')) return t.slice(1).replace(/"$/, '')
  return t
}
const calId = envGet('GOOGLE_CALENDAR_ID')

const clientId = envGet('GOOGLE_CLIENT_ID')
const clientSecret = envGet('GOOGLE_CLIENT_SECRET')
const refreshToken = envGet('GOOGLE_REFRESH_TOKEN')
const hasOAuth = Boolean(clientId && clientSecret && refreshToken)
log('OAUTH_KEYS=' + (hasOAuth ? 'YES' : 'NO'))

function canonicalizePrivateKey(raw) {
  let s = (raw ?? '').replace(/\\n/g, '\n').replace(/\\n/g, '\n').trim()
  const begin = s.indexOf('-----BEGIN')
  const end = s.indexOf('-----END')
  if (begin === -1 || end === -1 || end < begin) {
    return s.replace(/\s+/g, ' ').trim()
  }
  const header = s.slice(begin, s.indexOf('\n', begin) === -1 ? s.length : s.indexOf('\n', begin)).trim()
  const footer = s.slice(end, s.indexOf('\n', end) === -1 ? s.length : s.indexOf('\n', end)).trim()
  const body = s.slice(begin + header.length, end).replace(/\s+/g, '')
  const body2 = /^[A-Za-z0-9+/]+={0,2}$/.test(body) ? body : body.replace(/[^A-Za-z0-9+/=_]/g, '')
  const lines = (body2.match(/.{1,64}/g) ?? [body2]).filter(Boolean)
  return `${header}\n${lines.join('\n')}\n${footer}`
}

let svc = null
try { svc = JSON.parse(envGet('GOOGLE_SERVICE_ACCOUNT_JSON')) } catch (e) { log('SVC_PARSE=FAIL ' + e.message) }

async function main() {
  let deps = {}
  try {
    deps = {
      calendar: (await import('@googleapis/calendar')).calendar,
      OAuth2Client: (await import('google-auth-library')).OAuth2Client,
      JWT: (await import('google-auth-library')).JWT,
    }
    log('DEPS=OK')
  } catch (e) { log('DEPS=FAIL ' + e.message); return }

  // ---- auth: OAuth2 si disponible, si no JWT service-account ----
  let api
  if (hasOAuth) {
    try {
      const oauth = new deps.OAuth2Client({ clientId, clientSecret })
      oauth.setCredentials({ refresh_token: refreshToken })
      api = deps.calendar({ version: 'v3', auth: oauth })
          log(`AUTH_MODE=OAUTH2 calId=${calId ? 'YES' : 'NO'}`)
    } catch (e) { log('AUTH_OAUTH2=FAIL ' + e.message); return }
  } else if (svc && svc.client_email && svc.private_key) {
    try {
      const key = canonicalizePrivateKey(svc.private_key)
      log('KEY_NORM=OK len=' + key.length + ' header=' + (key.startsWith('-----BEGIN') ? 'PEM_OK' : 'PEM_BAD'))
      const jwt = new deps.JWT({ email: svc.client_email, key, scopes: ['https://www.googleapis.com/auth/calendar'] })
      api = deps.calendar({ version: 'v3', auth: jwt })
          log('AUTH_MODE=JWT (sin OAuth2 keys; Meet NO disponible)')
    } catch (e) { log('AUTH_JWT=FAIL ' + e.message); return }
  } else {
    log('AUTH=NONE (ni OAuth2 ni service-account)')
    return
  }

  // P1 auth+freebusy
  try {
    const fb = await api.freebusy.query({ requestBody: { timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 3600e3).toISOString(), timeZone: 'America/Bogota', items: [{ id: calId }] } }, { timeout: 8000 })
    const busy = fb.data.calendars?.[calId]?.busy || []
    log('P1 AUTH_FREE_BUSY=OK busy=' + busy.length)
  } catch (e) { log('P1 AUTH_FREE_BUSY=FAIL ' + e.message) }

  // P2 crear evento; con OAuth2 pedimos Meet real (hangoutsMeet)
  try {
    const st = new Date(); st.setMinutes(st.getMinutes() + 10, 0, 0)
    const en = new Date(st.getTime() + 15 * 60e3)
    const wantMeet = hasOAuth
    const conferenceData = wantMeet ? { createRequest: { requestId: Math.random().toString(36).slice(2), conferenceSolutionKey: { type: 'hangoutsMeet' } } } : undefined
    const created = await api.events.insert({ calendarId: calId, conferenceDataVersion: wantMeet ? 1 : 0, requestBody: { summary: 'AUTOEVAL wacrm', description: 'test autoevaluacion oauth', start: { dateTime: st.toISOString(), timeZone: 'America/Bogota' }, end: { dateTime: en.toISOString(), timeZone: 'America/Bogota' }, ...(wantMeet ? { conferenceData } : {}) } }, { timeout: 8000 })
    log('P2 EVENT_CREATE=OK id=' + created.data.id)
    if (wantMeet) {
      const link = created.data.hangoutLink || created.data.conferenceData?.entryPoints?.[0]?.uri || null
      log('P2 HANGOUT=' + (link && link.includes('meet.google.com') ? 'OK ' + 'link_es_meet' : 'FAIL (sin hangoutLink)'))
    } else {
      log('P2 HANGOUT=SIN_MEET_MODE (sin claves OAuth2)')
    }
    if (created.data.id) {
      try {
        await api.events.delete({ calendarId: calId, eventId: created.data.id }, { timeout: 8000 })
        log('P2 EVENT_DELETE=OK (cleanup)')
      } catch (e) { log('P2 EVENT_DELETE=FAIL ' + e.message) }
    }
  } catch (e) {
    log('P2 EVENT_CREATE=FAIL ' + e.message)
  }
  if (out.some((l) => l.includes('EVENT_CREATE=OK')) && svc && deps.JWT) {
    // Con OAuth2 no hay test de DB supabase aqui (no es el foco). Se deja log.
    log('P3_DB=SKIP (fuera de alcance de calendar-selfeval)')
  }
}

main().catch((e) => log('MAIN=FAIL ' + e.message)).finally(() => {
  const rep = join(tmpdir(), 'ces2_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + '.txt')
  writeFileSync(rep, out.join('\n') + '\n', 'utf8')
  console.log('OUT=' + rep)
})
