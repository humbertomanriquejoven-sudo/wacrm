// selfcheck.cjs - one self-contained autoevaluación. CommonJS, no imports of
// repo internals, safe output (never prints secret VALUES). Pure ASCII.
//
// Usage:
//   node scripts/selfcheck.cjs "<abs path to .env.local>"
//
// Flujo:
//   1) Diagnóstico/en reparación del .env (reporta solo clave+estado, nunca el
//      valor; repara comillas colgantes impares y normaliza GOOGLE_SERVICE_ACCOUNT_JSON
//      a una sola línea sin reescribir el valor).
//   2) Google: JWT con la service-account -> freebusy (proof of auth) -> crear
//      evento REAL con Meet (conferenceDataVersion 1) -> capturar hangoutLink ->
//      BORRAR el evento. Imprime OK/FAIL en cada fase.
//   3) DB: intento insert+delete en tabla `citas` vía Supabase (si hay credenciales).
// Escribe un reporte ASCII a TEMP y hace echo de OUT=<path>.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function log(s) { out.push(s) }

let p = process.argv[2]
if (!p) { console.log('USAGE: node selfcheck.cjs <path/to/.env.local>'); process.exit(2) }
if (!fs.existsSync(p)) { console.log('ENV_FILE=MISSING ' + p); process.exit(1) }

const out = []
const KEY_RE = /^\s*([A-Z0-9_]+)\s*=/
const JSON_KEYS = new Set(['GOOGLE_SERVICE_ACCOUNT_JSON'])
const STRING_KEYS = new Set(['GOOGLE_CALENDAR_ID', 'GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL'])

let raw = fs.readFileSync(p, 'utf8')
let lines = raw.split(/\r?\n/)
let repaired = 0
let jsonState = 'ABSENT'

for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim()
  const nq = (t.match(/"/g) || []).length
  if (!t || t.startsWith('#')) { log(`L${i + 1} skip`); continue }
  const m = t.match(KEY_RE)
  if (!m) { log(`L${i + 1} WARN:no-key`); continue }
  const key = m[1]

  if (JSON_KEYS.has(key)) {
    let v = t.slice(t.indexOf('=') + 1).trim()
    let singleLine = !v.includes('\n')
    if (!singleLine) { v = v.replace(/\r?\n/g, ''); lines[i] = key + '=' + v; repaired++; log(`L${i + 1} REPAIR:${key}->single-line`) }
    let parsed = null
    try { parsed = JSON.parse(v) } catch {}
    if (parsed && typeof parsed === 'object') { jsonState = 'OK-valid'; log(`L${i + 1} OK:${key}`) }
    else { jsonState = 'FAIL-bad-json'; log(`L${i + 1} FAIL:${key} no-parse`) }
    continue
  }

  if (STRING_KEYS.has(key)) {
    if (nq === 1) { lines[i] = lines[i].replace(/"+$/, ''); repaired++; log(`L${i + 1} REPAIR:${key} strip-lone-quote`) }
    else { log(`L${i + 1} OK:${key}`) }
    continue
  }

  if (nq % 2 !== 0) { lines[i] = lines[i].replace(/"+$/, ''); repaired++; log(`L${i + 1} REPAIR:${key} rebalance`) }
  else { log(`L${i + 1} OK:${key}`) }
}

if (repaired > 0) fs.writeFileSync(p, lines.join('\n'), 'utf8')
log(`ENV summary: repaired=${repaired} json=${jsonState}`)

// ---- phase 2: Google (auth + real Meet event, then delete) ----
const envMap = new Map()
for (const l of lines) { const mm = l.match(KEY_RE); if (mm) envMap.set(mm[1], l.slice(l.indexOf('=') + 1).trim()) }
const calId = (envMap.get('GOOGLE_CALENDAR_ID') || '').replace(/^"|"$/g, '').trim()
if (envMap.get('GOOGLE_CALENDAR_ID')) envMap.set('GOOGLE_CALENDAR_ID', calId)

const jwtRequired = ['GOOGLE_SERVICE_ACCOUNT_JSON']
const missing = jwtRequired.filter((k) => !envMap.get(k))
log(`ENV present: GOOGLE_CALENDAR_ID=${calId ? 'YES' : 'NO'} GOOGLE_SERVICE_ACCOUNT_JSON=${envMap.get('GOOGLE_SERVICE_ACCOUNT_JSON') ? 'YES' : 'NO'} missing=${missing.length ? missing.join(',') : 'none'}`)

// Convertir el env a un objeto process.env-compatible (sin imprimir valores).
for (const [k, v] of envMap) { try { process.env[k] = /^"[\s\S]*"$/.test(v) ? JSON.parse(v) : v } catch { process.env[k] = v } }

import * as GOOGLE from '@googleapis/calendar'
import * as GAUTH from 'google-auth-library'
import * as SUPABASE from '@supabase/supabase-js'

async function googlePhase() {
  if (!GOOGLE || !GAUTH) { log('GOOGLE deps missing: FAIL'); return }
  const { calendar } = GOOGLE
  const { JWT } = GAUTH
  const svc = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}')
  log(`JSON keys: client_email=${svc.client_email ? 'YES' : 'NO'} private_key=${svc.private_key ? 'YES' : 'NO'}`)
  const auth = new JWT({
    email: svc.client_email,
    key: svc.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  })
  const calApi = calendar({ version: 'v3', auth })
  try {
    const fb = await calApi.freebusy.query({ requestBody: { timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 3600e3).toISOString(), timeZone: 'America/Lima', items: [{ id: calId }] } }, { timeout: 8000 })
    log(`AUTH freebusy: OK (${(fb.data.calendars?.[calId]?.busy || []).length} busy)`)
  } catch (e) { log(`AUTH freebusy: FAIL (${e.message})`); process.env.__AUTHFAIL = '1'; return }
  const start = new Date()
  start.setHours(start.getHours(), start.getMinutes() + 5, 0, 0)
  const end = new Date(start.getTime() + 15 * 60e3)
  try {
    const created = await calApi.events.insert({ calendarId: calId, conferenceDataVersion: 1, requestBody: { summary: 'SELFCHECK - borrar', description: 'auto-test wacrm', start: { dateTime: start.toISOString(), timeZone: 'America/Lima' }, end: { dateTime: end.toISOString(), timeZone: 'America/Lima' }, conferenceData: { createRequest: { requestId: Math.random().toString(36).slice(2), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } }, { timeout: 8000 })
    const link = created.data.hangoutLink || created.data.conferenceData?.entryPoints?.[0]?.uri || null
    log(`MEET link: ${link ? 'OK (' + (link.includes('meet.google.com') ? 'meet.google.com' : '?)') + ')' : 'FAIL (no hangoutLink)'}`)
    try { await calApi.events.delete({ calendarId: calId, eventId: created.data.id }) } catch (e) { log('MEET cleanup: FAIL (' + e.message + ')') }
  } catch (e) {
    log(`MEET create: FAIL (${e.message})`)
    let target = null
    try { target = (await calApi.events.list({ calendarId: calId, q: 'SELFCHECK', maxResults: 20, fields: 'items(id,summary)' })).data.items || [] } catch {}
    if (Array.isArray(target)) for (const it of target) { try { process.env.__DEL = it.id } catch {} }
  }
}

async function dbPhase() {
  if (!SUPABASE) { log('DB: SUPABASE-JS missing -> SKIP'); return }
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) { log('DB: credenciales no presentes -> SKIP (solo parseo .env)'); return }
  const client = SUPABASE.createClient(url, key)
  const now = new Date()
  const row = { account_id: 'selfcheck', contacto_id: null, google_event_id: 'selfcheck-' + now.getTime(), fecha_inicio: now.toISOString(), fecha_fin: new Date(now.getTime() + 15 * 60e3).toISOString(), estado: 'confirmada' }
  try {
    const { data, error } = await client.from('citas').insert(row).select('id').single()
    if (error) { log('DB insert citas: FAIL (' + error.message + ')'); return }
    log('DB insert citas: OK (id=' + (data?.id || '?') + ')')
    const { error: delErr } = await client.from('citas').delete().eq('id', data.id)
    log(`DB delete test row: ${delErr ? 'FAIL (' + delErr.message + ')' : 'OK'}`)
  } catch (e) { log('DB insert citas: FAIL (' + e.message + ')') }
}

;(async () => {
  await googlePhase()
  if (!process.env.__AUTHFAIL) await dbPhase()
  const rep = path.join(os.tmpdir(), `selfcheck_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.txt`)
  fs.writeFileSync(rep, out.join('\n') + '\n', 'utf8')
  console.log('OUT=' + rep)
})().catch((e) => { console.log('OUT=ERR:' + e.message) })
