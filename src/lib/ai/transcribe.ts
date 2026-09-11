import { AiError } from './types'

const WHISPER_MODEL = 'whisper-1'
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions'
const GEMINI_TRANSCRIBE_MODEL = 'google/gemini-2.5-flash-lite'

// Strict ceilings so a stuck provider can't hang the WhatsApp webhook.
// Transcription is on the inbound hot path — every second here delays
// the bot's reply to the customer.
const TRANSCRIBE_TIMEOUT_MS = 12_000

/**
 * Transcribe a WhatsApp voice note held in memory.
 *
 * Priority:
 *   1. `google/gemini-2.5-flash-lite` (multimodal) via OpenRouter — the
 *      audio bytes are sent to the model directly as base64, no separate
 *      upload/whisper round-trip. Requires OPENROUTER_API_KEY.
 *   2. OpenAI Whisper (OPENAI_API_KEY).
 *   3. Groq Whisper (GROQ_API_KEY).
 *
 * Returns the minimal spoken text or null when no API key is available
 * or every provider fails. Never throws — a missing transcription key
 * must not break the webhook.
 */
export async function transcribeAudio(
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  const openrouterKey = process.env.OPENROUTER_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY
  const groqKey = process.env.GROQ_API_KEY

  if (openrouterKey) {
    try {
      const text = await callGemini(openrouterKey, buffer, mimeType)
      if (text) return text
    } catch (err) {
      console.warn(
        '[transcribe] Gemini (gemini-2.5-flash-lite) failed:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  if (openaiKey) {
    try {
      const text = await callWhisper(
        'https://api.openai.com/v1/audio/transcriptions',
        openaiKey,
        buffer,
        mimeType,
      )
      if (text) return text
    } catch (err) {
      console.warn('[transcribe] OpenAI Whisper failed:', (err as Error).message)
    }
  }

  if (groqKey) {
    try {
      const text = await callWhisper(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        groqKey,
        buffer,
        mimeType,
      )
      if (text) return text
    } catch (err) {
      console.warn('[transcribe] Groq Whisper failed:', (err as Error).message)
    }
  }

  console.warn(
    '[transcribe] no transcription available — set OPENROUTER_API_KEY (gemini-2.5-flash-lite), OPENAI_API_KEY or GROQ_API_KEY to enable audio transcription.',
  )
  return null
}

/**
 * Multimodal transcription: the raw audio (base64) is a message part sent
 * straight to the model. `google/gemini-2.5-flash-lite` is fast and
 * audio-native, which keeps the voice-note → text → bot-reply round trip
 * well under a few seconds.
 */
async function callGemini(
  apiKey: string,
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  const res = await fetch(OPENROUTER_BASE, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GEMINI_TRANSCRIBE_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You transcribe WhatsApp voice notes. Reply with the exact spoken text in its original language only — no preface, no quotes, no commentary, no closing note.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe this voice note.' },
            {
              type: 'input_audio',
              input_format: audioInputFormat(mimeType),
              data: buffer.toString('base64'),
            },
          ],
        },
      ],
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new AiError(`OpenRouter transcription error (${res.status}): ${detail}`, {
      code: 'provider_error',
      status: 502,
    })
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const text = data.choices?.[0]?.message?.content
  return typeof text === 'string' && text.trim() ? text.trim() : null
}

async function callWhisper(
  endpoint: string,
  apiKey: string,
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  const ext = mimeToExt(mimeType)
  const filename = `audio.${ext}`

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename)
  form.append('model', WHISPER_MODEL)

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new AiError(`Whisper API error (${res.status}): ${detail}`, {
      code: 'provider_error',
      status: 502,
    })
  }

  const data = (await res.json()) as { text?: string }
  return data.text?.trim() || null
}

/**
 * Map a WhatsApp MIME type to the `input_format` key the multimodal
 * endpoint understands. Meta sends `audio/ogg; codecs=opus` for voice
 * notes; the rest are edge cases (audio/mp4 recording, audio/aac, ...).
 */
function audioInputFormat(mime: string): string {
  const base = (mime || '').split(';')[0].trim().toLowerCase()
  if (base.includes('ogg')) return 'ogg'
  if (base.includes('mp3') || base.includes('mpeg')) return 'mp3'
  if (base.includes('mp4') || base.includes('m4a') || base.includes('aac')) return 'mp4'
  if (base.includes('wav')) return 'wav'
  if (base.includes('flac')) return 'flac'
  if (base.includes('webm')) return 'webm'
  if (base.includes('amr')) return 'amr'
  return 'ogg'
}

function mimeToExt(mime: string): string {
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('webm')) return 'webm'
  return 'ogg'
}