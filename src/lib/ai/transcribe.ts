import { AiError } from './types'

const WHISPER_MODEL = 'whisper-1'
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions'
const GEMINI_TRANSCRIBE_MODEL = 'google/gemini-2.5-flash-lite'

// The exact instruction sent to the multimodal model with the audio bytes.
// Kept in Spanish and unquoted so transcripts come back as plain text.
const TRANSCRIBE_INSTRUCTION =
  'Escucha este audio y transcribe con exactitud lo que dice el cliente en texto plano.'

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
      console.error(
        '[transcribe][openrouter] google/gemini-2.5-flash-lite transcription failed:',
        err instanceof Error ? err.message : err,
        { mimeType, audioBytes: buffer.byteLength, model: GEMINI_TRANSCRIBE_MODEL },
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
      console.error('[transcribe][openai] Whisper failed:', (err as Error).message, {
        mimeType,
        audioBytes: buffer.byteLength,
      })
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
      console.error('[transcribe][groq] Whisper failed:', (err as Error).message, {
        mimeType,
        audioBytes: buffer.byteLength,
      })
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
            { type: 'text', text: TRANSCRIBE_INSTRUCTION },
            // OpenRouter's /chat/completions expects the OpenAI-style
            // `input_audio: { data, format }` part. The flat
            // `{ input_format, data }` variant of the same part is
            // silently DROPPED by OpenRouter (usage.audio_tokens stays
            // 0), so the model never hears the clip and hallucinates a
            // transcript. Verified against google/gemini-2.5-flash-lite.
            {
              type: 'input_audio',
              input_audio: {
                data: buffer.toString('base64'),
                format: audioInputFormat(mimeType),
              },
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
 * Map a WhatsApp MIME type to the `format` key OpenRouter's `input_audio`
 * part understands. OpenRouter documents wav/mp3/aiff/aac/ogg/flac/m4a/
 * pcm16/pcm24 — anything else (mp4, webm, amr) has no canonical mapping
 * and can be rejected upstream, so the closest supported value is used.
 * Meta sends `audio/ogg; codecs=opus` for Android voice notes and
 * `audio/mp4` for iPhone recordings.
 */
function audioInputFormat(mime: string): string {
  const base = (mime || '').split(';')[0].trim().toLowerCase()
  if (base.includes('ogg')) return 'ogg'
  if (base.includes('mp3') || base.includes('mpeg')) return 'mp3'
  if (base.includes('mp4') || base.includes('m4a') || base.includes('aac')) return 'm4a'
  if (base.includes('wav')) return 'wav'
  if (base.includes('flac')) return 'flac'
  if (base.includes('webm')) return 'ogg'
  if (base.includes('amr')) return 'ogg'
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