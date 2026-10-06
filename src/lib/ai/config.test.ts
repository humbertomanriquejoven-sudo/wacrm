import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext —
// except for two sentinel ciphertexts that reproduce the production
// failure modes: a mismatched ENCRYPTION_KEY and an empty plaintext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => {
    if (v === 'corrupt') throw new Error('bad decrypt: state mismatch')
    if (v === 'empty') return ''
    return `plain:${v}`
  },
}))

import { loadAiConfig } from './config'
import { AiKeyDecryptError } from './types'

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  return chain as unknown as SupabaseClient
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
}

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false }),
    ).toBeNull()
  })
})

describe('loadAiConfig key decryption failures', () => {
  const ACTIVE_ROW = { ...ROW, is_active: true, auto_reply_enabled: true }

  it('logs [CRITICAL_AI_KEY_ERROR] and throws AiKeyDecryptError when decrypt fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      loadAiConfig(dbReturning({ ...ACTIVE_ROW, api_key: 'corrupt' }), 'acct'),
    ).rejects.toBeInstanceOf(AiKeyDecryptError)
    const line = spy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('[CRITICAL_AI_KEY_ERROR]'))
    expect(line).toContain('Verifica ENCRYPTION_KEY')
    spy.mockRestore()
  })

  it('treats a key that decrypts to an empty string as a failure too', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      loadAiConfig(dbReturning({ ...ACTIVE_ROW, api_key: 'empty' }), 'acct'),
    ).rejects.toBeInstanceOf(AiKeyDecryptError)
    expect(
      spy.mock.calls.some((c) => String(c[0]).includes('[CRITICAL_AI_KEY_ERROR]')),
    ).toBe(true)
    spy.mockRestore()
  })
})
