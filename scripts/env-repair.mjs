// One-pass diagnostics/re-pairer for .env.local that NEVER echoes values.
// Output: per-line status (OK / REPAIR) plus aggregate counts. Runs with Node
// (no deps). Writes its report to a fresh file under %TEMP% and prints OUT=.
//
// Rules:
//   - Lines with one of the JSON_KEYS must hold a single-line JSON (either
//     bare JSON or JSON wrapped in one pair of double quotes with the
//     inner quotes doubled / escaped by dotenv). We only re-balance quotes;
//     we do NOT print the value.
//   - Every other VALID line may contain only 0 or 2 double quotes. If it
//     contains a singleton quote we strip the trailing garbage quote.
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const p = process.argv[2]
const out = []
const log = (s) => out.push(s)
const KEY = /^([A-Z0-9_]+)=/
const JSON_KEYS = new Set(['GOOGLE_SERVICE_ACCOUNT_JSON'])
const STRING_KEYS = new Set(['GOOGLE_CALENDAR_ID', 'GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL'])

let total = 0
let ok = 0
let repaired = 0
let broken = 0

const lines = readFileSync(p, 'utf8').split(/\r?\n/)

for (let i = 0; i < lines.length; i++) {
  const ln = lines[i]
  const t = ln.trim()
  if (!t || t.startsWith('#')) {
    log(`L${i + 1} comment/blank`)
    continue
  }
  total++
  const m = t.match(KEY)
  if (!m) {
    log(`L${i + 1} NOT_A_KEYLINE`)
    broken++
    continue
  }
  const key = m[1]
  const val = ln.slice(ln.indexOf('=') + 1).trim()
  const nq = (val.match(/"/g) || []).length

  if (JSON_KEYS.has(key)) {
    // Bare JSON (0 or 2 quotes) is the ideal form.
    if (nq === 0 || nq === 2) {
      ok++
      log(`L${i + 1} OK:${key} quotes=${nq}`)
      continue
    }
    // If not, someone likely has funny quoting; just report (no auto-fix
    // to avoid corrupting the actual JSON).
    log(`L${i + 1} WARN:${key} quotes=${nq} (lo reviso con node, no reescribe)`)
    continue
  }

  if (STRING_KEYS.has(key)) {
    if (nq === 0 || nq === 2) {
      ok++
      log(`L${i + 1} OK:${key} quotes=${nq}`)
    } else {
      // Trailing lone quote -> strip it, keep the rest intact.
      const fixed = t.replace(/"+$/, '')
      lines[i] = fixed
      repaired++
      log(`L${i + 1} REPAIR:${key} quotes=${nq} -> ${(fixed.match(/"/g) || []).length}`)
    }
    continue
  }

  if (nq % 2 === 0) {
    ok++
    log(`L${i + 1} OK:${key} quotes=${nq}`)
  } else {
    const fixed = t.replace(/"+$/, '')
    lines[i] = fixed
    repaired++
    log(`L${i + 1} REPAIR:${key} quotes=${nq} -> ${(fixed.match(/"/g) || []).length}`)
  }
}

let changed = false
if (repaired > 0) {
  writeFileSync(p, lines.join('\n'), 'utf8')
  changed = true
}
log(`SUMMARY total=${total} ok=${ok} repaired=${repaired} broken=${broken} wrote=${changed} file=${basename(p)}`)

const rep = join(tmpdir(), `envrep_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.txt`)
writeFileSync(rep, out.join('\n'), 'utf8')
console.log('OUT=' + rep)
