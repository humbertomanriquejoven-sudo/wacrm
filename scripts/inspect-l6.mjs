// inspect-l6.mjs - describe the SHAPE of one line of .env.local as booleans
// and lengths only, never its content. ASCII. Writes OUT=<path>.
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const filePath = process.argv[2]
const target = Number(process.argv[3] || 6)
const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
const r = []
const log = (s) => r.push(s)

if (lines.length < target) {
  log(`L${target} ABSENT total=${lines.length}`)
} else {
  const t = lines[target - 1].trim()
  log(`L${target} trimmed_len=${t.length}`)
  log(`L${target} is_lone_quote=${t === '"'}`)
  log(`L${target} starts_quote=${t.startsWith('"')} ends_quote=${t.endsWith('"')}`)
  const nq = (t.match(/"/g) || []).length
  log(`L${target} quote_count=${nq}`)
  log(`L${target} has_equals=${t.includes('=')}`)
  log(`L${target} is_comment=${t.startsWith('#') || t.startsWith(';') || t.startsWith('//')}`)
  log(`L${target} alnum_count=${(t.match(/[A-Za-z0-9]/g) || []).length}`)
}

const rep = join(tmpdir(), `l6_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.txt`)
writeFileSync(rep, r.join('\n'), 'utf8')
console.log('OUT=' + rep)
