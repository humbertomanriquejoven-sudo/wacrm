const p = process.argv[2]
let raw
try { raw = import('node:fs').then(fs => fs.readFileSync(p, 'utf8')) } catch { process.exit(3) }
const fs = await import('node:fs')
raw = fs.readFileSync(p, 'utf8')
const lines = raw.split(/\r?\n/)
const ln = lines[5] ?? ''          // L6
const t = ln.trim()
const shape = {
  line6_exists: lines.length >= 6,
  line6_trimmed_eq_double_quote: t === '"',
  line6_trimmed_empty: t === '',
  line6_char_count: ln.length,
  line6_first4: t.slice(0, 4),
  line6_last4: t.slice(-4),
  line6_has_equals: t.includes('='),
}
await(async () => {})()
console.log('SHAPE=' + JSON.stringify(shape))
