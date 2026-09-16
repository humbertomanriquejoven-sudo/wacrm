// Reports NON-secret structural facts about the private_key body in
// .env.local: length, char set, the standard RSA-2048 PKCS#8 marker prefix
// (MIIEv...), decode-byte estimate attempt. Never prints the key itself.
// ASCII. OUT=<temp>.
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const envPath = process.argv[2]
const out = []
const log = (s) => out.push(s)

const env = new Map()
for (const ln of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = ln.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/)
  if (m) env.set(m[1], m[2].trim())
}
const getV = (k) => {
  const v = env.get(k) || ''
  const t = v.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1)
  return t
}

const canonical = (raw) => {
  let s = (raw ?? '').replace(/\\n/g, '\n').trim()
  const b = s.indexOf('-----BEGIN')
  const e = s.indexOf('-----END')
  if (b === -1 || e === -1 || e < b) return s.replace(/\s+/g, ' ')
  const hdr = s.slice(b, s.indexOf('\n', b) === -1 ? b + '-----BEGIN PRIVATE KEY-----'.length : s.indexOf('\n', b)).trim()
  const ftr = s.slice(e, s.indexOf('\n', e) === -1 ? s.length : s.indexOf('\n', e)).trim()
  const body = s.slice(b + hdr.length, e).replace(/\s+/g, '')
  const lines = body.match(/.{1,64}/g) ?? []
  return `${hdr}\n${lines.join('\n')}\n${ftr}`
}

let svcJson = null
try { svcJson = JSON.parse(getV('GOOGLE_SERVICE_ACCOUNT_JSON')) } catch (e) { log('SVC_PARSE=FAIL ' + e.message) }

if (svcJson && svcJson.private_key) {
  const key = canonical(svcJson.private_key)
  log('KEY_LEN=' + key.length)
  log('KEY_HAS_MARKERS=' + (key.includes('-----BEGIN') && key.includes('-----END') ? 'YES' : 'NO'))
  const body = key.slice(key.indexOf('-----BEGIN') + key.slice(key.indexOf('-----BEGIN')).indexOf('\n') + 1, key.indexOf('-----END')).replace(/\s+/g, '')
  log('BODY_LEN=' + body.length)
  log('BODY_PREFIX=' + body.slice(0, 20))
  log('BODY_STD_PREFIX=' + (body.startsWith('MIIEvwIBADANBgkqhkiG9w0BAQEF') ? 'STANDARD_RSA2048_PKCS8' : 'NOT_STANDARD'))
  const alpha = (body.match(/[A-Za-z0-9+/]/g) || []).length
  const pad = (body.match(/=/g) || []).length
  const other = body.length - alpha - pad
  const b64 = (body.match(/[A-Za-z0-9+/=]/g) || []).length
  log('BODY_ALPHA=' + alpha + ' PAD=' + pad + ' OTHER=' + other + ' TOTAL=' + body.length)
  log('BODY_VALID_B64=' + (body.length === b64 ? 'YES' : 'NO'))
  const asym = (c) => body.split(c).length - 1
  for (const c of [' ', '\n', '\t', '\r']) log('BODY_CH_' + (c === '\n' ? 'NL' : c === '\t' ? 'TAB' : c === '\r' ? 'CR' : 'SP') + '=' + asym(c))
  const dup = body.match(/(BEGIN|END|PRIVATE)/g) || []
  log('KEYWORD_HITS=' + dup.length)
} else {
  log('NO_KEY')
}

const rep = join(tmpdir(), 'kb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + '.txt')
writeFileSync(rep, out.join('\n') + '\n', 'utf8')
console.log('OUT=' + rep)
