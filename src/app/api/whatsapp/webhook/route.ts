import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl, downloadMedia, sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import {
  extractPhoneFromText,
  isNamespacedMetaId,
  isPlaceholderValue,
  normalizePhone,
} from '@/lib/whatsapp/phone-utils'
import { flushPendingReplies } from '@/lib/whatsapp/pending-reply'
import * as recipientResolver from '@/lib/whatsapp/recipient-resolver'
import {
  findExistingContact,
  isUniqueViolation,
} from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { findMergeableOrphan, mergeContactInto } from '@/lib/contacts/merge'
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
import { cancelPendingFollowUps, resetResponseWaitOnInbound } from '@/lib/whatsapp/follow-up-worker'
import {
  describeInboundContent,
  normalizeContentType,
} from '@/lib/ai/inbound-content'
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

/**
 * Whether `messages.raw_meta_payload` is believed to exist (migration 052).
 *
 * `null` = not yet probed, so the column is included optimistically.
 */
let rawMetaPayloadColumn: boolean | null = null

/**
 * Test-only: forget the cached migration-052 verdict.
 *
 * The flag is instance-scoped by design (one extra round trip per cold
 * start), which would otherwise leak between test cases — a single fallback
 * test would silently strip the column from every test after it.
 */
export function __resetRawMetaPayloadColumnForTests() {
  rawMetaPayloadColumn = null
}

/** PostgREST reports an unknown column as 42703 / PGRST204, or in prose. */
function isMissingColumnError(message: string): boolean {
  return /column .* does not exist|42703|PGRST204|schema cache/i.test(message)
}

/**
 * Insert one inbound message, tolerating a database without migration 052.
 *
 * `raw_meta_payload` is written because it is the only place the BSUID of a
 * sender who disclosed no phone number survives — `sender_phone` is NULL for
 * exactly that sender, and the handle is not a deliverable address. Without
 * the column, `recoverAddressesFromHistory` can never resolve those contacts
 * and every campaign to them fails.
 *
 * But PostgREST rejects the WHOLE request when any named column is missing, so
 * adding it unguarded would turn an unapplied 052 into "every inbound message
 * is dropped" — the inbox, unread counts, automations and flows all broken.
 * Losing one optional audit column is an acceptable degradation; losing every
 * inbound message is not. So the insert is retried once without the column and
 * the verdict is cached for the life of the instance, making the cost at most
 * one extra round trip per cold start.
 *
 * Only a missing-column error triggers the retry: an RLS denial, a constraint
 * violation or a network fault is reported rather than masked by a second
 * identical attempt.
 */
async function upsertInboundMessage(
  row: Record<string, unknown>,
): Promise<{ data: unknown[] | null; error: { message: string } | null }> {
  const attempt = async (toInsert: Record<string, unknown>) =>
    await supabaseAdmin()
      .from('messages')
      .upsert(toInsert, {
        onConflict: 'conversation_id,message_id',
        ignoreDuplicates: true,
      })
      .select('id')

  const first = await attempt(row)

  if (!first.error) {
    rawMetaPayloadColumn = true
    return {
      data: (first.data ?? null) as unknown[] | null,
      error: null,
    }
  }

  const hasColumn = Object.prototype.hasOwnProperty.call(
    row,
    'raw_meta_payload',
  )
  if (!hasColumn || !isMissingColumnError(first.error.message)) {
    return {
      data: (first.data ?? null) as unknown[] | null,
      error: { message: first.error.message },
    }
  }

  console.error(
    '[webhook] messages.raw_meta_payload is missing — retrying without it. ' +
      'BSUID resolution for handle contacts stays broken until migration 052 ' +
      'is applied.',
    first.error.message,
  )
  rawMetaPayloadColumn = false

  const { raw_meta_payload: _omitted, ...withoutColumn } = row
  void _omitted
  const retry = await attempt(withoutColumn)
  return {
    data: (retry.data ?? null) as unknown[] | null,
    error: retry.error ? { message: retry.error.message } : null,
  }
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
   * Shared contact card(s). Not part of Meta's documented inbound set for
   * every gateway, but it does arrive on some providers and the parser has to
   * be able to name who was shared instead of storing an empty row.
   */
  contacts?: Array<{
    name?: { first_name?: string; last_name?: string; formatted_name?: string }
    phones?: Array<{ phone?: string; wa_id?: string; type?: string }>
    emails?: Array<{ email?: string; type?: string }>
  }>
  /** Customer poll / poll-vote payloads. */
  poll?: { name?: string; options?: Array<{ title?: string }> }
  poll_response?: {
    poll_name?: string
    selected_options?: Array<{ title?: string }>
  }
  /** Customer order payload. */
  order?: {
    catalog_id?: string
    text?: string
    product_items?: Array<{ product_retailer_id?: string; quantity?: string }>
  }
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
         *  profile exposes one, so it's optional. */ username?: string;
          /** Real number Meta sometimes discloses alongside the wa_id. */
          phone?: string }
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
      // Normalize any stored phone that isn't digits-only (e.g. a legacy
      // '+57 315 566 7789') so outbound `to` is always clean.
      await sanitizeStoredPhones()
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
  // `phone` held something like 'CO.9988776655443322' — not a number, so
  // `sanitizePhoneForMeta` rejected it and every send failed while the
  // typing indicator still fired. Classify first, then store each value
  // in the column it actually belongs to.
  // ============================================================

  // Pick the real, dialable number Meta gave us — `messages[].from`,
  // `contacts[0].wa_id`, or `contacts[0].profile.phone`, whichever is the
  // first one that is genuinely phone-shaped. When Meta discloses NO number
  // (only a BSUID / `@handle`), `phone` is set to the literal 'unknown'
  // placeholder: `phone` must stay a clean E.164 column and NEVER absorb a
  // BSUID or an `@handle`. The opaque id is kept in `wa_user_id` instead.
  const trimmedFrom = (message.from ?? '').trim()
  const trimmedWaId = (contact.wa_id ?? '').trim()
  const trimmedProfilePhone = (
    (contact.profile as { phone?: string } | undefined)?.phone ?? ''
  ).trim()
  // The opaque id and the public handle come from the contact payload
  // regardless of which field carried them.
  const senderUserId = firstOpaqueId(
    contact.user_id,
    message.from_user_id,
    !isPhoneLike(contact.wa_id ?? '') ? contact.wa_id : null,
    !isPhoneLike(message.from ?? '') ? message.from : null,
  )
  const senderUsername = withAtSign(
    contact.profile.username || (contact as { username?: string }).username,
  )
  const senderName = contact.profile.name?.trim() || null

  // Meta's CANONICAL deliverable id for this sender, extracted from
  // `entry.changes.value.contacts[0].wa_id` first and then from
  // `messages[0].from`, skipping Meta's own 'unknown' placeholder, a
  // namespaced BSUID and a public handle (CASO C: those are identity
  // markers, never destinations).
  //
  // This value MUST survive into `contacts.wa_id` / `contacts.recipient_id`.
  // It is the destination every outbound ladder consults the moment
  // `phone` is 'unknown' — which is exactly the state a privacy-shielded
  // sender lives in. The BSUID (`contacts[0].user_id`) NEVER lands here:
  // it is stored in its own `wa_user_id` column by rule 2 of the recipient
  // engine, so no ladder can ever mistake it for a sendable address.
  const metaSendId =
    [trimmedWaId, trimmedFrom].find(
      (value) =>
        value &&
        !isPlaceholderValue(value) &&
        !isNamespacedMetaId(value) &&
        !value.startsWith('@'),
    ) ?? null

  // RECEPTOR_ENVIO: 'phone' holds ONLY a real E.164 number — never a
  // '@' handle and never a long BSUID. Priority: `messages[0].from`,
  // `contacts[0].wa_id`, `contacts[0].profile.phone`, first dialable one
  // wins (so a BSUID in `from` automatically yields to the real number in
  // `wa_id`). The BSUID lives in `wa_user_id`, the @handle in `username`.
  const rawPhone = isPhoneLike(trimmedFrom)
    ? normalizePhone(trimmedFrom)
    : isPhoneLike(trimmedWaId)
      ? normalizePhone(trimmedWaId)
      : isPhoneLike(trimmedProfilePhone)
        ? normalizePhone(trimmedProfilePhone)
        : 'unknown'

  // The address we report for this sender. A real number always wins; the
  // BSUID is only a label so an operator reading the logs can tell which
  // conversation a message belongs to.
  const senderPhone = rawPhone || senderUserId || 'unknown'

  // Human-facing label. The @username is more stable than the profile
  // name (people rename themselves), so it wins when present. Stored on
  // the contact row inside findOrCreateContact.

  // Per-message breadcrumb: this is where you confirm the inbound reached
  // processing at all, and the steps below all reference this id.
  const maskedSender =
    senderPhone && senderPhone.length > 4
      ? `…${senderPhone.slice(-4)}`
      : senderPhone
  console.log(
    `[webhook] processing ${message.type} message ${message.id} from ${maskedSender} (account ${accountId})`
  )
  console.log('-> [EXTRACTED DATA]', {
    effectivePhone: senderPhone,
    // Meta's id captured from wa_id / messages[0].from — the value that
    // lands in contacts.wa_id + contacts.recipient_id and becomes the
    // outbound destination when phone is 'unknown'.
    meta_wa_id: metaSendId,
    extractedUser: senderUsername || senderUserId || senderName,
    hasRealPhone: Boolean(rawPhone && rawPhone !== 'unknown'),
    idType: isPhoneLike(senderPhone)
      ? 'e164-phone'
      : senderUserId
        ? 'bsuid'
        : senderUsername
          ? 'username'
          : 'unknown',
    wa_user_id: senderUserId ? `${senderUserId.slice(0, 4)}…` : null,
    username: senderUsername,
  })

  // Show the WhatsApp typing indicator IMMEDIATELY so the customer sees
  // the bot "is typing" while we process text / voice notes / button
  // taps. Fire-and-forget and strictly best-effort: a failed indicator
  // must never break inbound processing. Meta dismisses it automatically
  // when the reply message is delivered, or after 25 seconds, whichever
  // comes first.
  //
  // `interactive` (reply button / list row) and `button` (quick reply on
  // a template) are included because the AI answers them — see the
  // auto-reply gate below. Without the indicator a tap looked identical
  // to the bot ignoring the customer: the menu vanished, nothing was
  // written back, and there was no sign anything was happening.
  if (
    message.type === 'text' ||
    message.type === 'audio' ||
    message.type === 'voice' ||
    message.type === 'interactive' ||
    message.type === 'button'
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

  // Find or create contact. Resolves on BSUID -> phone -> username -> name,
  // so a sender we've already seen never gets a second row.
  //
  // The 4th argument carries the Meta Cloud API v26.0 identity columns
  // (migration 053). Passing them is what makes `contacts.wa_id` a real
  // value instead of a permanently NULL column: `resolveBroadcastAddress`
  // reads that column as a destination tier, so a contact whose only usable
  // address is a Meta id was undeliverable in broadcasts until this was wired
  // up. Every field is omitted when the payload doesn't carry a real value —
  // `wa_id` is literally the string 'unknown' for an unregistered sender, and
  // persisting THAT would poison the destination tier it feeds and pollute
  // `idx_contacts_wa_id`, which treats any non-empty value as a real id.
  const metaIdentity = {
    // Meta's own canonical id for this contact, captured from
    // `contacts[0].wa_id` and then `messages[0].from` — the value
    // metaSendId resolved above. Both columns are hydrated from it because
    // BOTH are read by the outbound address ladders; leaving one empty is
    // what made a privacy-shielded contact undeliverable on one send path
    // and fine on another. Including the phone-shaped case, where it merely
    // duplicates `phone`: a phone-shaped `wa_id` is inert as a destination
    // (`contact.phone` wins first) but it is still the id Meta used to
    // reach this contact, so that is what the column records. A BSUID is
    // NEVER stored here (rule 2: it lives only in `wa_user_id`).
    wa_id: metaSendId ?? undefined,
    // Our business line that received the message, not the sender's id.
    phone_number_id: phoneNumberId || undefined,
    identity_type: classifyIdentityType({
      phone: rawPhone,
      opaqueId: senderUserId,
      waId: metaSendId,
      username: senderUsername,
    }),
    display_name: senderName ?? undefined,
  }
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    {
      phone: rawPhone,
      waUserId: senderUserId,
      username: senderUsername,
      name: senderName ?? contact.profile.name,
    },
    metaIdentity,
  )
  if (!contactOutcome) {
    console.error(
      `[webhook] could not resolve or create a contact for ${senderPhone} — dropping message ${message.id} before it reaches the AI.`
    )
    return
  }
  let contactRecord = contactOutcome.contact

  // Automatic merge of a BSUID-only orphan into this contact.
  //
  // This payload carries a REAL phone number. If the same person also has an
  // orphan row from an earlier message they sent while unregistered (that row
  // holds their BSUID in `phone`), the resolution above matched the real
  // number's row and the orphan is left behind with its own conversation —
  // two rows, one person, a split thread and a stale contact in the list.
  //
  // Folding the orphan in keeps the history whole and, crucially, moves the
  // BSUID onto the survivor. That BSUID is what lets the next message from
  // this unregistered number resolve to the right contact instead of
  // creating a third row.
  //
  // Best-effort: a merge failure must never drop the inbound, so it logs
  // and continues. The next delivery retries.
  if (rawPhone) {
    const merged = await autoMergeOrphanInto(supabaseAdmin(), accountId, contactRecord)
    if (merged) contactRecord = merged
  }

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
    phoneNumberId,
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

  // Reactions are acknowledged into `message_reactions` AND fall through to
  // the normal pipeline as a stored message.
  //
  // This used to `return` here, which meant a reaction was invisible to the
  // agent: it could not tell the customer had approved a quote or reacted to a
  // photo it had just sent, so it would sometimes re-raise the same topic.
  // The row is persisted and enters the model's context; `suppressReply` below
  // keeps the actual send out of it, because a bare 👍 is an acknowledgement
  // and answering "thanks for the like!" to every reaction would be spam.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
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

  // Every inbound message gets a sentence the agent can work with.
  //
  // `parseMessageContent` can legitimately come back with nothing to say: an
  // uncaptioned photo, a sticker (its case never set text), a document with
  // neither caption nor filename, a location with no coordinates, or any Meta
  // type this build has not seen. That emptiness used to end the exchange -
  // the auto-reply gate skipped anything with no text, so the customer sent a
  // sticker and got silence back.
  //
  // Filling it here rather than inside each case means a type added to WhatsApp
  // next year is covered by default instead of by a patch someone has to
  // remember. The real content still wins whenever the parser found any.
  const contentType = normalizeContentType(message.type)
  if (!contentText?.trim()) {
    contentText = describeInboundContent({ contentType })
  }

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
  // `contentType` was resolved above, by the shared `normalizeContentType`,
  // so the INSERT and the agent's placeholder can never disagree about what
  // this message is.

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

  const messageRow = {
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
    // The address Meta used on THIS delivery (migration 050). This is
    // the only place a number Meta disclosed survives, so the REAL
    // number is stored whenever we have one — never the BSUID that may
    // occupy the same field. `recipient-resolver` reads this column to
    // recover a deliverable destination for a contact whose `phone`
    // still holds an identifier, so writing the BSUID here would
    // perpetuate exactly the undeliverable state we're fixing.
    //
    // The placeholder guard is load-bearing: `rawPhone` is the literal
    // string 'unknown' when Meta disclosed no number, and 'unknown' is
    // truthy, so `rawPhone || message.from` used to store the placeholder
    // and never reach `message.from`. `sender_phone` is nullable, so the
    // honest value is NULL — which also keeps the placeholder out of the
    // `.not('sender_phone','is',null)` history scans entirely.
    sender_phone: rawPhone === 'unknown' ? null : rawPhone,
    // The Meta objects this row was built from (migration 052).
    //
    // `sender_phone` above is NULL whenever Meta disclosed no number —
    // which is precisely the sender we still need to reach. The BSUID for
    // that sender then survives ONLY inside these payloads:
    // `contacts[].user_id`, `contacts[].wa_id`, or `messages[].from_user_id`
    // (`from` is the literal 'unknown' there, so the dedicated id fields
    // are the only real value). `metaIdFromRawPayload` walks them, and
    // `recoverAddressesFromHistory` uses the result as the `to` for a
    // contact known publicly only by `@handle`.
    //
    // Both halves are stored, not just `message`, because Meta does not
    // always put the id in the same place: storing the message alone
    // leaves the contact-level ids unreachable and the contact stays
    // undeliverable. Whichever field carries it is a delivery-shape
    // detail, so none of the keys are assumed.
    //
    // Undefined while the column is believed to be missing (see
    // `rawMetaPayloadColumn`), so a database without migration 052 keeps
    // accepting messages instead of rejecting every inbound one.
    ...(rawMetaPayloadColumn === false ? {} : { raw_meta_payload: { message, contact } }),
    message_id: message.id,
    status: 'delivered',
    created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
    reply_to_message_id: replyToInternalId,
    // Only populated for content_type='interactive'. Migration 010 added
    // the column; null for every other content_type so existing inserts
    // behave identically.
    interactive_reply_id: interactiveReplyId,
  } as Record<string, unknown>

  const { data: insertedRows, error: msgError } =
    await upsertInboundMessage(messageRow)

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

  // SISTEMA DE SEGUIMIENTOS: un mensaje del cliente SÍ llegó (no un
  // replay idempotente) — cualquier recordatorio PENDING para este hilo
  // queda cancelado. El cliente respondió y el siguiente reply del bot
  // programará uno nuevo. Best-effort: no puede bloquear el inbound.

  // Timer 1 — cancel any PENDING follow-up for the thread.
  await cancelPendingFollowUps(supabaseAdmin(), conversation.id)

  // Timer 2 — REGLA CRÍTICA: cada mensaje entrante REINICIA la espera de
  // respuesta en vez de cancelarla (NO cancela: si el switch del chat está
  // habilitado, la cuenta regresiva vuelve a partir de NOW + N minutos —
  // el cliente que sigue escribiendo nunca llega a 00:00). La duración N
  // se relee de la última fila del chat (o el default de 10 min). Cuando la
  // espera completa su ciclo, el RUNNER apaga el switch él mismo
  // (`response_wait_enabled → false`), así que aquí solo se resetea
  // MIENTRAS el switch está habilitado — al agotarse el ciclo, solo el botón
  // "↻ Reiniciar" re-arma el timer. Si el switch está OFF, cancela cualquier
  // timer ACTIVO residual. Best-effort: no puede bloquear el inbound.
  await resetResponseWaitOnInbound(supabaseAdmin(), conversation.id)

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

  // No deliverable address for this sender? Learn one from what they just
  // typed, or tell the bot to ask for it. Runs BEFORE the flow / automation /
  // AI dispatch so all three re-resolve the recipient against a real number
  // when one turns up in this very message.
  const missingPhone = await resolveMissingPhone({
    accountId,
    userId: configOwnerUserId,
    conversationId: conversation.id,
    contactId: contactRecord.id,
    contactPhone: contactRecord.phone,
    inboundText: contentText,
    isFirstInboundMessage,
  })

  // Voice notes transcribe in the BACKGROUND. The row above was saved
  // immediately (content_text null) so the inbox update is real-time —
  // transcription latency no longer gates the insert. Here, after the
  // insert, the transcript is written back onto the row and treated as
  // The payload for flows / automations / the AI.
  const isVoiceNote = message.type === 'audio' || message.type === 'voice'

  // Note the absence of a "please write instead" direct send here. There used
  // to be one: on a failed transcription it messaged the customer from this
  // handler and then let the agent answer as well, so a single voice note
  // produced two WhatsApp messages. The agent now owns the reply, once, and
  // this layer only records what arrived.

  if (isVoiceNote) {
    if (pendingAudio) {
      const transcript = await transcribeAudio(
        pendingAudio.buffer,
        pendingAudio.mimeType
      )
      if (!transcript) {
        console.error(
          '[webhook][audio] transcription failed across all providers:',
          {
            messageId: message.id,
            mimeType: pendingAudio.mimeType,
            audioBytes: pendingAudio.buffer.byteLength,
          }
        )
        // No `return` here. The customer still spoke and still expects an
        // answer, so the note is described rather than swallowed and the
        // exchange continues below into Flow, automations and the AI - which
        // will ask them to repeat it in writing. Returning ended the
        // conversation on a technical failure the customer did not cause.
        contentText = describeInboundContent({ contentType: 'audio' })
        await persistVoiceFallbackText(
          (insertedRows[0] as { id: string }).id,
          contentText,
        )
      } else {
        // Transcription succeeded: persist the transcript back onto the row
        // (fires a second realtime event that swaps the audio bubble for
        // readable text) and refresh the conversation-list summary, which
        // the unread bump stamped with `[audio]` a moment ago.
        contentText = transcript
        const { error: transcriptError } = await supabaseAdmin()
          .from('messages')
          .update({ content_text: transcript })
          .eq(
            'id',
            (insertedRows[0] as { id: string }).id,
          )
        if (transcriptError) {
          console.error('[webhook][audio] failed to persist transcript:', transcriptError)
        }
        await supabaseAdmin()
          .from('conversations')
          .update({ last_message_text: transcript })
          .eq('id', conversation.id)
      }
    } else if (!contentText) {
      // Media fetch/download failed in parseMessageContent — no bytes to
      // transcribe or mirror reliably. Same rule as above: record it and let
      // the agent ask them to write it out.
      contentText = describeInboundContent({ contentType: 'audio' })
      await persistVoiceFallbackText(
        (insertedRows[0] as { id: string }).id,
        contentText,
      )
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

  // AI auto-reply. Runs for any inbound the deterministic flow runner did
  // NOT consume (flows win over the LLM), and only when the account has
  // enabled it. Awaited inside `after()` (same reason as the webhook
  // dispatch below); `dispatchInboundToAiReply` owns its eligibility gates
  // + try/catch and never throws.
  //
  // Every reason this block is skipped is logged explicitly: this gate
  // used to be the largest silent hole in the pipeline, where a message
  // would arrive, land in the inbox, and simply never reach the LLM with
  // nothing in the logs to say why.
  //
  // Button taps ARE answered by the AI. `inboundText` already carries the
  // tapped label (parseMessageContent puts `button_reply.title` /
  // `list_reply.title` / the template quick-reply's `button.text` there), so
  // a tap reaches the model as one ordinary user turn. This used to be a
  // hard skip on the assumption that "buttons/lists are answered by their
  // own flow" — true only when a Flow is actually running. With no Flow
  // configured (the common case), pressing "Quiero información" left the
  // customer on a typing indicator forever: the tap landed in the inbox,
  // the bot said nothing, and the log even claimed the silence was by
  // design. The flow gate above already covers the real conflict, so a tap
  // that no Flow took reaches the AI like any other message.
  if (flowConsumed) {
    // The Flow already answered, so nothing goes on the wire — but the model
    // still hears about it. It used to be skipped entirely, which left the
    // agent blind to messages it had helped author: asked "confirmas la cita?" →
    // "sí" → the agent saw nothing, and could contradict a booking the Flow
    // had just made.
    console.log(
      `[webhook] message ${message.id}: a Flow consumed it — recorded as AI context, auto-reply suppressed.`
    )
  }
  console.log(
    `[webhook] message ${message.id}: dispatching to AI auto-reply (type=${message.type}, text="${inboundText.trim().slice(0, 80)}")`
  )
  await dispatchInboundToAiReply({
    accountId,
    conversationId: conversation.id,
    contactId: contactRecord.id,
    configOwnerUserId,
    // The inbound wamid - lets the bot keep WhatsApp's typing
    // indicator alive while it streams a multi-part reply.
    composeMessageId: message.id,
    // Meta disclosed no number for this sender: tell the model to ask for
    // one, since nothing can be delivered until it arrives.
    missingPhone,
    // Already answered upstream (by a Flow, or it's a reaction): the agent
    // learns about it without putting a second message on the wire.
    suppressReply: flowConsumed || message.type === 'reaction',
  })


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

    case 'contacts': {
      // Shared contact card. Name + phone when we can read them, which is what
      // the agent needs to recognise ("te mandaron el contacto de Ana") instead
      // of receiving a blank row.
      const cards = (message.contacts ?? [])
        .map((c) => {
          const name =
            c.name?.formatted_name ||
            [c.name?.first_name, c.name?.last_name].filter(Boolean).join(' ')
          const phone = c.phones?.map((p) => p.phone || p.wa_id).find(Boolean)
          return [name, phone].filter(Boolean).join(' - ')
        })
        .filter(Boolean)
      return { ...empty, contentText: cards.length ? cards.join(', ') : null }
    }

    case 'poll':
      return {
        ...empty,
        contentText:
          message.poll?.name ||
          message.poll?.options?.map((o) => o.title).filter(Boolean).join(', ') ||
          null,
      }

    case 'poll_response':
      return {
        ...empty,
        contentText:
          message.poll_response?.selected_options
            ?.map((o) => o.title)
            .filter(Boolean)
            .join(', ') ||
          message.poll_response?.poll_name ||
          null,
      }

    case 'order': {
      const items = (message.order?.product_items ?? [])
        .map((i) =>
          [i.product_retailer_id, i.quantity && `x${i.quantity}`]
            .filter(Boolean)
            .join(' ')
        )
        .filter(Boolean)
      return {
        ...empty,
        contentText: [message.order?.text, items.join(', ')]
          .filter(Boolean)
          .join(' - ') || null,
      }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

/**
 * Write the description of an untranscribable voice note onto its row.
 *
 * Best-effort like the rest of the fan-out: the customer has already been sent
 * a fallback message, so a failed write must not throw. The agent still gets
 * the description in `contentText` for this turn either way; this only makes
 * the transcript field honest for later turns and for the inbox summary.
 */
async function persistVoiceFallbackText(
  messageRowId: string,
  text: string
): Promise<void> {
  try {
    await supabaseAdmin()
      .from('messages')
      .update({ content_text: text })
      .eq('id', messageRowId)
  } catch (error) {
    console.error(
      '[webhook][audio] failed to persist the voice-note description:',
      error
    )
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

/** Meta's namespace prefixes on a BSUID. Both mark an OPAQUE id. */
const BSUID_PREFIX_RE = /^(CO|WAID)\./i

// Phone-vs-identifier classification is shared with the outbound sender
// (`recipient-resolver`). Both sides must agree on the boundary: any
// disagreement is precisely how a BSUID ended up stored as a phone number,
// with the webhook writing one value and the sender validating another.
const {
  isDialablePhone: isPhoneLike,
  isMetaIdentifier: isBsuidLike,
  toDialable,
  identityFilterParts,
} = recipientResolver

/**
 * Fold a BSUID-only orphan contact into `survivor`, returning the survivor
 * row when a merge actually happened.
 *
 * Called on every inbound that carries a real phone number. In the normal
 * case there is no orphan and this costs one indexed lookup that returns
 * nothing. It never throws: a merge failure is logged and the inbound
 * continues, because dropping a customer message over a bookkeeping
 * problem is strictly worse than leaving a duplicate row for the next
 * delivery to clean up.
 */
async function autoMergeOrphanInto(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  survivor: { id: string; phone?: string | null; username?: string | null; wa_user_id?: string | null },
): Promise<{ id: string; phone?: string | null; username?: string | null; wa_user_id?: string | null } | null> {
  try {
    const orphan = await findMergeableOrphan(db, accountId, survivor)
    if (!orphan) return null

    const outcome = await mergeContactInto(db, {
      accountId,
      survivorId: survivor.id,
      orphanId: orphan.id,
    })

    if (!outcome.merged) {
      console.warn(
        `[webhook] contact merge skipped for ${survivor.id} + ${orphan.id}:`,
        outcome.reason,
      )
      return null
    }

    // Re-read the survivor: the merge may have absorbed the BSUID or handle
    // onto it, and downstream code (the flow engine, the AI) reads these
    // fields off this object.
    const { data: refreshed } = await db
      .from('contacts')
      .select('id, phone, username, wa_user_id')
      .eq('id', survivor.id)
      .eq('account_id', accountId)
      .maybeSingle()

    return (refreshed as typeof survivor | null) ?? survivor
  } catch (err) {
    console.warn(
      '[webhook] contact merge failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/**
 * Extract a BSUID from whichever field carries it, returning the id with
 * its namespace prefix stripped, or null when the value isn't one.
 *
 * Two shapes are accepted:
 *   * explicitly prefixed — 'CO.9988776655443322' / 'WAID.…';
 *   * bare but too long to be a number — '9988776655443322' (16 digits).
 *
 * The second case is why `isBsuidLike` exists: a real phone number never
 * reaches here, but an already-stripped BSUID does, and we must not fall
 * through to treating it as a dialable number. `wa_id` is included as a
 * last resort because for unregistered senders Meta sometimes puts the id
 * there instead of a number.
 */
function firstOpaqueId(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (!trimmed) continue
    if (BSUID_PREFIX_RE.test(trimmed)) {
      return trimmed.replace(BSUID_PREFIX_RE, '').trim() || null
    }
    if (isBsuidLike(trimmed)) return trimmed
  }
  return null
}

/**
 * Categorize which kind of identifier identifies this sender, for
 * `contacts.identity_type` (migration 053).
 *
 * Ordered by how outbound sends actually route, so the value stored is the
 * one that would be used as `to`:
 *   1. a real number          -> PHONE_E164
 *   2. a LID-shaped id        -> LID      ('123456@lid')
 *   3. any other opaque id    -> BSUID    (CO.… / WAID.… / bare 16-digit)
 *   4. a handle only          -> USERNAME
 *
 * Returns undefined when the payload identifies the sender by nothing we can
 * categorize, so the column stays NULL rather than recording a guess.
 */
function classifyIdentityType(input: {
  phone: string | null | undefined
  opaqueId: string | null | undefined
  waId: string | null | undefined
  username: string | null | undefined
}): 'PHONE_E164' | 'BSUID' | 'USERNAME' | 'LID' | undefined {
  if (isPhoneLike(input.phone)) return 'PHONE_E164'
  // Checked before BSUID: a LID is opaque but routes differently, and the two
  // are indistinguishable once the namespace is stripped.
  //
  // The placeholder guard is load-bearing: Meta sends the literal string
  // 'unknown' in `contacts[].wa_id` for a sender it could not identify, and
  // that is truthy — classifying on it would record BSUID for a contact that
  // has no id at all, which is precisely what this column exists to describe.
  const opaque = [input.opaqueId, input.waId]
    .map((v) => (v ?? '').trim())
    .find((v) => v !== '' && v.toLowerCase() !== 'unknown')
  if (!opaque) return input.username ? 'USERNAME' : undefined
  if (/@lid\b/i.test(opaque)) return 'LID'
  return 'BSUID'
}

/**
 * Normalize a WhatsApp handle to its display form, leading '@' included:
 * `'usuario'` → `'@usuario'`, `'@usuario'` → `'@usuario'`,
 * `'@@usuario'` → `'@usuario'`.
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
 * `phone`, so rows like `'CO.9988776655443322'` ended up there. Those are
 * undeliverable (Meta rejects a 'CO.…' as `to`) and they also poison the
 * phone-suffix dedupe pre-filter, which is why such a contact never merged
 * with the real '573155667789' row for the same person.
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
    // Three broken shapes to look for:
    //   1. `phone like 'CO.%'`    — prefixed BSUID, original bug.
    //   2. `phone like 'WAID.%'` — the phone-scoped namespace.
    //   3. `phone` of 15+ bare digits — a BSUID whose prefix an earlier
    //      handler already stripped (exactly '9988776655443322'). PostgREST
    //      can't express a length test, so match any 15-digit run and let
    //      `isBsuidLike` filter precisely below.
    const cols =
      'id, account_id, phone, name, username, wa_user_id'

    const [coRes, waidRes, longRes] = await Promise.all([
      db.from('contacts').select(cols).like('phone', 'CO.%'),
      db.from('contacts').select(cols).like('phone', 'WAID.%'),
      db.from('contacts').select(cols).like('phone', '______________%'),
    ])

    // Union, then keep only what `isBsuidLike` confirms — the 15-digit
    // LIKE is deliberately over-broad and would otherwise catch a row
    // whose phone is legitimately long.
    const seen = new Set<string>()
    const broken = [
      ...(coRes.data ?? []),
      ...(waidRes.data ?? []),
      ...(longRes.data ?? []),
    ].filter((row) => {
      const id = String(row.id ?? '')
      if (seen.has(id)) return false
      seen.add(id)
      return isBsuidLike(String(row.phone ?? ''))
    })

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
      // display name like 'Nombre Demo' is skipped rather than
      // turned into '@Nombre Demo'.
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
 * Normalize every stored contact `phone` to digits-only E.164 form.
 *
 * Rows written before the webhook started normalizing can still hold
 * '+57 315 566 7789'-style values. Meta's `to` field is used with the
 * stored value downstream, and a dirty number there is rejected or — worse —
 * silently misrouted. A row whose phone is a BSUID/identifier is left
 * alone: `repairBsuidPhoneContacts` owns moving those to `wa_user_id`.
 *
 * Only phones that are actually dialable are rewritten; a '+' with a trunk
 * prefix or punctuation is stripped down to the digits Meta expects.
 */
async function sanitizeStoredPhones(): Promise<void> {
  try {
    const db = supabaseAdmin()

    // PostgREST has no "contains any of these chars", so OR five LIKE probes
    // covering the formatting characters a human/legacy import can produce.
    const { data, error } = await db
      .from('contacts')
      .select('id, account_id, phone')
      .or(
        'phone.like.%+%,phone.like.% %,phone.like.%-%,phone.like.%(%,phone.like.%)%',
      )
      .limit(200)

    const dirty =
      error || !data
        ? []
        : (data as Array<{ id: string; account_id: string; phone: string }>)

    for (const row of dirty) {
      if (!isPhoneLike(row.phone)) continue
      const clean = normalizePhone(row.phone)
      if (!clean || clean === row.phone) continue
      await db
        .from('contacts')
        .update({ phone: clean, updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('account_id', row.account_id)
      console.log(
        `[webhook] sanitized contact ${row.id}: phone "${row.phone}" → "${clean}"`,
      )
    }

    // Self-heal rows whose `phone` holds an '@handle': move the handle to
    // `username` and restore the numeric sender id from `wa_user_id`.
    const { data: atRows, error: atErr } = await db
      .from('contacts')
      .select('id, account_id, phone, username, wa_user_id')
      .like('phone', '@%')
      .limit(200)

    if (!atErr && atRows) {
      for (const row of atRows as Array<{
        id: string
        account_id: string
        phone: string
        username: string | null
        wa_user_id: string | null
      }>) {
        const patch: Record<string, unknown> = {
          phone: row.wa_user_id ?? 'unknown',
          updated_at: new Date().toISOString(),
        }
        if (!row.username) patch.username = row.phone.startsWith('@') ? row.phone : `@${row.phone}`
        await db
          .from('contacts')
          .update(patch)
          .eq('id', row.id)
          .eq('account_id', row.account_id)
        console.log(
          `[webhook] healed contact ${row.id}: phone "${row.phone}" → "${patch.phone}"`,
        )
      }
    }
  } catch (err) {
    console.warn(
      '[webhook] sanitize: stored-phone cleanup failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
  }
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
    const rows = (orphans as OrphanRow[]).filter(
      // A row still holding a BSUID (`wa_user_id`) or a @username is an
      // identified contact with real history — purging it would wipe the
      // thread on every inbound from that sender. Only rows whose phone
      // is empty AND which carry no identity at all are genuine junk.
      (row) => !row.wa_user_id && !row.username,
    )
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

/**
 * Learn a phone number from what the customer typed, when we don't have
 * one yet. Only a repair path: the contact is never blocked waiting for
 * a number — Meta accepts the BSUID/handle already on file in `to`, so
 * the bot answers immediately. Anything parked is flushed once the new
 * address is on file.
 *
 * Always returns false: the caller's "tell the bot to ask for a number"
 * flag is never set. Never throws: runs inside the inbound path.
 */
async function resolveMissingPhone(args: {
  accountId: string
  /** Sender-of-record for the flush, which sends on the contact's behalf. */
  userId: string
  conversationId: string
  contactId: string
  contactPhone?: string | null
  inboundText?: string | null
  isFirstInboundMessage: boolean
}): Promise<boolean> {
  const {
    accountId,
    userId,
    contactId,
    contactPhone,
    inboundText,
  } = args

  try {
    // A dialable address is already on file — nothing to repair.
    if (isPhoneLike(contactPhone ?? '')) return false

    const typed = extractPhoneFromText(inboundText)
    if (!typed) {
      // No number typed yet. Nothing blocks delivery: Meta accepts the
      // BSUID/handle already on the contact in its `to` field, so the AI
      // can answer immediately — no need to stall the thread asking for
      // a number.
      return false
    }

    const { data: updated, error: updateError } = await supabaseAdmin()
      .from('contacts')
      .update({ phone: typed, updated_at: new Date().toISOString() })
      .eq('id', contactId)
      .eq('account_id', accountId)
      .select('id, phone, wa_user_id, username')
      .maybeSingle()

    if (updateError || !updated) {
      console.warn(
        `[webhook] contact ${contactId}: could not record the number the customer typed (${typed}):`,
        updateError?.message ?? 'no row returned',
      )
      return false
    }

    console.log(
      `[webhook] contact ${contactId}: adopted the number the customer typed (${contactPhone ?? 'empty'} → ${typed}); delivering anything parked for them`,
    )

    // Best-effort: a failed flush leaves the reply parked for the next
    // trigger, which is strictly better than dropping it.
    await flushCapturedPhoneReplies(
      supabaseAdmin(),
      accountId,
      userId,
      contactId,
      updated as { phone?: string | null; wa_user_id?: string | null; username?: string | null },
    )

    return false
  } catch (err) {
    console.error(
      '[webhook] could not resolve the sender phone (non-fatal):',
      err instanceof Error ? err.message : err,
    )
    // Never block the thread: BSUIDs/handles are deliverable addresses too.
    return false
  }
}

/**
 * Deliver replies parked while this contact had no valid address.
 *
 * Same helper the "save the phone by hand" endpoint uses, so a number learned
 * from the customer's own message is flushed exactly like one typed into the
 * CRM form — including clearing the `awaiting_valid_phone` banner.
 */
async function flushCapturedPhoneReplies(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  userId: string,
  contactId: string,
  recipient: { phone?: string | null; wa_user_id?: string | null; username?: string | null },
): Promise<void> {
  const result = await flushPendingReplies({
    db: db as unknown as SupabaseClient,
    accountId,
    contactId,
    recipient,
    send: async (conversationId, text) => {
      await engineSendText({ accountId, userId, conversationId, contactId, text })
    },
  }).catch((err: unknown) => {
    console.error(
      `[webhook] contact ${contactId}: flushing parked replies after the number was captured failed:`,
      err instanceof Error ? err.message : err,
    )
    return { sent: 0, failed: 0, conversations: [] as string[] }
  })

  if (result.sent > 0) {
    console.log(
      `[webhook] contact ${contactId}: delivered ${result.sent} parked repl${result.sent === 1 ? 'y' : 'ies'} now that the number is known`,
    )
  }
}

/** Everything Meta told us about who sent this message. */
interface SenderIdentity {
  /**
   * The sender's address, verbatim from Meta: a dialable E.164 phone
   * number, a BSUID, or a @handle. Any of them is a valid outbound `to`,
   * so none of them is filtered out here.
   */
  phone: string
  /**
   * BSUID, when the sender isn't on a registered number. Stored in the
   * `wa_user_id` column; a bare BSUID may also be promoted into a new
   * contact's `phone` as a placeholder (that column is NOT NULL) until a
   * real number is known.
   */
  waUserId: string | null
  /** Public @username, WITH the leading '@'. */
  username: string | null
  /** WhatsApp profile name. */
  name: string
}

/**
 * Resolve the contact for an inbound message.
 *
 * Profiles are kept INDEPENDENT per real identity: matching only ever uses
 * the phone number or the BSUID Meta sent. Display names and @usernames are
 * never used to attach an inbound to an existing row when the sender also
 * carries a phone or BSUID, because two different numbers that happen to
 * share a profile name are two different people. A second number therefore
 * always gets its own contact and its own conversation.
 *
 * Match order is deliberate:
 *   1. BSUID    — an opaque id that uniquely identifies a person within a
 *                WABA, so it's the only truly unambiguous key we have.
 *   2. phone    — via the shared helper, so the webhook, the manual form
 *                and CSV import all agree on "same number" (trunk-prefix
 *                tolerant).
 *   3. username — used ONLY when Meta sent no number and no BSUID. In that
 *                case the handle is the sender's only identity, so it is
 *                safe to match on.
 *
 * Name is never a key: WhatsApp display names are not unique and must not
 * merge or adopt a row.
 */
async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  sender: SenderIdentity,
  metaIdentity?: {
    wa_id?: string
    phone_number_id?: string
    identity_type?: 'PHONE_E164' | 'BSUID' | 'USERNAME' | 'LID'
    display_name?: string
  }
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

  // 3. Username — ONLY when there is no phone and no BSUID. With either of
  //    those present, a handle match would fold a different number into this
  //    row, which is exactly the cross-number unification we forbid.
  if (!existingContact && !phone && !waUserId && username) {
    const { data } = await db
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .eq('username', username)
      .limit(1)
    if (data && data.length > 0) existingContact = data[0] as ContactRow
  }

  // 4. Single dynamic `.or()` pass over the strong identifiers only.
  //
  //    Steps 1–2 already cover BSUID and phone individually; this asks the
  //    same question in one round-trip for payloads that carry several
  //    identifiers at once. Username is deliberately excluded — see the
  //    match order above. Scoped to the account so it can never cross
  //    tenants.
  if (!existingContact) {
    const parts = identityFilterParts({
      phone,
      wa_user_id: waUserId,
    })
    if (parts.length > 0) {
      const { data } = await db
        .from('contacts')
        .select('*')
        .eq('account_id', accountId)
        .or(parts.join(','))
        .limit(5)
      const candidates = (data ?? []) as ContactRow[]
      if (candidates.length > 0) {
        // Prefer the strongest identifier present: a BSUID match beats a
        // phone match.
        existingContact =
          candidates.find((c) => waUserId && c.wa_user_id === waUserId) ??
          candidates.find((c) => phone && toDialable(c.phone) === phone) ??
          candidates[0]
        console.log(
          `[webhook] matched contact ${existingContact.id} via dynamic identity filter (${parts.join(' | ')})`,
        )
      }
    }
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
    const currentPhone = (existingContact.phone ?? '').trim()

    // Prefer a real number over any stored identifier, and refresh the
    // stored value when it changed. Never demote a real number to a BSUID
    // or @handle: only overwrite when the new value is dialable, or when
    // the row had no dialable value to lose.
    const incomingIsDialable = isPhoneLike(phone)
    const storedIsDialable = isPhoneLike(currentPhone)
    if (
      phone &&
      currentPhone !== phone &&
      (incomingIsDialable || !storedIsDialable)
    ) {
      updates.phone = phone
    }

    // If this payload disclosed no number (rawPhone came back as the
    // 'unknown' placeholder) but the row already carries a genuine E.164 in
    // `wa_id` / `recipient_id` — a normal sender whose number was recorded in
    // the identity column by an older version — promote it into `phone`. A
    // real number makes the outbound `to` valid; leaving it in the id column
    // is what forced a BSUID into `to` and produced Meta's (#131009) "phone
    // number format is incorrect".
    if (!updates.phone && !storedIsDialable) {
      const storedIdPhone = [existingContact.wa_id, existingContact.recipient_id]
        .map((value: unknown) => (typeof value === 'string' ? value : ''))
        .find((value) => isPhoneLike(value))
      if (storedIdPhone) updates.phone = normalizePhone(storedIdPhone)
    }

    if (name && !existingContact.name) updates.name = name
    // Only when the row has none: a handle typed by a human in the CRM is
    // authoritative and must not be replaced by a later payload.
    if (username && !existingContact.username) updates.username = username
    // The BSUID is the sender's stable identity, so it backfills whenever
    // it's missing — including when the row is currently holding the BSUID
    // in `phone` and we're about to write a real number there.
    if (waUserId && !existingContact.wa_user_id) updates.wa_user_id = waUserId

    // Meta Cloud API v26.0 identity columns (migration 053)
    if (metaIdentity?.phone_number_id && !existingContact.phone_number_id) updates.phone_number_id = metaIdentity.phone_number_id
    if (metaIdentity?.identity_type && !existingContact.identity_type) updates.identity_type = metaIdentity.identity_type
    if (metaIdentity?.display_name && !existingContact.display_name) updates.display_name = metaIdentity.display_name

    // Same hydration rule as the insert path: an existing row that is
    // missing `wa_id` / `recipient_id` gets them filled the first time a
    // later message proves the id. These were the two columns the broadcast
    // and inbox resolvers check first, so leaving them empty is what made a
    // contact look undeliverable on the first attempt and fine after the
    // next inbound filled them in — the "works after a refresh" symptom.
    //
    // Filled from `metaIdentity.wa_id` — Meta's `contacts[0].wa_id` /
    // `messages[0].from` (rule 2). A BSUID is NEVER used as the fallback:
    // it is identity data (CASO C) that lives only in `wa_user_id`, and
    // writing it into `wa_id` is how a destination that Meta silently drops
    // (#131009) got persisted in the first place.
    //
    // A stored value that is itself Meta's 'unknown' placeholder counts as
    // missing: the placeholder is truthy, so a plain `!existingContact.wa_id`
    // test would block the fill forever on a row written before the filter
    // existed. Never overwrites a REAL existing value.
    const storedWaId = (existingContact.wa_id ?? '').trim()
    const storedRecipientId = (existingContact.recipient_id ?? '').trim()
    const metaIdForContact = metaIdentity?.wa_id ?? null
    if (metaIdForContact && (!storedWaId || isPlaceholderValue(storedWaId))) {
      updates.wa_id = metaIdForContact
    }
    if (metaIdForContact && (!storedRecipientId || isPlaceholderValue(storedRecipientId))) {
      updates.recipient_id = metaIdForContact
    }

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
  // `phone` is NOT NULL, so an empty string fills it when Meta disclosed
  // no dialable number. The BSUID and @username columns (`wa_user_id`,
  // `username`) carry the identity — never promote them into `phone`,
  // because `phone` must stay a clean E.164 number for outbound sends.
  const phoneForRow = phone

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone: phoneForRow,
      name: name || username || phoneForRow || waUserId || 'unknown',
      username: username ?? undefined,
      wa_user_id: waUserId ?? undefined,
// Hydrate the numerical-identity columns from the CANONICAL wa_id
    // (Meta's `contacts[0].wa_id` / `messages[0].from`), never from the BSUID.
    //
    // A BSUID is identity data, not a destination (rule 2 / CASO C): it is
    // stored only in `wa_user_id`. Writing it into `wa_id`/`recipient_id`
    // is exactly what made senders resolve to an id Meta silently drops
    // (#131009) once `phone` holds 'unknown'.
    //
    // `recipient_id` was never written on insert at all, at any version;
    // both columns now carry the SAME canonical Meta id so no resolver
    // tier is left empty.
    recipient_id: metaIdentity?.wa_id ?? undefined,
    // OUTSIDE the metaIdentity spread on purpose: filled whenever a real
    // canonical wa_id exists; a hidden-number sender with no disclosed id
    // keeps these two NULL and relies on `wa_user_id` for identity only.
    wa_id: metaIdentity?.wa_id ?? undefined,
      identity_type:
        metaIdentity?.identity_type ?? (waUserId ? 'BSUID' : undefined),
      ...(metaIdentity && {
        phone_number_id: metaIdentity.phone_number_id,
        display_name: metaIdentity.display_name,
      }),
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
  phoneNumberId?: string | null,
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
    const existing = existingRows[0]
    // Rule 1 of the recipient engine: the business line that received the
    // message (`metadata.phone_number_id`) belongs on the CONVERSATION,
    // where the sender resolution reads it FIRST (`conversation.
    // phone_number_id` → config → env). Backfill it whenever missing or
    // stale, never overwriting a real value with an empty one.
    const stored = (existing as { phone_number_id?: string | null }).phone_number_id
    const resolved = (phoneNumberId ?? '').trim()
    if (resolved && resolved !== stored && !isPlaceholderValue(stored)) {
      await supabaseAdmin()
        .from('conversations')
        .update({ phone_number_id: resolved })
        .eq('id', (existing as { id: string }).id)
      ;(existing as { phone_number_id?: string | null }).phone_number_id = resolved
    }
    return { conversation: existing, created: false }
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      phone_number_id: (phoneNumberId ?? '').trim() || undefined,
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
