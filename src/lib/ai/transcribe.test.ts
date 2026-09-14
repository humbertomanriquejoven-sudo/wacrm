import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { transcribeAudio } from '@/lib/ai/transcribe'

/**
 * Regression test for the OpenRouter audio-part shape.
 *
 * transcribeAudio sends base64 audio to google/gemini-2.5-flash-lite via
 * `input_audio`. OpenRouter awaits the OpenAI-style nested part
 * `{ type: 'input_audio', input_audio: { data, format } }`. The flat
 * `{ type: 'input_audio', input_format, data }` variant is silently
 * dropped by OpenRouter (usage.audio_tokens stays 0), so the model
 * never hears the clip and hallucinates a transcript.
 */

interface ChatCompletionsBody {
  model?: string
  messages?: Array<{
    role: string
    content?: Array<Record<string, unknown>>
  }>
  max_tokens?: number
}

let lastBody: ChatCompletionsBody | null = null

function mockOpenRouter(response: { status: number; json: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.body) {
        lastBody = JSON.parse(init.body as string) as ChatCompletionsBody
      }
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.json,
        text: async () => JSON.stringify(response.json),
      } as unknown as Response
    }),
  )
}

function oggBytes(): Buffer {
  // Not a real Ogg — transcribeAudio only transposes bytes into the
  // payload; the API stub never decodes it.
  return Buffer.from('fake ogg opus voice note bytes')
}

beforeEach(() => {
  lastBody = null
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key'
  delete process.env.OPENAI_API_KEY
  delete process.env.GROQ_API_KEY
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.OPENROUTER_API_KEY
})

describe('transcribeAudio — OpenRouter (gemini-2.5-flash-lite)', () => {
  it('sends the audio as a nested input_audio part so OpenRouter does not drop it', async () => {
    mockOpenRouter({
      status: 200,
      json: {
        choices: [
          {
            message: { content: 'Quiero agendar una cita para el martes' },
          },
        ],
      },
    })

    const text = await transcribeAudio(oggBytes(), 'audio/ogg; codecs=opus')

    expect(text).toBe('Quiero agendar una cita para el martes')

    const audioPart = lastBody!.messages?.[1]?.content?.find(
      (part) => part.type === 'input_audio',
    )
    // The nested shape — the documented OpenAI-style part.
    expect(audioPart).toBeDefined()
    expect(audioPart!.input_audio).toBeDefined()
    expect(audioPart!.input_audio).toMatchObject({
      data: oggBytes().toString('base64'),
      format: 'ogg',
    })
    // The broken flat shape must not reappear.
    expect(audioPart!.input_format).toBeUndefined()
    expect(audioPart!.data).toBeUndefined()
  })

  it('maps each chat_mime WhatsApp MIME to a format OpenRouter understands', async () => {
    mockOpenRouter({
      status: 200,
      json: { choices: [{ message: { content: 'ok' } }] },
    })

    const cases: Array<[string, string]> = [
      // Android voice note.
      ['audio/ogg; codecs=opus', 'ogg'],
      // iPhone recordings.
      ['audio/mp4', 'm4a'],
      ['audio/aac', 'm4a'],
      ['audio/m4a', 'm4a'],
      // Fallback catches audio/mpeg and audio/webm/amr edge classes.
      ['audio/mpeg', 'mp3'],
      ['audio/wav', 'wav'],
      ['audio/flac', 'flac'],
      ['audio/webm', 'ogg'],
      ['audio/amr', 'ogg'],
      ['', 'ogg'],
    ]

    for (const [mime, expectedFormat] of cases) {
      await transcribeAudio(oggBytes(), mime)
      const audioPart = lastBody!.messages?.[1]?.content?.find(
        (part) => part.type === 'input_audio',
      )
      const format = (audioPart!.input_audio as { format: string }).format
      expect(format).toBe(expectedFormat)
    }
  })

  it('does not fall through to Whisper when OpenRouter succeeds', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'transcripción' } }],
      }),
      text: async () => '{}',
    }))
    vi.stubGlobal('fetch', fetchMock)
    process.env.OPENAI_API_KEY = 'sk-openai'

    await transcribeAudio(oggBytes(), 'audio/ogg; codecs=opus')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const calls = fetchMock.mock.calls as unknown as Array<[string | URL]>
    const url = calls[0][0]
    expect(String(url)).toContain('openrouter.ai')
  })
})

describe('transcribeAudio — provider selection', () => {
  it('returns null (never throws) when no transcription key is set', async () => {
    delete process.env.OPENROUTER_API_KEY
    const result = await transcribeAudio(oggBytes(), 'audio/ogg; codecs=opus')
    expect(result).toBeNull()
  })

  it('falls back to OpenAI Whisper when OpenRouter fails and OPENAI_API_KEY is set', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('openrouter.ai')) {
        return {
          ok: false,
          status: 502,
          json: async () => ({ error: { message: 'boom' } }),
          text: async () => 'boom',
        } as unknown as Response
      }
      // OpenAI /audio/transcriptions
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'whisper transcript' }),
      } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    process.env.OPENAI_API_KEY = 'sk-openai'

    const text = await transcribeAudio(oggBytes(), 'audio/ogg; codecs=opus')

    expect(text).toBe('whisper transcript')
    expect(fetchMock).toHaveBeenCalled()
    const openaiCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('api.openai.com'),
    )
    expect(openaiCall).toBeDefined()
  })
})