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
 * Fetch the last N messages of a conversation and map them to the
 * provider-neutral chat shape. Text messages carry their content;
 * image messages carry a placeholder and their media_url for the
 * vision pipeline. Other media types (video, document, audio with no
 * transcription) are skipped.
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
    .in('content_type', ['text', 'image'])
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
