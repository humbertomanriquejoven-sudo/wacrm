// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic' | 'openrouter'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  handoffAgentId: string | null
  embeddingsApiKey: string | null
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  /** For `role: 'tool'` — the id of the tool call this result answers. */
  toolCallId?: string
  /** For `role: 'assistant'` — tool calls the model requested. */
  toolCalls?: ToolCall[]
}

export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
  toolCalls?: ToolCall[]
}

/** Outcome of a generation call. */
export interface GenerateResult {
  text: string
  handoff: boolean
  usage: AiUsage | null
  toolCalls?: ToolCall[]
}

/** A tool call the model wants to execute. */
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/**
 * Provider-agnostic tool-selection directive.
 *
 * `'auto'` (the default) lets the model choose; `'required'` forces at
 * least one tool call; `'none'` disables tools; and the object form
 * forces ONE named function. Each adapter maps this to its own wire
 * shape (OpenAI/OpenRouter take it verbatim, Anthropic is translated in
 * `providers/anthropic.ts`).
 */
export type ToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; function: { name: string } }

/** Schema definition for a tool the model can invoke. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<
      string,
      {
        type: string
        description?: string
        enum?: string[]
      }
    >
    required?: string[]
  }
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  /**
   * The HTTP status the upstream provider actually returned, when this
   * error came from a non-2xx response. Kept separate from `status`,
   * which maps to OUR HTTP response (401 for a rejected key so the
   * settings "Test key" button can show it, 502 for everything else) —
   * logs need the real 402/404/500 to diagnose the provider side.
   */
  readonly upstreamStatus?: number
  constructor(
    message: string,
    opts: { code?: string; status?: number; upstreamStatus?: number } = {},
  ) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
    this.upstreamStatus = opts.upstreamStatus
  }
}

/**
 * Thrown when the stored `ai_configs.api_key` cannot be decrypted or comes
 * back empty — i.e. `ENCRYPTION_KEY` is missing from THIS environment or
 * differs from the key that encrypted the ciphertext (local vs Hostinger
 * vs EasyPanel drift). Dispatch catches it, logs the
 * `[CRITICAL_AI_KEY_ERROR]` line and sends the neutral acknowledgement, so
 * a key/environment mismatch can never mean silent silence.
 */
export class AiKeyDecryptError extends Error {
  readonly code = 'ai_key_decrypt_failed'
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message, opts)
    this.name = 'AiKeyDecryptError'
  }
}
