// del-lone-quote.mjs - READ .env.local; for EACH line whose trimmed content is
// EXACTLY a single double-quote char, delete that line. Report indexes removed
// (never values). Writes .env.local back ONLY if something was removed.
// ASCII only. OUT=<path> to a TEMP file that holds the report.
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const p = process.argv[2]
const raw = readFileSync(p, 'utf8')
const lines = raw.split(/\r?\n/)
const removedAt = []
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === '"') removedAt.push(i + 1)
}
if (removedAt.length > 0) {
  const kept = lines.filter((l) => l.trim() !== '"')
  writeFileSync(p, kept.join('\n'), 'utf8')
}
const rep = []
rep.push('REMOVED_AT=' + (removedAt.length ? removedAt.join(',') : 'none'))
rep.push('REMOVED_COUNT=' + removedAt.length)
rep.push('LINES_BEFORE=' + lines.length)
rep.push('LINES_AFTER=' + (removedAt.length ? lines.length - removedAt.length : lines.length))
rep.push('KEY_COUNT_AFTER=' + ((removedAt.length ? lines.filter((l) => l.trim() !== '"') : lines).filter((t) => /^[A-Z0-9_]+=/.test(t.trim())).length))
const out = join(tmpdir(), `dlq_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.txt`)
writeFileSync(out, rep.join('\n'), 'utf8')
console.log('OUT=' + out)
