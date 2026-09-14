// ============================================================
// AI-reply fragmentation for WhatsApp.
//
// Parses the raw assistant text into at most 3 natural WhatsApp
// messages. Paragraphs (separated by double newlines) become their own
// bubbles so a multi-part reply reads like a conversation instead of a
// wall of text. Overflow paragraphs are merged into the final message
// so a long reply never spams the customer with more than 3 texts.
// Pure + deterministic — trivially testable and stable across runs.
// ============================================================

export const MAX_AI_REPLY_MESSAGES = 3

/**
 * Split an AI reply into WhatsApp-sized fragments.
 *
 *   - Splits on double newlines (`\n\n`, collapsed across blank lines,
 *     CRLF normalized first).
 *   - Returns at most `MAX_AI_REPLY_MESSAGES` parts: when the reply has
 *     more paragraphs than that, the first two bubbles stay intact and
 *     everything after is joined into the final message.
 *   - Returns `[]` for empty / whitespace-only text.
 */
export function splitAiReply(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)

  if (paragraphs.length <= 1 || paragraphs.length <= MAX_AI_REPLY_MESSAGES) {
    return paragraphs
  }

  return [
    ...paragraphs.slice(0, MAX_AI_REPLY_MESSAGES - 1),
    paragraphs.slice(MAX_AI_REPLY_MESSAGES - 1).join('\n\n'),
  ]
}