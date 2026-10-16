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
 * Markup that only ever reaches a reply when the model echoes raw
 * tool/system output, and that no customer may ever see:
 *  - the scheduling tools' machine trailer
 *    `JSON_RESULT (no lo repitas en el mensaje al cliente): {...}`,
 *  - a fenced code block (```…```),
 *  - tool-call scaffolding printed as text ("step_0:", "print(...)",
 *    a "tool_calls:" dump).
 */
const TECHNICAL_MARKUP_RES: RegExp[] = [
  /JSON_RESULT[^\n]*/gi,
  /```[\s\S]*?```/g,
  /\bstep_\d+\s*:[^\n]*/gi,
  /\bprint\s*\([^\n]*\)/gi,
  /\btool_calls?\s*[:=][^\n]*/gi,
]

/**
 * A whole message that is unambiguously a machine value rather than human
 * prose: a bare number (optionally a float, e.g. a leaked epoch like
 * "1653781000.0"), an ISO instant, a UUID, or an empty JSON object/array.
 * A bubble made ONLY of such a token is a leaked tool/system value — the
 * customer sees a naked number instead of an answer — and must never be
 * sent. Deliberately conservative: the numeric case requires eight or more
 * digits so an ordinary short quantity ("3", "45", "2026") is never
 * mistaken for a leak.
 */
const BARE_NUMBER_ONLY = /^[-+]?\d{8,}(?:[.,]\d+)?$/
const ISO_INSTANT_ONLY =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i
const UUID_ONLY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMPTY_JSON_ONLY = /^[{}[\],\s]*$/

/** True when the whole message is a lone machine token (never human prose). */
export function isTechnicalOnlyMessage(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  return (
    BARE_NUMBER_ONLY.test(t) ||
    ISO_INSTANT_ONLY.test(t) ||
    UUID_ONLY.test(t) ||
    EMPTY_JSON_ONLY.test(t)
  )
}

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

  // 0b) Drop raw tool/system markup (the scheduling tools' JSON_RESULT
  //     trailer, code fences, tool-call scaffolding). This is the ONLY
  //     place a leaked JSON_RESULT or a naked tool payload is removed, so
  //     it runs before the cosmetic passes below.
  for (const re of TECHNICAL_MARKUP_RES) {
    re.lastIndex = 0
    text = text.replace(re, '')
  }

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

  // 5) Drop every LINE that is ONLY a machine token (a leaked epoch such as
  //    "1653781000.0", an ISO instant, a UUID, an empty JSON payload). A
  //    stray system value must never survive inside an otherwise valid reply.
  text = text
    .split(/\r?\n/)
    .filter((line) => !isTechnicalOnlyMessage(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // 6) If the WHOLE reply was such a token, the model produced nothing the
  //    customer may see: return empty so the caller never leaks it (the
  //    auto-reply path turns this into a neutral acknowledgement instead of
  //    going silent).
  if (isTechnicalOnlyMessage(text)) return ''

  return text
}
