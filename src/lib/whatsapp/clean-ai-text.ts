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
