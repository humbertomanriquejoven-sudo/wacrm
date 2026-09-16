// Repair + diagnostics for .env.local (Google Calendar / Service Account).
// ASCII-only output, never prints secret values.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const p = join(root, '.env.local')
const out = []
const log = (s) => out.push(s)

if (!existsSync(p)) {
  log('ENV_FILE=MISSING')
  process.stdout.write(out.join('\n') + '\n')
  process.exit(1)
}

let raw = readFileSync(p, 'utf8')
let lines = raw.split(/\r?\n/)
let changed = 0
let badQuote = 0
let badJson = 0

const KEY = /^\s*([A-Z0-9_]+)\s*=/

// Known keys whose value contains a double-quoted JSON blob (may legitimately
// contain quotes + escaped chars). We treat these specially.
const JSON_KEYS = new Set(['GOOGLE_SERVICE_ACCOUNT_JSON'])
// Keys whose value must be a plain quoted string (exactly 0 or 2 double quotes).
const OAUTH_KEYS = new Set(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'])

const STRING_KEYS = new Set([
  'GOOGLE_CALENDAR_ID',
  'GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL',
])

for (let i = 0; i < lines.length; i++) {
  const ln = lines[i]
  if (!ln.trim() || ln.trim().startsWith('#')) {
    log(`L${i + 1} SKIP (blank/comment)`)
    continue
  }
  const m = ln.match(KEY)
  if (!m) {
    log(`L${i + 1} NORAW (no key)`)
    badQuote++
    continue
  }
  const key = m[1]
  const val = ln.slice(ln.indexOf('=') + 1).trim()
  const nQuote = (val.match(/"/g) || []).length

  if (JSON_KEYS.has(key)) {
    let jsonOk = false
    try {
      const stripped = val.startsWith('"') && val.endsWith('"') ? JSON.parse(val) : val
      const parsed = typeof stripped === 'string' ? JSON.parse(stripped) : stripped
      jsonOk = parsed && typeof parsed === 'object'
    } catch {
      jsonOk = false
    }
    if (!jsonOk) {
      log(`L${i + 1} JSON_INVALID key=${key} quoteCount=${nQuote} len=${val.length}`)
      badJson++
    } else {
      log(`L${i + 1} JSON_OK key=${key} len=${val.length}`)
    }
    continue
  }

  if (OAUTH_KEYS.has(key)) {
    const ov = val.replace(/^"|"$/g, '').trim()
    let fmt = 'OK'
    if (!ov) fmt = 'EMPTY'
    else if (key === 'GOOGLE_CLIENT_ID' && !/^\d{6,}-[A-Za-z0-9_.-]+$/.test(ov)) fmt = 'FORMAT_ID'
    else if (key === 'GOOGLE_CLIENT_SECRET' && ov.length < 12) fmt = 'SHORT_SECRET'
    else if (key === 'GOOGLE_REFRESH_TOKEN' && !/^[A-Za-z0-9._-]{6,}$/.test(ov)) fmt = 'FORMAT_REFRESH'
    if (fmt !== 'OK') { log(`L${i + 1} OAUTH:${key}=${fmt} len=${ov.length}`); changed++ } else { log(`L${i + 1} OAUTH:${key}=OK len=${ov.length}`) }
    continue
  }

  if (STRING_KEYS.has(key)) {
    const ok = nQuote === 0 || nQuote === 2
    if (!ok) {
      log(`L${i + 1} QUOTE_ODD key=${key} quoteCount=${nQuote} --- FIXING`)
      // repair: strip any dangling double quotes
      lines[i] = ln.replace(/"+$/, '').trimEnd()
      changed++
    } else {
      log(`L${i + 1} OK key=${key} quoteCount=${nQuote}`)
    }
    continue
  }

  // generic: balanced quotes required
  if (nQuote % 2 !== 0) {
    log(`L${i + 1} QUOTE_ODD generic key=${key} quoteCount=${nQuote} --- FIXING`)
    lines[i] = ln.replace(/"+$/, '').trimEnd()
    changed++
  } else {
    log(`L${i + 1} OK key=${key} quoteCount=${nQuote}`)
  }
}

if (changed > 0) {
  writeFileSync(p, lines.join('\n'), 'utf8')
  log(`REPAIRED_LINES=${changed}`)
} else {
  log('REPAIRED_LINES=0')
}
log(`SUMMARY badQuote=${badQuote} badJson=${badJson} totalLines=${lines.length}`)

const outFile = join(process.env.TEMP, `renv_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`)
writeFileSync(outFile, out.join('\n'), 'utf8')
process.stdout.write('OUT=' + outFile + '\n')
