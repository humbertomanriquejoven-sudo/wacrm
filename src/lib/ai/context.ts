import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
  content_type: string
  media_url: string | null
  media_type: string | null
}

/**
 * Content types worth showing the model. Everything else (video,
 * document, audio with no transcript) is skipped because it carries
 * nothing to read.
 *
 * `interactive` is the load-bearing addition: a customer tapping a reply
 * button / quick reply / list row is stored as content_type='interactive'
 * with the tapped label in `content_text` (see parseMessageContent in the
 * webhook). Filtering it out meant the bot was asked to answer a button
 * tap it had never been told about — the customer pressed "Quiero
 * información" and the model saw the message *before* it and nothing
 * after. Including it normalizes the tap into ordinary user text, which is
 * exactly how it must read.
 *
 * `template` is included for the same reason on the outbound side: the
 * substituted body is in `content_text`, so the model knows what we
 * actually sent them.
 */
const AI_CONTEXT_CONTENT_TYPES = [
  'text',
  'image',
  'audio',
  'interactive',
  'template',
] as const

/**
 * Fetch the last N messages of a conversation and map them to the
 * provider-neutral chat shape. Text messages carry their content;
 * image messages carry a placeholder and their media_url for the
 * vision pipeline. Audio rows carry the voice-note transcript in
 * content_text, so they read like text. Button / list taps read as the
 * label the customer chose. Other media types (video, document, audio
 * with no transcription) are skipped.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text, content_type, media_url, media_type')
    .eq('conversation_id', conversationId)
    .in('content_type', [...AI_CONTEXT_CONTENT_TYPES])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  const messages: ChatMessage[] = []

  for (const m of rows) {
    const role = m.sender_type === 'customer' ? 'user' : 'assistant'

    if (m.content_type === 'image' && m.media_url) {
      messages.push({
        role,
        content: m.content_text?.trim() || '[Image]',
        images: [m.media_url],
      })
      continue
    }

    if (m.content_text && m.content_text.trim()) {
      messages.push({ role, content: m.content_text.trim() })
    }
  }

  return messages
}
