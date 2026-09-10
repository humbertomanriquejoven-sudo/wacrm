import { AiError } from './types'

const WHISPER_MODEL = 'whisper-1'

/**
 * Try OpenAI Whisper first, then Groq as fallback. Returns the
 * transcribed text or null when no API key is available or all
 * providers fail. Never throws — a missing transcription key must
 * not break the webhook.
 */
export async function transcribeAudio(
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  const openaiKey = process.env.OPENAI_API_KEY
  const groqKey = process.env.GROQ_API_KEY

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
    '[transcribe] no transcription available — set OPENAI_API_KEY or GROQ_API_KEY to enable audio transcription.',
  )
  return null
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
    signal: AbortSignal.timeout(30_000),
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

function mimeToExt(mime: string): string {
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('webm')) return 'webm'
  return 'ogg'
}
