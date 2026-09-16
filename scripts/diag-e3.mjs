// diag-e3.mjs - inspect STRUCTURE of GOOGLE_SERVICE_ACCOUNT_JSON in .env.local
// WITHOUT printing values. ASCII. OUT=<temp>.
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

let svc = null
const raw = envGet('GOOGLE_SERVICE_ACCOUNT_JSON')
log('SVC_RAW_LEN=' + raw.length)
try {
  svc = JSON.parse(raw)
  log('SVC_PARSE=OK')
} catch (e) {
  log('SVC_PARSE=FAIL ' + e.message)
  finish()
}

log('SVC_CLIENT_EMAIL=' + (svc.client_email && svc.client_email.includes('@') ? 'OK' : 'FAIL'))
if (svc.private_key) {
  const k = svc.private_key
  log('SVC_PRIVATE_KEY_LEN=' + k.length)
  log('SVC_K_HAS_REAL_NEWLINE=' + (k.includes('\n') ? 'YES' : 'NO'))
  log('SVC_K_HAS_BS_N=' + (k.includes('\\n') ? 'YES' : 'NO'))
  log('SVC_K_HAS_DOUBLE_BS_N=' + (k.includes('\\\\n') ? 'YES' : 'NO'))
  log('SVC_K_HAS_CR=' + (k.includes('\r') ? 'YES' : 'NO'))
  const bad = (k.match(/[^A-Za-z0-9+/=_\-\n]/g) || []).slice(0, 20)
  log('SVC_K_BAD_BASE64_CHARS=' + (bad.length ? bad.map((c) => c === '\n' ? '<NL>' : c === '\r' ? '<CR>' : c === ' ' ? '<SP>' : JSON.stringify(c)).join('') : 'none'))
  const alpha = (k.match(/[A-Za-z0-9+/=]/g) || []).length
  log('SVC_K_BASE64_ALPHA_COUNT=' + alpha)
} else {
  log('SVC_PRIVATE_KEY=FAIL')
}
finish()

function finish() {
  const rep = join(tmpdir(), `de3_${Date.now()}_${Math.random().toString(36).slice(2, 10) + ''}.txt`)
  writeFileSync(rep, out.join('\n') + '\n', 'utf8')
  console.log('OUT=' + rep)
}
