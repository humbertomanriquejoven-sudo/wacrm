import crypto from 'crypto'

/**
 * Non-reversible diagnostic fingerprint of a plaintext API key: the first
 * 8 hex chars of its SHA-256. The settings save and the webhook worker's
 * config load both log it, so "the UI saved key X but the worker is using
 * key Y" is answerable from the logs alone — without ever putting key
 * material in a log line.
 *
 * Lives in its own module (not `config.ts`) so callers that `vi.mock`
 * `./config` for `loadAiConfig` keep working unchanged.
 */
export function apiKeyFingerprint(plainKey: string): string {
  return crypto.createHash('sha256').update(plainKey).digest('hex').slice(0, 8)
}
