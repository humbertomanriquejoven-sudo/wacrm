// envfix.mjs - one-pass repairer for .env.local with NO dependency on the
// heredoc channel. ASCII-only output. NEVER prints secret values.
//
// What it does:
//   1. Reads .env.local with dotenv-compatible parsing intent.
//   2. For each key=value line:
//      - GOOGLE_SERVICE_ACCOUNT_JSON: if value is NOT a valid JSON in the
//        file, re-serialize from a parsed object OR, if it is already valid
//        single-line JSON, leave it. If it is multi-line raw JSON we
//        re-serialize to a single line.
//      - strings (CALENDAR_ID etc.): strip a singleton trailing '"'.
//   3. Ensures GOOGLE_CALENDAR_ID is present; if not, appends it.
//   4. Writes a report of line numbers + status to a fresh file in TEMP and
//      prints OUT=<path>. Script itself also rewrites .env.local if changes
//      were needed (best effort, no value echo).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const p = process.argv[2]
if (!p || !existsSync(p)) {
  console.log('OUT=ERR:no-file')
  process.exit(1)
}

const out = []
const log = (s) => out.push(s)

let raw = readFileSync(p, 'utf8')
let lines = raw.split(/\r?\n/)
let changed = 0

const KEY_RE = /^([A-Za-z0-9_]+)=/
const JSON_KEY = 'GOOGLE_SERVICE_ACCOUNT_JSON'
const STRING_KEYS = new Set(['GOOGLE_CALENDAR_ID', 'GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL'])

const tryParseJson = (val) => {
  let v = val
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      v = JSON.parse(v)
    } catch {
      v = val
    }
  }
  if (typeof v !== 'string') return null
  try {
    const o = JSON.parse(v)
    if (o && typeof o === 'object' && !Array.isArray(o)) return o
  } catch {
    return null
  }
  return null
}

let hasCalId = false

for (let i = 0; i < lines.length; i++) {
  const ln = lines[i]
  const t = ln.trim()
  if (!t || t.startsWith('#')) {
    log(`L${i + 1} skip`)
    continue
  }
  const m = t.match(KEY_RE)
  if (!m) {
    log(`L${i + 1} WARN:no-key (se deja)`)
    continue
  }
  const key = m[1]
  const eq = ln.indexOf('=')
  const val = ln.slice(eq + 1)
  const nq = (val.match(/"/g) || []).length

  if (key === JSON_KEY) {
    const parsed = tryParseJson(val.trim())
    if (parsed) {
      if (val.trim().split(/\r?\n/).length === 1) {
        log(`L${i + 1} OK:${key} single-line-json`)
      } else {
        // multi-line raw JSON -> single line
        lines[i] = `${key}=${JSON.stringify(val.trim())}`
        changed++
        log(`L${i + 1} REPAIR:${key} -> single-line`)
      }
    } else {
      log(`L${i + 1} WARN:${key} no-json (sin tocar)`)
    }
    continue
  }

  if (STRING_KEYS.has(key)) {
    if (key === 'GOOGLE_CALENDAR_ID') hasCalId = true
    if (nq === 1) {
      lines[i] = ln.replace(/"+$/, '')
      changed++
      log(`L${i + 1} REPAIR:${key} strip-lone-quote`)
    } else if (nq === 0 || nq === 2) {
      log(`L${i + 1} OK:${key}`)
    } else {
      log(`L${i + 1} WARN:${key} quotes=${nq} (sin tocar)`)
    }
    continue
  }

  if (nq % 2 !== 0) {
    lines[i] = ln.replace(/"+$/, '')
    changed++
    log(`L${i + 1} REPAIR:${key} rebalance-quotes`)
  } else {
    log(`L${i + 1} OK:${key}`)
  }
}

if (!hasCalId) {
  lines.push('GOOGLE_CALENDAR_ID="hma.arquitectura@gmail.com"')
  changed++
  log('APPEND GOOGLE_CALENDAR_ID')
}

if (changed > 0) {
  writeFileSync(p, lines.join('\n'), 'utf8')
}

log(`SUMMARY changed=${changed} totalLines=${lines.length}`)

const rep = join(
  process.env.TEMP,
  `envfix_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.txt`,
)
writeFileSync(rep, out.join('\n'), 'utf8')
console.log('OUT=' + rep)
