/**
 * Raw wall-clock / timestamp tokens that only a tool's internal output (or
 * the model echoing it) would produce and the customer must NEVER see:
 * system time reads like "17:32:11 -05:00" or ISO 8601 datetimes like
 * "2026-09-17T17:32:11-05:00". The WhatsApp reply is stripped of them so
 * the outgoing bubble carries ONLY the final, natural text the AI redacted
 * for the customer. Friendly values — a date-only "2026-09-18" or a
 * wall-clock "14:00" without seconds/offset — are legitimate human times
 * and are left untouched.
 */
const RAW_TIMESTAMP_RES: RegExp[] = [
  // ISO 8601 datetime with a timezone designator (with or without seconds):
  //   2026-09-17T15:00:00-05:00 / 2026-09-17T15:00Z / 2026-09-17T15:00:00Z
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/g,
  // Wall-clock read with a timezone offset: "17:32:11 -05:00" / "17:32:11-05:00"
  /\b\d{1,2}:\d{2}:\d{2}\s*[+-]\d{2}:\d{2}\b/g,
]

/**
 * Remove every raw timestamp token from a reply and tidy the leftovers so
 * no empty, colon/comma-only remnants reach WhatsApp. Only lines that
 * actually carried a raw timestamp are cleaned — untouched lines (e.g. a
 * confirmation ending in "enlace:") are left byte-for-byte intact. A reply
 * that was ONLY a raw timestamp becomes an empty string.
 */
export function stripRawTimestamps(raw: string): string {
  const text = raw ?? ''
  const inLine = (line: string) =>
    RAW_TIMESTAMP_RES.some((re) => {
      re.lastIndex = 0
      return re.test(line)
    })
  const keptLines: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!inLine(line)) {
      keptLines.push(line)
      continue
    }
    let cleaned = line
    for (const re of RAW_TIMESTAMP_RES) {
      re.lastIndex = 0
      cleaned = cleaned.replace(re, '')
    }
    const tidy = cleaned
      // Collapse separator pairs left when the timestamp sat between commas.
      .replace(/[:,]\s*[:,]/g, ', ')
      .replace(/[\s,;:]+$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    if (tidy) keptLines.push(tidy)
  }
  return keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Cleans the raw text produced by the WhatsApp AI before it is split into
 * bubbles and delivered to the customer.
 *
 * Some models decorate their answer with editing-style scaffolding the
 * customer must never see: numbered part labels ("Mensaje 1:", "Mensaje 2:",
 * "*Mensaje N:*"), whole-reply emphasis markers, and an enclosing pair of
 * quotes. Each pass below is a small explicit RegExp so the exact behaviour
 * is easy to test and reason about.
 */
export function cleanAiReplyText(raw: string): string {
  let text = raw ?? ''

  // 0) Drop raw timestamps / system timezone reads before anything else so
  //    they can never be carried by a bubble.
  text = stripRawTimestamps(text)

  // 1) Drop a leading "Mensaje N:" / "*Mensaje N:*" / "Mensaje N -" label on
  //    every line (the model sometimes prefixes each WhatsApp bubble).
  text = text
    .split(/\r?\n/)
    .map((line) =>
      line.replace(/^\s*\*?Mensaje\s*\d*\s*[:.:-]\s*\*?/, '')
    )
    .join('\n')

  // 2) Remove surrounding emphasis markers ("*...*" / "**...**") around the
  //    whole message.
  text = text.replace(/^\s*\*+/, '').replace(/\*+\s*$/, '')

  // 3) Unwrap an enclosing pair of double/single quotes if they wrap the
  //    entire reply (models sometimes add them to "quote" the answer).
  const trimmed = text.trim()
  if (/^"[^"]*"$/.test(trimmed) || /^'[^']*'$/.test(trimmed)) {
    text = trimmed.slice(1, -1)
  }

  // 4) Collapse 3+ blank lines into one, then trim.
  text = text.replace(/\n{3,}/g, '\n\n').trim()

  return text
}
