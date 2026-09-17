import type { ToolCall } from './types'

// ============================================================
// Recover tool calls a model leaked as plain text.
//
// Some providers (notably Google Gemini through OpenRouter's OpenAI-
// shaped endpoint) occasionally fail to use the structured tool-calling
// channel and instead print the invocation as text, e.g.:
//
//   step_0: print(default_api.ver_disponibilidad(desde="2026-09-17", hasta="2026-09-17"))
//
// That scaffolding is a provider artifact, never the customer-facing
// answer. We strip it so it can never reach WhatsApp, and — when the
// provider did not return structured tool_calls — we recover the call
// so the tool still runs instead of being dropped.
// ============================================================

export interface LeakedToolExtraction {
  /** Text with every leaked invocation / scaffolding line removed. */
  text: string
  /** Tool calls recovered from the text (empty when none matched). */
  toolCalls: ToolCall[]
}

/**
 * Extract and remove text-rendered tool calls for the given known tool
 * names. Scaffolding markers (`step_N:`, `default_api.`) are always
 * removed so they can never reach the customer, even when no tool names
 * are known; invocations of a known name are additionally recovered as
 * real tool calls.
 */
export function extractLeakedToolCalls(
  raw: string,
  knownToolNames: Iterable<string>,
): LeakedToolExtraction {
  const names = new Set(knownToolNames)
  const toolCalls: ToolCall[] = []
  if (!raw) return { text: raw, toolCalls }

  // Matches `default_api.name(args)` or a bare `name(args)` for known
  // names. Args are captured up to the first closing paren — our tool
  // schemas only use flat string/number args, so no nested parens.
  const callRe = /\b(?:default_api\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^()]*)\)/g

  let matched = false
  const keptLines = raw.split(/\r?\n/).filter((line) => {
    let lineHasCall = false
    if (names.size > 0) {
      callRe.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = callRe.exec(line)) !== null) {
        if (!names.has(m[1])) continue
        toolCalls.push({
          id: `text-call-${m[1]}-${toolCalls.length}`,
          name: m[1],
          arguments: parseInvocationArgs(m[2]),
        })
        lineHasCall = true
        matched = true
      }
    }
    // A `step_N:` prefix or `default_api.` namespace is provider
    // scaffolding, never legitimate customer text — drop that line.
    const isScaffolding =
      /(^|\s)step_\d+\s*:?/i.test(line) || /default_api\./.test(line)
    if (isScaffolding) matched = true
    return !lineHasCall && !isScaffolding
  })

  if (!matched) return { text: raw, toolCalls }

  const text = keptLines
    .join('\n')
    .replace(/\bprint\s*\(\s*\)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { text, toolCalls }
}

/**
 * Parse the argument list of a text-rendered invocation. Accepts the
 * Python-kwargs shape Gemini emits (`desde="2026-09-17", hasta="..."`)
 * and a JSON object (`{"desde": "2026-09-17"}`).
 */
export function parseInvocationArgs(rawArgs: string): Record<string, unknown> {
  const s = (rawArgs ?? '').trim()
  if (!s) return {}

  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s) as unknown
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return obj as Record<string, unknown>
      }
    } catch {
      // Fall through to the key=value parser.
    }
  }

  const args: Record<string, unknown> = {}
  const kv =
    /([a-zA-Z_][a-zA-Z0-9_]*)\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^,]+))/g
  let m: RegExpExecArray | null
  while ((m = kv.exec(s)) !== null) {
    const value = m[2] ?? m[3] ?? m[4]?.trim()
    if (value !== undefined) args[m[1]] = value
  }
  return args
}
