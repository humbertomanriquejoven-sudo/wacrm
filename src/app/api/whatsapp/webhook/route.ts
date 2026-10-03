import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl, downloadMedia, sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import {
  findExistingContact,
  findContactByNameWithoutPhone,
  isUniqueViolation,
} from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { engineSendText } from '@/lib/flows/meta-send'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import {
  autoUnblockConversation,
  autoUnblockEnabled,
  clearStaleFlowRuns,
} from '@/lib/ai/unblock'
import { transcribeAudio } from '@/lib/ai/transcribe'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media Meta verification calls, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  /**
   * Non-Meta gateways (YCloud, on-prem, etc.) deliver voice notes under
   * `type: 'voice'` with the envelope in `voice`; Meta uses `type:
   * 'audio'`. Same shape, so both share the audio transcription path.
   */
  voice?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /**
   * Set when the customer taps a QUICK_REPLY button on a *template*
   * message — a broadcast, or any template send. Meta uses a different
   * envelope from `interactive` above: `type: 'button'`, the label in
   * `button.text`, and the payload configured on the template's button
   * in `button.payload` (Meta's own template editor doesn't ask for a
   * payload and mirrors the label into it).
   */
  button?: { text?: string; payload?: string }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
  /**
   * BSUID (Business-Scoped User ID) of the sender. Meta sends this
   * instead of / alongside `from` when the message arrives from a
   * number that is NOT registered on WhatsApp. Opaque, per-WABA id.
   */
  from_user_id?: string
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string; /** Public @username. Not every
         *  profile exposes one, so it's optional. */ username?: string }
        wa_id: string
        /**
         * BSUID. Present for senders on numbers that aren't registered
         * on WhatsApp — an opaque id rather than a phone number, which
         * is the case that used to produce a contact with a `phone` we
         * couldn't send to.
         */
        user_id?: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
      }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    // Fetch all whatsapp configs to check verify tokens
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch (err) {
    console.error(
      '[webhook] POST body is not valid JSON — payload dropped:',
      err instanceof Error ? err.message : err
    )
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Inbound breadcrumb. Everything downstream is asynchronous (after()
  // below), so this is the only record that Meta's delivery even reached
  // us — without it a dead bot and a webhook Meta never called look
  // identical in the logs.
  const inboundMessageCount = (body.entry ?? []).reduce(
    (total, entry) =>
      total +
      (entry.changes ?? []).reduce(
        (n, change) => n + (change.value?.messages?.length ?? 0),
        0
      ),
    0
  )
  console.log(
    `[webhook] POST received — signature ok, ${body.entry?.length ?? 0} entr${
      (body.entry?.length ?? 0) === 1 ? 'y' : 'ies'
    }, ${inboundMessageCount} inbound message(s)`
  )

  // Raw payload dump. The identity fields Meta sends have changed shape
  // more than once (wa_id → user_id/BSUID → profile.username), and when
  // an inbound is mishandled the only way to know what we actually got is
  // the exact JSON. Truncated: media payloads can carry long ids and the
  // dump exists for shape, not archival.
  console.log(
    '=== META WEBHOOK BODY ===',
    JSON.stringify(body, null, 2).slice(0, 4000),
  )

  // Process AFTER the response so we ack Meta within their ~20s timeout
  // (a slow ack triggers Meta retries + duplicate inserts), while still
  // guaranteeing the work runs to completion.
  //
  // This MUST use `after()` rather than a detached `processWebhook(body)`
  // promise: on serverless platforms (we run on Vercel) the function can
  // be frozen or terminated the moment the response is sent, so a floating
  // promise's DB writes are not guaranteed to finish. That dropped a
  // non-deterministic *subset* of inbound messages — contacts/conversations
  // were created but the message insert never landed, leaving conversations
  // that show in the inbox with an empty thread, and no logs to explain it
  // (see issue #301). `after()` hands the callback to the runtime, which
  // keeps the function alive until it resolves (within the route's
  // maxDuration).
  after(async () => {
    const startedAt = Date.now()
    try {
      // Move any identifier that landed in `phone` to `wa_user_id` and
      // adopt a real number where a sibling contact has one.
      await repairBsuidPhoneContacts()
      // Remove orphan contacts left by pre-BSUID versions of this handler,
      // which could insert a row with no usable `phone`. Those rows are
      // undeliverable and they also break `findExistingContact`'s
      // suffix pre-filter, so they get swept once per delivery — cheap
      // (an indexed `is.null` + `eq('')` on a normally-tiny set), and
      // self-limiting since the count drops to zero after the first run.
      await purgeEmptyPhoneContacts()
      await processWebhook(body)
      console.log(
        `[webhook] delivery processed in ${Date.now() - startedAt}ms`
      )
    } catch (error) {
      console.error(
        `[webhook] processWebhook threw after ${Date.now() - startedAt}ms — remaining messages in this delivery were dropped:`,
        error
      )
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) {
    console.warn(
      '[webhook] payload has no entry[] — nothing to process (not a Meta message delivery?)'
    )
    return
  }

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          supabaseAdmin(),
        )
        continue
      }

      const value = change.value

      // Handle status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status)
        }
      }

      // Handle incoming messages. `value.contacts` missing/empty used to
      // skip the whole change with zero output, which is indistinguishable
      // from "Meta never sent it" in the logs — say which half was absent.
      if (!value.messages) continue
      if (!value.contacts || value.contacts.length === 0) {
        console.warn(
          `[webhook] ${value.messages.length} inbound message(s) arrived with no contacts[] — skipping change (Meta normally always sends it)`
        )
        continue
      }

      const phoneNumberId = value.metadata.phone_number_id

      // Find user's config by phone_number_id. `.single()` returns
      // PGRST116 for both 0 rows AND ≥2 rows — distinguish them so
      // operators see the real cause in logs. ≥2 rows shouldn't happen
      // post-migration 013 (UNIQUE constraint), but a row created
      // before the constraint, or a race, would still surface here.
      const { data: configRows, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('phone_number_id', phoneNumberId)

      if (configError) {
        console.error(
          'Error fetching whatsapp_config for phone_number_id:',
          phoneNumberId,
          configError
        )
        continue
      }

      if (!configRows || configRows.length === 0) {
        console.error('No config found for phone_number_id:', phoneNumberId)
        continue
      }

      if (configRows.length > 1) {
        console.error(
          `Multiple configs (${configRows.length}) found for phone_number_id:`,
          phoneNumberId,
          '— inbound message dropped. Resolve duplicates so each number maps to a single account.',
          'Account owners:',
          configRows.map((r: { account_id: string; user_id: string }) => `${r.account_id} (admin ${r.user_id})`)
        )
        continue
      }

      const config = configRows[0]

// Decrypting outside a try/catch meant a wrong ENCRYPTION_KEY threw
// straight out of processWebhook and killed every remaining message in
// the delivery, surfacing only as one generic "Error processing webhook".
// Scope the failure to this change so the rest still lands.
let decryptedAccessToken: string
try {
      decryptedAccessToken = decrypt(config.access_token)
    } catch (err) {
      console.error(
        `[webhook] could not decrypt access_token for phone_number_id ${phoneNumberId} (account ${config.account_id}) — check ENCRYPTION_KEY matches the value stored in whatsapp_config. All messages for this number are dropped:`,
        err instanceof Error ? err.message : err
      )
      continue
    }

    for (let i = 0; i < value.messages.length; i++) {
      const message = value.messages[i]
      // An empty contacts[] is filtered above, but a short array can still
      // leave `contact` undefined. Dereferencing `contact.profile.name`
      // used to throw and abort the whole delivery, so coerce it.
      const contact = value.contacts[i] ?? value.contacts[0]
      if (!contact) {
        console.error(
          `[webhook] no contact object for message ${message.id} — skipping it (contacts[] had ${value.contacts.length} entr${value.contacts.length === 1 ? 'y' : 'ies'} for ${value.messages.length} message(s))`
        )
        continue
      }

        await processMessage(
          message,
          contact,
          // Tenancy — drives every contact / conversation lookup
          // and the engines' active-row dispatch.
          config.account_id,
          // Audit / sender-of-record — used as the user_id on row
          // inserts that need it for NOT NULL FK compliance. Always
          // the admin who saved the WhatsApp config.
          config.user_id,
          decryptedAccessToken,
          // The number the inbound hit — used for the typing indicator
          // sent back to the customer on the bot reply path.
          config.phone_number_id,
          // Default ON: the column is NOT NULL DEFAULT TRUE, but a row
          // read before migration 039 lands would have it undefined,
          // and losing attachments is the failure mode worth avoiding.
          config.mirror_inbound_media !== false
        )
      }
    }
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string
}) {
  // 1) Mirror onto messages (legacy behavior) — Meta's status values
  //    already match the CHECK constraint on messages.status. No
  //    `.select()`: message_id is NOT unique (migration 009 — Meta ids
  //    repeat across numbers), so this updates 0..N rows and must not
  //    assume a single row.
  const { error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.id)

  if (msgErr) {
    console.error('Error updating message status:', msgErr)
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso

    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', status.id)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as { account_id: string } | null
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        accountId,
        'message.status_updated',
        {
          whatsapp_message_id: status.id,
          conversation_id: msgRow.conversation_id,
          status: status.status,
        }
      )
    }
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}

async function processMessage(
  message: WhatsAppMessage,
  contact: {
    profile: { name: string; username?: string }
    wa_id: string
    user_id?: string
  },
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  accessToken: string,
  // The WhatsApp number this inbound arrived on — drives the outbound
  // typing indicator for the bot's reply path.
  phoneNumberId: string,
  // Per-account opt-out for the inbound-media mirror (migration 039).
  // See parseMessageContent for what it turns off.
  mirrorMedia: boolean
) {
  // ============================================================
  // Sender identity — Meta can identify the same person three ways, and
  // does NOT always send all three:
  //
  //   * `wa_id` / `messages[].from`   — the phone number, E.164 digits.
  //   * `contacts[].user_id` / `messages[].from_user_id` — the BSUID. Meta
  //     prefixes these with a namespace marker: `'CO.<digits>'` is a
  //     contact-scoped id, `'WAID.<digits>'` a phone-scoped one. They are
  //     OPAQUE identifiers, never phone numbers and never usernames.
  //   * `contacts[].profile.username` — the public @username.
  //
  // The BSUID case is what broke outbound delivery: we only had `phone` to
  // store an identifier, so a BSUID-only sender produced a contact whose
  // `phone` held something like 'CO.1008477715690681' — not a number, so
  // `sanitizePhoneForMeta` rejected it and every send failed while the
  // typing indicator still fired. Classify first, then store each value
  // in the column it actually belongs to.
  // ============================================================
  const waIdRaw = message.from || contact.wa_id || ''

  // A real phone number is digits only. Anything with letters, a dot, or
  // any other character is an identifier we must NOT treat as a number.
  const rawPhone = isPhoneLike(waIdRaw) ? normalizePhone(waIdRaw) : ''

  // BSUID, including its `'CO.'` / `'WAID.'` namespace prefix. Stripped of
  // the prefix for storage so the value is comparable across payloads,
  // but only ever written to `wa_user_id` — never to `phone`/`username`.
  const senderUserId = firstOpaqueId(
    contact.user_id,
    message.from_user_id,
    waIdRaw,
  )

  // Username, stored WITH the leading '@' so it renders the way WhatsApp
  // shows it. Strip-then-re-add rather than check-startsWith, so
  // '@@humberto' also normalizes to '@humberto'.
  const senderUsername = withAtSign(
    contact.profile.username || (contact as { username?: string }).username,
  )
  const senderName = contact.profile.name?.trim() || null

  // The `phone` we persist. Only ever a real number — if Meta gave us
  // none, we fall back to the BSUID so the NOT NULL column holds something
  // the sender can be addressed by (Meta accepts a BSUID as `to`), but we
  // never invent a number from a username or a display name.
  const senderPhone = rawPhone || senderUserId || 'unknown'

  // Human-facing label. The @username is more stable than the profile
  // name (people rename themselves), so it wins when present. Stored on
  // the contact row inside findOrCreateContact.

  // Per-message breadcrumb: this is where you confirm the inbound reached
  // processing at all, and the steps below all reference this id.
  console.log(
    `[webhook] processing ${message.type} message ${message.id} from ${senderPhone || message.from} (account ${accountId})`
  )
  console.log('-> [EXTRACTED DATA]', {
    effectivePhone: senderPhone,
    extractedUser: senderUsername || senderUserId || senderName,
    hasRealPhone: Boolean(rawPhone),
    wa_user_id: senderUserId,
    username: senderUsername,
  })

  // Show the WhatsApp typing indicator IMMEDIATELY so the customer sees
  // the bot "is typing" while we process text / voice notes. Fire-and-
  // forget and strictly best-effort: a failed indicator must never break
  // inbound processing. Meta dismisses it automatically when the reply
  // message is delivered, or after 25 seconds, whichever comes first.
  if (
    message.type === 'text' ||
    message.type === 'audio' ||
    message.type === 'voice'
  ) {
    sendTypingIndicator({
      phoneNumberId,
      accessToken,
      messageId: message.id,
    }).catch((err) => {
      console.error(
        '[webhook] typing indicator failed:',
        err instanceof Error ? err.message : err,
      )
    })
  }

  // Find or create contact. Resolves on BSUID → phone → username → name,
  // so a sender we've already seen never gets a second row.
  const contactOutcome = await findOrCreateContact(accountId, configOwnerUserId, {
    phone: rawPhone,
    waUserId: senderUserId,
    username: senderUsername,
    name: senderName ?? contact.profile.name,
  })
  if (!contactOutcome) {
    console.error(
      `[webhook] could not resolve or create a contact for ${senderPhone} — dropping message ${message.id} before it reaches the AI.`
    )
    return
  }
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) {
    console.error(
      `[webhook] could not resolve or create a conversation for contact ${contactRecord.id} — dropping message ${message.id} before it reaches the AI.`
    )
    return
  }
  const conversation = convResult.conversation

  console.log(
    `[webhook] thread ${conversation.id} (contact ${contactRecord.id}, assigned_agent_id=${(conversation as { assigned_agent_id?: string | null }).assigned_agent_id ?? 'null'}${convResult.created ? ', newly created' : ''})`
  )

  // Auto-unblock BEFORE the flow runner. Threads that already interacted
  // with a Flow can hold a stranded `active` run, and `dispatchInboundToFlows`
  // reports `consumed: true` for every inbound while one exists — which is
  // why the bot answered new numbers but went silent on old ones. Runs must
  // be cleared before the flow dispatch, and the assignment flag before the
  // AI gate, so this runs first and never throws.
  if (autoUnblockEnabled() && !convResult.created) {
    await autoUnblockConversation(supabaseAdmin(), conversation.id, senderPhone)
    await clearStaleFlowRuns(supabaseAdmin(), conversation.id)
  }

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  // Parse message content based on type
  const parsed = await parseMessageContent(
    message,
    accessToken,
    mirrorMedia ? { accountId } : null
  )
  const { mediaUrl, mediaType, interactiveReplyId, pendingAudio } = parsed
  // Reassigned below when a voice-note transcript lands after the insert.
  let contentText = parsed.contentText

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id
      )
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, media_type, template_name, message_id, status,
  //   created_at

  // The messages.content_type CHECK constraint (widened in migration 010
  // to add 'interactive' for button/list taps) allows:
  //   text, image, document, audio, video, location, template, interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'         // stickers are images
      : message.type === 'button'
        ? 'interactive' // template quick-reply tap (issue #478)
        : message.type === 'voice'
          ? 'audio'     // non-Meta gateways deliver voice notes as "voice"
          : 'text'      // reaction, unknown → text fallback

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // Idempotent insert. Meta retries webhook deliveries (a slow ack, a
  // transient 5xx), and each retry replays the exact same message.id. The
  // unique index on (conversation_id, message_id) added in migration 037
  // makes a replay conflict; `ignoreDuplicates` turns that into an ON
  // CONFLICT DO NOTHING, and the `.select()` then returns the inserted row
  // ONLY on a genuine first insert — an empty result means this delivery
  // was a replay. This is the single idempotency boundary that must sit
  // BEFORE the unread bump and all downstream fan-out below (issue #367).
  const { data: insertedRows, error: msgError } = await supabaseAdmin()
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        // Meta's MIME type for the attachment (migration 039). Was
        // discarded before, which forced the download path to guess an
        // extension from the fetched blob — impossible to do until the
        // bytes had already been fetched successfully.
        media_type: mediaType,
        message_id: message.id,
        status: 'delivered',
        created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
        reply_to_message_id: replyToInternalId,
        // Only populated for content_type='interactive'. Migration 010 added
        // the column; null for every other content_type so existing inserts
        // behave identically.
        interactive_reply_id: interactiveReplyId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id')

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  // Replayed delivery: the message already exists, so acknowledge it as a
  // no-op. Returning here is what keeps a retry from double-bumping unread,
  // re-advancing flows, re-firing automations, re-invoking AI handling, and
  // re-dispatching public webhooks (issue #367).
  if (!insertedRows || insertedRows.length === 0) {
    console.info(
      '[webhook] duplicate inbound message ignored (idempotent replay):',
      message.id
    )
    return
  }

  // Update conversation. The unread bump is done DB-side (migration 037's
  // bump_conversation_on_inbound) rather than as a read-modify-write of the
  // snapshot loaded above: two inbound messages for the same conversation
  // can process concurrently, and computing `snapshot + 1` in the app let
  // both reads see the same value and write the same increment, losing one
  // (issue #369). The RPC increments in a single UPDATE and refreshes the
  // last-message summary in the same statement.
  const { error: convError } = await supabaseAdmin().rpc(
    'bump_conversation_on_inbound',
    {
      p_conversation_id: conversation.id,
      p_last_message_text: contentText || `[${message.type}]`,
    }
  )

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  // A customer writing again re-opens the thread (issue #409). Kept as a
  // separate conditional statement rather than a `status` field on the
  // update above so the write can be gated on the row's CURRENT status in
  // SQL — see the helper for why that matters.
  await reopenClosedConversation(supabaseAdmin(), conversation)

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // Voice notes transcribe in the BACKGROUND. The row above was saved
  // immediately (content_text null) so the inbox update is real-time —
  // transcription latency no longer gates the insert. Here, after the
  // insert, the transcript is written back onto the row and treated as
  // the message payload for flows / automations / the AI.
  const isVoiceNote = message.type === 'audio' || message.type === 'voice'

  // Shared "please write instead" reply for voice notes with no
  // transcript: either the media fetch failed before we could download
  // the bytes, or every transcription provider failed.
  const sendVoiceFallback = async () => {
    try {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId: conversation.id,
        contactId: contactRecord.id,
        text: 'No pude procesar tu nota de voz. ¿Me la escribes con texto, por favor?',
      })
    } catch (err) {
      console.error('[webhook] audio fallback reply failed:', err)
    }

    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
      whatsapp_message_id: message.id,
      content_type: contentType,
      text: null,
    })
  }

  if (isVoiceNote) {
    if (pendingAudio) {
      const transcript = await transcribeAudio(
        pendingAudio.buffer,
        pendingAudio.mimeType
      )
      if (!transcript) {
        console.error(
          '[webhook][audio] transcription failed across all providers — sending text fallback:',
          {
            messageId: message.id,
            mimeType: pendingAudio.mimeType,
            audioBytes: pendingAudio.buffer.byteLength,
          },
        )
        await sendVoiceFallback()
        return
      }

      // Transcription succeeded: persist the transcript back onto the row
      // (fires a second realtime event that swaps the audio bubble for
      // readable text) and refresh the conversation-list summary, which
      // the unread bump stamped with `[audio]` a moment ago.
      contentText = transcript
      const { error: transcriptError } = await supabaseAdmin()
        .from('messages')
        .update({ content_text: transcript })
        .eq('id', insertedRows[0].id)
      if (transcriptError) {
        console.error('[webhook][audio] failed to persist transcript:', transcriptError)
      }
      await supabaseAdmin()
        .from('conversations')
        .update({ last_message_text: transcript })
        .eq('id', conversation.id)
    } else if (!contentText) {
      // Media fetch/download failed in parseMessageContent — no bytes to
      // transcribe or mirror reliably.
      await sendVoiceFallback()
      return
    }
  }

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? '',
            meta_message_id: message.id,
          }
        : {
            kind: 'text',
            text: contentText ?? message.text?.body ?? '',
            meta_message_id: message.id,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to Meta.
  const inboundText = contentText ?? message.text?.body ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  // Awaited — not fire-and-forget. We're inside the route's `after()`
  // block, which only keeps the function alive for promises it can see, so
  // a detached dispatch can be frozen part-way through: the log row is
  // inserted, then the steps never run. That is issue #301's failure mode
  // recurring one level down, and it's what issue #409 reported as runs
  // logging zero steps. `runAutomationsForTrigger` owns its own try/catch
  // and never throws; the `.catch` is belt-and-braces so one trigger
  // type's failure can't skip the rest of the loop.
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        // Only set on interactive taps; drives the interactive_reply
        // trigger's exact-id match.
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. Awaited inside `after()` (same reason as
  // the webhook dispatch below); `dispatchInboundToAiReply` owns its
  // eligibility gates + try/catch and never throws.
  //
  // Every reason this block is skipped is logged explicitly: this gate
  // used to be the largest silent hole in the pipeline, where a message
  // would arrive, land in the inbox, and simply never reach the LLM with
  // nothing in the logs to say why.
  if (flowConsumed) {
    console.log(
      `[webhook] message ${message.id}: a Flow consumed it — AI auto-reply skipped by design.`
    )
  } else if (interactiveReplyId) {
    console.log(
      `[webhook] message ${message.id}: interactive reply ${interactiveReplyId} — AI auto-reply skipped by design (buttons/lists are answered by their own flow).`
    )
  } else if (!inboundText.trim()) {
    console.log(
      `[webhook] message ${message.id}: no text content after parsing (type=${message.type}) — AI auto-reply skipped (nothing to answer).`
    )
  } else {
    console.log(
      `[webhook] message ${message.id}: dispatching to AI auto-reply (${inboundText.trim().slice(0, 80)})`
    )
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
      // The inbound wamid — lets the bot keep WhatsApp's typing
      // indicator alive while it streams a multi-part reply.
      composeMessageId: message.id,
    })
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because we're inside the route's `after()` block, which only keeps
  // the function alive for promises it can see; a detached promise could
  // be frozen before it delivers. `dispatchWebhookEvent` early-exits
  // when the account has no matching endpoint and never throws.
  // (conversation.created is emitted earlier, right after the thread is
  // opened.)
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  })
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string,
  // Tenancy + opt-out for the media mirror. Null disables mirroring
  // entirely, which is what the account-level toggle does.
  mirror: { accountId: string } | null
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
  /**
   * Audio messages only. The already-downloaded bytes that carry the
   * voice note, handed to the caller so transcription can run in the
   * background AFTER the message row is saved — keeps the insert (and
   * the inbox realtime event) off the transcription latency path.
   * Undefined for every other message type.
   */
  pendingAudio?: { buffer: Buffer; mimeType: string }
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  //
  // Beyond verifying, this is where inbound media gets COPIED into the
  // `chat-media` bucket (issue #466). Meta deletes media ~30 days after
  // receipt, so the `/api/whatsapp/media/<id>` proxy URL we used to
  // store is a pointer with an expiry date on it — every inbound
  // attachment silently became "Photo unavailable" a month later.
  // Mirroring stores a durable public URL instead.
  //
  // The mirror is strictly best-effort. `mirrorInboundMedia` swallows
  // its own failures and returns null, and we fall back to the proxy
  // URL — a webhook that throws would have Meta retry the delivery and
  // re-run everything downstream, which is a far worse outcome than an
  // attachment that expires.
  const verifyAndBuildUrl = async (
    mediaId: string,
    fileName?: string | null
  ): Promise<string | null> => {
    try {
      const info = await getMediaUrl({ mediaId, accessToken })

      if (mirror) {
        const mirrored = await mirrorInboundMedia({
          storage: supabaseAdmin().storage,
          accountId: mirror.accountId,
          mediaId,
          downloadUrl: info.url,
          accessToken,
          mimeType: info.mimeType,
          fileSize: info.fileSize,
          fileName,
          messageTimestamp: message.timestamp,
        })
        if (mirrored) return mirrored
      }

      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          // The sender's own filename becomes the mirrored object's
          // name, so saving the attachment yields `invoice.pdf` even
          // when a caption displaced the filename in content_text.
          mediaUrl: await verifyAndBuildUrl(
            message.document.id,
            message.document.filename
          ),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
    case 'voice': {
      // Meta delivers voice notes as type "audio"; YCloud and other
      // gateways use a separate "voice" envelope. Either way the media
      // lives in the same shape, so both share this one pipeline.
      const media = message.audio ?? message.voice
      if (media?.id) {
        // Voice-note hot path: resolve + download the bytes ONCE, then
        // reuse the same buffer for both the mirror and the
        // transcription. The previous shape fetched getMediaUrl twice
        // and downloaded the file twice (once for the mirror, once for
        // transcription), doubling audio latency on the way to the AI
        // reply.
        let info: Awaited<ReturnType<typeof getMediaUrl>>
        let buffer: Buffer
        try {
          info = await getMediaUrl({ mediaId: media.id, accessToken })
          buffer = (await downloadMedia({ downloadUrl: info.url, accessToken })).buffer
        } catch (err) {
          console.error(
            '[webhook][audio] Meta media fetch/download failed:',
            {
              mediaId: media.id,
              mimeType: media.mime_type,
              error: err instanceof Error ? err.message : err,
            },
          )
          return { ...empty, mediaType: media.mime_type }
        }

        let mediaUrl: string | null = null
        if (mirror) {
          mediaUrl = await mirrorInboundMedia({
            storage: supabaseAdmin().storage,
            accountId: mirror.accountId,
            mediaId: media.id,
            downloadUrl: info.url,
            accessToken,
            mimeType: info.mimeType,
            fileSize: info.fileSize,
            messageTimestamp: message.timestamp,
            // Serve the mirror from the bytes we already hold instead of
            // a second CDN round-trip (mirrorInboundMedia only uses the
            // injected download when it needs the media).
            download: async () => ({
              buffer,
              contentType: info.mimeType,
            }),
          })
        }
        mediaUrl ??= `/api/whatsapp/media/${media.id}`

        // Deferred transcription: the message row is saved immediately (with
        // content_text null) so the inbox shows the note in real time;
        // the caller transcribes these bytes in the background and writes
        // the transcript back. transcribeAudio never throws (each
        // provider failure is logged with detail and the next provider
        // is tried).
        return {
          ...empty,
          contentText: null,
          mediaUrl,
          mediaType: media.mime_type,
          pendingAudio: { buffer, mimeType: media.mime_type },
        }
      }
      return empty
    }

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    case 'button': {
      // Quick-reply tap on a TEMPLATE message. Meta delivers these under
      // their own `button` envelope rather than `interactive` above, so
      // without this case they fell through to `default` and landed in
      // the inbox as "[Unsupported message type: button]" with a null
      // interactiveReplyId — which also meant the Flows engine and the
      // `interactive_reply` automation trigger never saw the tap, so
      // nothing chained off a broadcast reply (issue #478).
      //
      // `payload` is the stable value (the analogue of
      // `button_reply.id`); `text` is the visible label. Prefer the
      // payload for routing and the label for display, each falling
      // back to the other since a template may carry only one.
      const payload = message.button?.payload || null
      const label = message.button?.text || null
      return {
        ...empty,
        contentText: label || payload,
        interactiveReplyId: payload || label,
      }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

/** Meta's namespace prefixes on a BSUID. Both mark an OPAQUE id. */
const BSUID_PREFIX_RE = /^(CO|WAID)\./i

/**
 * True when `value` is usable as a phone number: at least 7 digits and
 * nothing but digits / a leading `+` / separators.
 *
 * The point is to reject BSUIDs. `normalizePhone('CO.1008477715690681')`
 * returns `'1008477715690681'` — pure digits, 16 of them — so a naive
 * digits-only check happily promotes an identifier into the `phone`
 * column, which is exactly how 'CO.…' ended up stored as a phone. Testing
 * for the `CO.` / `WAID.` marker (and for any non-numeric character)
 * before normalizing is what actually separates the two.
 */
function isPhoneLike(value: string | null | undefined): boolean {
  if (!value) return false
  const trimmed = value.trim()
  if (!trimmed) return false
  if (BSUID_PREFIX_RE.test(trimmed)) return false
  // Only digits, an optional leading '+', and the usual separators.
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return false
  return normalizePhone(trimmed).length >= 7
}

/**
 * Extract a BSUID from whichever field carries it, returning the id with
 * its namespace prefix stripped, or null when the value isn't one.
 *
 * Candidates are checked in order and each is classified: a real phone
 * number is NOT returned as a BSUID. `wa_id` is included as a last resort
 * because for unregistered senders Meta sometimes puts the 'CO.…' id there
 * instead of a number.
 */
function firstOpaqueId(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (!trimmed) continue
    if (BSUID_PREFIX_RE.test(trimmed)) {
      return trimmed.replace(BSUID_PREFIX_RE, '').trim() || null
    }
  }
  return null
}

/**
 * Normalize a WhatsApp handle to its display form, leading '@' included:
 * `'humberto'` → `'@humberto'`, `'@humberto'` → `'@humberto'`,
 * `'@@humberto'` → `'@humberto'`.
 *
 * Returns null for anything that isn't a plausible handle. This is the
 * guard that keeps a BSUID from being stored as a username: 'CO.1008…'
 * contains a dot and digits but no handle characters, so it's rejected
 * outright rather than becoming '@CO.1008…'.
 */
function withAtSign(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim().replace(/^@+/, '')
  if (!trimmed) return null
  if (BSUID_PREFIX_RE.test(trimmed)) return null
  // Handles are letters, digits, dot, underscore, hyphen. No spaces, no
  // digits-only values (that's a phone number in disguise).
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null
  // All digits with no dot/underscore/hyphen is a phone number, not a
  // handle — reject so we never write a number into `username`.
  if (/^\d+$/.test(trimmed)) return null
  return `@${trimmed}`
}

/**
 * Repair contacts whose `phone` holds a BSUID instead of a number.
 *
 * Earlier versions of this handler stored the sender's identifier in
 * `phone`, so rows like `'CO.1008477715690681'` ended up there. Those are
 * undeliverable (Meta rejects a 'CO.…' as `to`) and they also poison the
 * phone-suffix dedupe pre-filter, which is why such a contact never merged
 * with the real '573122182949' row for the same person.
 *
 * The fix is a lookup by the identity fields we DO trust (`wa_user_id`
 * first, then `username`, then `name`) among that contact's siblings in
 * the same account:
 *   - a sibling with a real number  → adopt that number;
 *   - a sibling with a username     → adopt the @-prefixed handle.
 * Rows with no recoverable number are left alone rather than deleted: the
 * conversation history is worth more than an undeliverable `phone`, and
 * the next inbound from that person can still supply a real number.
 *
 * Best-effort and self-limiting: once repaired the row no longer matches
 * the `like` filter below, so repeat deliveries are a cheap no-op.
 */
async function repairBsuidPhoneContacts(): Promise<void> {
  try {
    const db = supabaseAdmin()

    // PostgREST `like` needs the wildcard in the value. 'CO.%' / 'WAID.%'
    // covers both namespace markers Meta emits.
    const { data: coBroken, error } = await db
      .from('contacts')
      .select('id, account_id, phone, name, username, wa_user_id')
      .like('phone', 'CO.%')

    // WAID. ids are rarer; check them too but stay quiet if neither matches.
    const { data: waidBroken } = await db
      .from('contacts')
      .select('id, account_id, phone, name, username, wa_user_id')
      .like('phone', 'WAID.%')

    const broken = [...(coBroken ?? []), ...(waidBroken ?? [])]
    if (error && (!coBroken || coBroken.length === 0) && broken.length === 0) return
    if (broken.length === 0) return

    for (const row of broken as Array<{
      id: string
      account_id: string
      phone: string
      name?: string | null
      username?: string | null
      wa_user_id?: string | null
    }>) {
      const patch: Record<string, unknown> = {}

      // The BSUID is the row's real identity — record it properly so the
      // next inbound resolves by `wa_user_id` instead of by phone.
      const bsuid = firstOpaqueId(row.phone, row.wa_user_id)
      if (bsuid && !row.wa_user_id) patch.wa_user_id = bsuid

      // Derive the @-prefixed handle from the stored name when we can.
      // `withAtSign` rejects anything that isn't handle-shaped, so a
      // display name like 'Humberto Manrique' is skipped rather than
      // turned into '@Humberto Manrique'.
      const handle = withAtSign(row.username) ?? null
      if (handle && handle !== row.username) patch.username = handle

      // Look for a sibling in the same account that has a real number and
      // shares an identity field with this row.
      const realPhone = await findRealNumberForIdentity(db, row)
      if (realPhone) patch.phone = realPhone

      if (Object.keys(patch).length === 0) continue

      await db
        .from('contacts')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('account_id', row.account_id)

      console.log(
        `[webhook] repaired contact ${row.id}: phone ${row.phone} → ${(patch.phone as string) ?? '(kept)'} (identity: ${Object.keys(patch).join(', ')})`,
      )
    }
  } catch (err) {
    console.warn(
      '[webhook] repair: BSUID-as-phone cleanup failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Find a real phone number among a contact's siblings, matching on the
 * identity fields we trust. Returns null when nobody has one yet.
 */
async function findRealNumberForIdentity(
  db: ReturnType<typeof supabaseAdmin>,
  row: { account_id: string; name?: string | null; username?: string | null; wa_user_id?: string | null },
): Promise<string | null> {
  const clauses: string[] = []
  if (row.wa_user_id) clauses.push(`wa_user_id.eq.${row.wa_user_id}`)
  const handle = withAtSign(row.username)
  if (handle) clauses.push(`username.eq.${handle}`)
  if (row.name) clauses.push(`name.eq.${row.name}`)
  if (clauses.length === 0) return null

  const { data } = await db
    .from('contacts')
    .select('phone')
    .eq('account_id', row.account_id)
    .or(clauses.join(','))
    .limit(25)

  for (const candidate of (data ?? []) as Array<{ phone: string }>) {
    if (isPhoneLike(candidate.phone)) return normalizePhone(candidate.phone)
  }
  return null
}

/**
 * Delete contacts with no usable `phone`, together with their
 * conversations and messages.
 *
 * Earlier versions of this handler created a contact for a BSUID-only or
 * username-only sender with `phone` left empty. Those rows are
 * undeliverable (`engineSend*` throws "contact not found for this
 * account"), and they poison every later lookup, so the BSUID/username
 * resolution added above can't ever merge them back.
 *
 * Only rows with a `wa_user_id` or `username` are auto-merged into the
 * contact that actually owns that identity; anything else is genuinely
 * unaddressable and is removed. Children go first — `conversations` and
 * `messages` have FKs to `contacts` — and the whole thing is scoped per
 * account so one tenant can never delete another's rows.
 *
 * Failures are swallowed: this is opportunistic hygiene, and it must not
 * stop the inbound message that triggered it.
 */
async function purgeEmptyPhoneContacts(): Promise<void> {
  try {
    const db = supabaseAdmin()

    // `.or('phone.is.null,phone.eq.')` is the PostgREST spelling of
    // "NULL or empty string".
    const { data: orphans, error } = await db
      .from('contacts')
      .select('id, account_id, wa_user_id, username')
      .or('phone.is.null,phone.eq.')

    if (error || !orphans || orphans.length === 0) return

    // Group by account: the deletes below are account-scoped, and mixing
    // tenants in one query would need an `account_id.eq.X,account_id.eq.Y`
    // filter we can't express cleanly.
    interface OrphanRow {
      id: string
      account_id: string
      wa_user_id?: string | null
      username?: string | null
    }
    const rows = orphans as OrphanRow[]
    const byAccount = new Map<string, OrphanRow[]>()
    for (const row of rows) {
      const list = byAccount.get(row.account_id) ?? []
      list.push(row)
      byAccount.set(row.account_id, list)
    }

    for (const [accountId, accountRows] of byAccount) {
      const ids = accountRows.map((r) => r.id)
      const { error: convErr } = await db
        .from('conversations')
        .delete()
        .eq('account_id', accountId)
        .in('contact_id', ids)
      if (convErr) {
        console.warn(
          `[webhook] purge: could not delete conversations for ${ids.length} empty-phone contact(s):`,
          convErr.message,
        )
        continue
      }

      // `messages.conversation_id` was just removed, so anything left for
      // these contacts is a row with no conversation — a leftover from an
      // earlier partial failure.
      const { error: msgErr } = await db
        .from('messages')
        .delete()
        .eq('sender_type', 'customer')
        .is('conversation_id', null)
      if (msgErr) {
        console.warn(
          '[webhook] purge: could not delete orphaned messages:',
          msgErr.message,
        )
      }

      const { error: delErr } = await db
        .from('contacts')
        .delete()
        .eq('account_id', accountId)
        .in('id', ids)
      if (delErr) {
        console.warn(
          '[webhook] purge: could not delete empty-phone contacts:',
          delErr.message,
        )
        continue
      }

      console.log(
        `[webhook] purge: removed ${ids.length} contact(s) with no phone in account ${accountId}` +
          (accountRows.some((r) => r.wa_user_id || r.username)
            ? ' — identity fields present, expect them re-created on next inbound'
            : ''),
      )
    }
  } catch (err) {
    console.warn(
      '[webhook] purge: empty-phone contact cleanup failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
  }
}

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

/** Everything Meta told us about who sent this message. */
interface SenderIdentity {
  /** Digit-only phone number, or '' when Meta sent no number. */
  phone: string
  /** BSUID, when the sender isn't on a registered number. */
  waUserId: string | null
  /** Public @username, without the leading '@'. */
  username: string | null
  /** WhatsApp profile name. */
  name: string
}

/**
 * Resolve the contact for an inbound message, matching on ANY of the
 * three identifiers Meta can send, and never inserting a second row for
 * someone we already track.
 *
 * Match order is deliberate:
 *   1. BSUID    — an opaque id that uniquely identifies a person within a
 *                WABA, so it's the only truly unambiguous key we have.
 *   2. phone    — via the shared `phonesMatch` helper, so the webhook,
 *                the manual form and CSV import all agree on "same
 *                number" (including trunk-prefix tolerance).
 *   3. username — a public handle; stable across renames, and the only
 *                handle available when Meta sends neither number nor BSUID.
 *   4. name-only— a row created from the form / CSV with no number yet.
 *
 * The old code only ever matched on (2). A sender who first reached us as
 * a bare BSUID and later messaged from their registered number therefore
 * got a SECOND contact row — the duplication this replaces.
 */
async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  sender: SenderIdentity
): Promise<ContactOutcome | null> {
  const db = supabaseAdmin()
  const { phone, waUserId, username, name } = sender

  // 1. BSUID — exact, and unique per (account, BSUID) by migration 048.
  let existingContact: ContactRow | null = null
  if (waUserId) {
    const { data } = await db
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .eq('wa_user_id', waUserId)
      .limit(1)
    if (data && data.length > 0) existingContact = data[0] as ContactRow
  }

  // 2. Phone — fuzzy-matched by the shared helper so all write paths agree.
  if (!existingContact && phone) {
    existingContact = await findExistingContact(db, accountId, phone)
  }

  // 3. Username.
  if (!existingContact && username) {
    const { data } = await db
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .eq('username', username)
      .limit(1)
    if (data && data.length > 0) existingContact = data[0] as ContactRow
  }

  // 4. A row with this WhatsApp profile name but no number assigned yet
  //    (created from the form or CSV). Adopt it rather than duplicate.
  if (!existingContact && name) {
    existingContact = await findContactByNameWithoutPhone(db, accountId, name)
  }

  if (existingContact) {
    // Backfill whatever this payload tells us that the row is missing, so
    // replies always go to a usable destination and the inbox can show the
    // handle Meta now knows:
    //   - phone:      promote a fuzzy (trunk-prefix / format) match to the
    //                exact sender number so outbound sends don't fail.
    //   - name:       only when the row has none (never clobber a
    //                manually-chosen display name).
    //   - username:   only when we learned one and the row has none.
    //   - wa_user_id: only when we learned one and the row has none.
    const updates: Record<string, unknown> = {}
    const currentPhone = normalizePhone(existingContact.phone ?? '')
    // Overwrite `phone` only with a REAL number. Promoting a BSUID over a
    // working phone would break delivery for a contact that is perfectly
    // reachable today.
    if (phone && currentPhone !== phone) updates.phone = phone
    if (name && !existingContact.name) updates.name = name
    if (username && !existingContact.username) updates.username = username
    if (waUserId && !existingContact.wa_user_id) updates.wa_user_id = waUserId

    if (Object.keys(updates).length > 0) {
      await db
        .from('contacts')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
      Object.assign(existingContact, updates)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column; user_id is the
  // NOT NULL FK audit column (no inbound message has a single "user who
  // created" it — we attribute to the WhatsApp config owner as a stable
  // default).
  //
  // `phone` is NOT NULL, so we promote the BSUID (then the username) into
  // it when Meta sent no number. A BSUID in `phone` is still something the
  // outbound path can attempt, whereas '' makes `engineSend*` throw
  // "contact not found" and silently drop every reply — the exact symptom
  // of "typing indicator shows, nothing arrives". The authoritative BSUID
  // also goes in its own column for future matches.
  const phoneForRow = phone || waUserId || username || 'unknown'

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone: phoneForRow,
      name: name || username || phoneForRow,
      username: username ?? undefined,
      wa_user_id: waUserId ?? undefined,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(
        supabaseAdmin(),
        accountId,
        phoneForRow,
      )
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — Meta retries a delivery, or a
  // batch fans out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
