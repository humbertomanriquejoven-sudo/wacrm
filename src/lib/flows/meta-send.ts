import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
  sendTypingIndicator,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { decrypt } from '@/lib/whatsapp/encryption'
import { cleanAiReplyText } from '@/lib/whatsapp/clean-ai-text'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { splitAiReply } from '@/lib/ai/split-reply'
import { supabaseAdmin } from './admin-client'
import { armResponseWaitIfIdle } from '@/lib/whatsapp/response-wait'
import {
  resolveRecipient,
  isRecipientRejection,
  isDialablePhone,
  recipientAddressQueue,
  latestInboundAnchorId,
} from '@/lib/whatsapp/recipient-resolver'
import type { RecipientCandidate } from '@/lib/whatsapp/recipient-resolver'

// ------------------------------------------------------------
// Flows-side Meta sender (interactive variants).
//
// Mirrors src/lib/automations/meta-send.ts (engineSendText /
// engineSendTemplate) but emits interactive button + list messages.
// Kept separate from the automations file so the two engines don't
// fight over each other's shape — once both stabilize, the
// phone-variant retry + DB persistence are obvious extraction
// candidates into a shared base.
//
// PR #1 ships this in isolation: callers don't exist yet. PR #2
// brings the flow runner online and wires it up. Shipping it now
// keeps the foundation PR self-contained and unit-testable.
// ------------------------------------------------------------

/**
 * The contact columns every outbound sender needs.
 *
 * `wa_id` and `recipient_id` were missing here, so `resolveRecipient` could not
 * see them even though it consults both — the projection was silently starving
 * the resolver. One constant so the four senders below can't drift again.
 */
const OUTBOUND_CONTACT_COLUMNS = 'id, phone, wa_user_id, wa_id, recipient_id, username'

/**
 * Every address this contact could be reached at, best first, with
 * `primary` guaranteed first.
 *
 * Exported so the AI dispatcher can re-resolve after a failed send
 * without duplicating the ordering rules that `prepareRecipient` and
 * `recipientAddressQueue` share.
 */
export async function resolveOutboundAddressQueue(
  contact: RecipientCandidate,
  accountId: string,
  conversationId?: string | null,
  primary?: string,
): Promise<string[]> {
  const head =
    primary ?? (await resolveRecipient(contact, accountId, conversationId)).to
  if (!head) return []
  return recipientAddressQueue(contact, accountId, head, conversationId)
}

interface SendTextEngineArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so a flow authored by user A still sends through the
   *  WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the flow — used for INSERT audit columns
   *  and for resolving the agent's identity in logs. Not consulted
   *  for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
  /** Marks the persisted message row `ai_generated = true` so the inbox
   *  badges it as an AI reply. Only the auto-reply bot sets this;
   *  deterministic Flow/automation sends leave it false. */
  aiGenerated?: boolean
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 *
 * Used by the runner's `send_message` and `collect_input` nodes —
 * both prompt the customer with text and either auto-advance (the
 * send_message case) or suspend awaiting a text reply (collect_input).
 *
 * Wraps the same phone-variant retry + DB persistence pattern as the
 * interactive senders; the duplication will be DRY'd into a shared
 * `engineSendBase` once the v2 features (templates with variables,
 * media sends) settle.
 */
// Resolve the outbound destination once, for every sender below.
//
// A contact may have no phone number at all: senders on unregistered
// WhatsApp numbers arrive with a BSUID (`wa_user_id`) instead, and Meta
// accepts that as the `to` value just the same. `phone` wins when we have
// it — it's the canonical destination — and we fall back to the BSUID
// rather than throwing, because refusing to send is exactly the bug this
// fixes.
//
// `phoneVariants` handles trunk-prefix retries for the number case; a
// BSUID is passed through untouched because Meta treats it as an opaque
// id, not a phone to reformat.
/**
 * Address candidates to try for one send, in order.
 *
 * A real number contributes its trunk-prefix variants (the format quirks
 * `phoneVariants` encodes). A BSUID or @handle is opaque to WhatsApp's
 * number rules and has exactly one form, so it contributes itself.
 */
function sendVariantsFor(sanitized: string): string[] {
  return isDialablePhone(sanitized) ? phoneVariants(sanitized) : [sanitized]
}

/**
 * Resolve the outbound address for a contact and format it for Meta.
 *
 * Shared by every sender below so the four paths can't drift apart. The
 * address comes entirely from `resolveRecipient`, which decides at call
 * time whether this contact is reachable by number, by a number we can
 * recover from its own thread, or by a stored BSUID/handle.
 *
 * A recovered number is written back onto the contact row: without that,
 * a contact whose `phone` still holds a BSUID would re-run the lookup on
 * every single send.
 */
async function prepareRecipient(
  contact: RecipientCandidate,
  accountId: string,
  conversationId?: string | null,
): Promise<{ to: string; sanitized: string; isPhone: boolean }> {
  const recipient = await resolveRecipient(contact, accountId, conversationId)
  if (!recipient.to) throw new Error('contact not found for this account')

  if (recipient.source === 'recovered' && recipient.isPhone && contact.id) {
    await supabaseAdmin()
      .from('contacts')
      .update({ phone: recipient.to, updated_at: new Date().toISOString() })
      .eq('id', contact.id)
      .eq('account_id', accountId)
    console.log(
      `[flows] recovered real phone ${recipient.to} for contact ${contact.id} (phone held a non-dialable value)`,
    )
  }

  const sanitized = recipient.isPhone ? sanitizePhoneForMeta(recipient.to) : recipient.to
  if (recipient.isPhone && !isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${recipient.to}`)
  }

  return { to: recipient.to, sanitized, isPhone: recipient.isPhone }
}

/**
 * Resolve the #131009 anchor for one send — the shared rule every sender
 * in this file obeys.
 *
 * A dialable number is addressed directly and needs no anchor. An opaque id
 * (BSUID / wa_id / @lid / @user) is accepted by Meta only as a reply
 * quoting one of the customer's own messages, so when the caller didn't
 * bring a `contextMessageId` the thread's newest inbound wamid is looked up
 * dynamically in `messages`. No anchor + opaque destination = no
 * addressable recipient: refuse locally, BEFORE any HTTP request, instead
 * of firing one Meta drops with "Recipient phone number not in allowed
 * list" (#131009).
 */
async function resolveAnchorOrRefuse(
  db: ReturnType<typeof supabaseAdmin>,
  opts: { conversationId: string; isPhone: boolean; target: string },
): Promise<string | undefined> {
  if (opts.isPhone) return undefined
  const anchorMessageId =
    (await latestInboundAnchorId(db, opts.conversationId)) ?? undefined
  if (!anchorMessageId) {
    throw new Error(
      `cannot send to the opaque id "${opts.target}" for conversation ${opts.conversationId}: ` +
        `the thread has no inbound wamid to quote, so WhatsApp cannot address it (#131009 guard) — ` +
        `no HTTP request was sent`,
    )
  }
  return anchorMessageId
}

export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select(OUTBOUND_CONTACT_COLUMNS)
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (contactErr || !contact) {
    throw new Error('contact not found for this account')
  }
  const { to: target, sanitized, isPhone } = await prepareRecipient(
    contact,
    args.accountId,
    args.conversationId,
  )

  // #131009 anchor: an opaque id (BSUID / wa_id / @lid) is only accepted by
  // Meta as a reply to a message that contact wrote — a bare send comes back
  // as "Recipient phone number not in allowed list" and is dropped. Resolve
  // the thread's newest customer wamid now; with no anchor there is no way to
  // address this contact, so fail before any HTTP request instead of letting
  // Meta drop the message. Dialable numbers are untouched: no anchor needed.
  const anchorMessageId = await resolveAnchorOrRefuse(db, {
    conversationId: args.conversationId,
    isPhone,
    target,
  })

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  // Dynamic send loop.
  //
  // Two nested levels of retry, both recipient-scoped:
  //   * OUTER — alternate address. If Meta rejects `to` as an invalid
  //     recipient, re-resolve the contact and try a different identifier
  //     (a recovered number, the BSUID, the handle). This is the case
  //     where a stale value would otherwise drop the reply.
  //   * INNER — format variants of one address. Real numbers get their
  //     trunk-prefix variants; opaque ids have exactly one form.
  //
  // Non-recipient errors (template, permission, network) abort both loops
  // immediately: retrying those elsewhere would double-send.
  let waMessageId = ''
  let workingPhone = ''
  let lastError: unknown = null
  const addressQueue = await recipientAddressQueue(
    contact,
    args.accountId,
    target,
    args.conversationId,
  )

  for (const address of addressQueue) {
    workingPhone = address
    for (const v of sendVariantsFor(address)) {
      try {
        const r = await sendTextMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: v,
          text: args.text,
          // Quote the customer's own message. Without this the anchor
          // resolved above is pointless: an opaque destination reaches Meta
          // ONLY inside `context` (#131009).
          contextMessageId: anchorMessageId,
        })
        waMessageId = r.messageId
        workingPhone = v
        lastError = null
        break
      } catch (err) {
        lastError = err
        if (!isRecipientNotAllowedError(String(err)) && !isRecipientRejection(err)) {
          throw err
        }
      }
    }
    if (!lastError) break
    console.warn(
      `[flows] send to ${address} rejected (${lastError instanceof Error ? lastError.message : String(lastError)}); trying the contact's next identifier`,
    )
  }
  if (lastError) throw lastError

  // Persist whichever address/variant worked so the next send goes
  // straight to it. Only ever a real number — a working BSUID is recorded
  // in `wa_user_id`, never written over a phone column.
  if (contact.id && workingPhone !== sanitized && isDialablePhone(workingPhone)) {
    await db
      .from('contacts')
      .update({ phone: workingPhone, updated_at: new Date().toISOString() })
      .eq('id', contact.id)
      .eq('account_id', args.accountId)
  }

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: args.text,
    message_id: waMessageId,
    status: 'sent',
    ai_generated: args.aiGenerated ?? false,
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: waMessageId }
}

interface SendAiReplyArgs extends SendTextEngineArgs {
  /** Meta id (wamid) of the inbound message this reply answers — used to
   *  refresh WhatsApp's typing indicator between fragments. Optional: a
   *  call without it still splits + sends, just skips the composing
   *  refresh. */
  composeMessageId?: string
  /** Send the whole text as ONE bubble, skipping the paragraph splitter.
   *  Used for the deterministic booking confirmation so fecha, hora and
   *  the Google Meet link arrive together in a single message (a split
   *  could leave the link in a separate bubble or cut it off). */
  single?: boolean
}

/**
 * Send an AI-generated reply as a natural multi-part WhatsApp message.
 *
 * The text is split into paragraphs (double-newline separated) capped at
 * `MAX_AI_REPLY_MESSAGES` bubbles — overflow paragraphs are merged into
 * the final message so the customer never gets spammed with more than 3
 * texts per turn. Fragments are sent sequentially, one bubble each, and
 * each is persisted as its own `messages` row (`ai_generated = true`).
 *
 * The writing indicator the customer sees while the bot streams its
 * reply is kept alive between bubbles: WhatsApp dismisses the indicator
 * as soon as a message is delivered, so it is refreshed before every
 * fragment after the first. That refresh is strictly best-effort — a
 * failed indicator call must never block or fail the reply itself.
 */
export async function engineSendAiReply(
  args: SendAiReplyArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select(OUTBOUND_CONTACT_COLUMNS)
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact) {
    throw new Error('contact not found for this account')
  }
  const { to: target, sanitized, isPhone } = await prepareRecipient(
    contact,
    args.accountId,
    args.conversationId,
  )

  // #131009 anchor: an opaque id is deliverable only as a reply to the
  // contact's own message. `composeMessageId` (the inbound being answered)
  // is the natural anchor; without one, fall back to the thread's newest
  // customer wamid. No anchor + opaque destination = no addressable
  // recipient: refuse before the first fragment rather than fire a request
  // Meta drops. Dialable numbers need no anchor and stay untouched.
  let anchorMessageId = args.composeMessageId
  if (!isPhone && !anchorMessageId) {
    anchorMessageId =
      (await latestInboundAnchorId(db, args.conversationId)) ?? undefined
  }
  if (!isPhone && !anchorMessageId) {
    throw new Error(
      `cannot reply to the opaque id "${target}" for conversation ${args.conversationId}: ` +
        `the thread has no inbound wamid to quote, so WhatsApp cannot address it (#131009 guard) — ` +
        `no HTTP request was sent`,
    )
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)
  const normalized = cleanAiReplyText(args.text)
  if (!normalized) {
    throw new Error('empty reply text')
  }
  // `single` bypasses the paragraph splitter: the whole text — including
  // any blank line right before the Google Meet link — is delivered as
  // one WhatsApp bubble so a mandatory URL can never be cut off or split
  // into a separate message.
  const fragments = args.single ? [normalized] : splitAiReply(normalized)

  let waMessageId = ''
  let workingPhone = sanitized

  // Dynamic recipient resolution, resolved ONCE for the whole reply rather
  // than per fragment: every bubble of a reply must reach the same person,
  // and re-resolving mid-reply could split it across two addresses.
  const addressQueue = await recipientAddressQueue(
    contact,
    args.accountId,
    target,
    args.conversationId,
  )

  for (let i = 0; i < fragments.length; i++) {
    // Keep composing state alive between bubbles. The webhook already
    // fired the indicator on inbound receipt; each message send dismisses
    // it, so refresh before every fragment after the first. Fire-and-
    // forget with a swallow: the reply must go out even if Meta rejects
    // the indicator.
    if (i > 0 && args.composeMessageId) {
      await sendTypingIndicator({
        phoneNumberId: config.phone_number_id,
        accessToken,
        messageId: args.composeMessageId,
      }).catch((err) => {
        console.error(
          '[ai reply] typing indicator refresh failed:',
          err instanceof Error ? err.message : err,
        )
      })
    }

    const attempt = async (phone: string): Promise<string> => {
      const r = await sendTextMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        text: fragments[i],
        // Quote the contact's own inbound message. For an opaque id
        // (`@user` / `@lid` / BSUID) this is not optional: Meta accepts such
        // a destination only as a context-anchored reply on their wamid, and
        // a bare send comes back as (#131009) "Recipient phone number not in
        // allowed list". `anchorMessageId` prefers the message being answered
        // and falls back to the thread's newest customer wamid.
        contextMessageId: anchorMessageId,
      })
      return r.messageId
    }

    // Walk this contact's addresses until one is accepted. Non-recipient
    // errors abort immediately — resending a template/permission failure
    // to a different address would deliver the message twice.
    let lastError: unknown = null
    outer: for (const address of addressQueue) {
      for (const v of sendVariantsFor(address)) {
        try {
          waMessageId = await attempt(v)
          workingPhone = v
          lastError = null
          break outer
        } catch (err) {
          lastError = err
          if (
            !isRecipientNotAllowedError(String(err)) &&
            !isRecipientRejection(err)
          ) {
            throw err
          }
        }
      }
      console.warn(
        `[ai reply] address ${address} rejected (${lastError instanceof Error ? lastError.message : String(lastError)}); trying the contact's next identifier`,
      )
    }
    if (lastError) throw lastError

    const { error: msgErr } = await db.from('messages').insert({
      conversation_id: args.conversationId,
      sender_type: 'bot',
      content_type: 'text',
      content_text: fragments[i],
      message_id: waMessageId,
      status: 'sent',
      ai_generated: args.aiGenerated ?? false,
    })
    if (msgErr) {
      throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
    }
  }

  // Remember a real number that worked, so the next reply goes straight to
  // it. A working BSUID is never written over the phone column.
  if (contact.id && workingPhone !== sanitized && isDialablePhone(workingPhone)) {
    await db
      .from('contacts')
      .update({ phone: workingPhone, updated_at: new Date().toISOString() })
      .eq('id', contact.id)
      .eq('account_id', args.accountId)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  // TIMER 2 AUTO-ARM — the BOT answered the client, so "Esperar respuesta"
  // starts counting (the inbound that triggered this reply cancelled the
  // old countdown; the next 10 minutes are watched from here). Best-effort:
  // the reply itself ALREADY went out — an arm failure must not throw.
  try {
    await armResponseWaitIfIdle(db, {
      conversationId: args.conversationId,
      contactId: args.contactId,
      accountId: args.accountId,
    })
  } catch (err) {
    console.error(
      '[ai reply] response-wait auto-arm threw:',
      err instanceof Error ? err.message : err,
    )
  }

  return { whatsapp_message_id: waMessageId }
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  /** Public URL Meta fetches at send time. */
  link: string
  caption?: string
  /** Document-only; ignored by Meta for image/video. */
  filename?: string
}

/**
 * Send an image / video / document from the Flows engine.
 *
 * Used by the runner's `send_media` node. Auto-advances after the
 * send lands (same suspend semantics as send_message). Same
 * phone-variant retry + DB persistence as the text/interactive
 * senders; persists the outgoing message with `content_type` matching
 * the media kind so the inbox renders the right preview.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select(OUTBOUND_CONTACT_COLUMNS)
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact) {
    throw new Error('contact not found for this account')
  }
  const { to: target, sanitized, isPhone } = await prepareRecipient(
    contact,
    args.accountId,
    args.conversationId,
  )

  // #131009 anchor — same rule as the text sender: an opaque id is
  // deliverable only as a reply to the customer's own message.
  const anchorMessageId = await resolveAnchorOrRefuse(db, {
    conversationId: args.conversationId,
    isPhone,
    target,
  })

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendMediaMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
      contextMessageId: anchorMessageId,
    })
    return r.messageId
  }

  const addressQueue = await recipientAddressQueue(
    contact,
    args.accountId,
    target,
    args.conversationId,
  )
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  outerMedia: for (const address of addressQueue) {
    for (const v of sendVariantsFor(address)) {
      try {
        waMessageId = await attempt(v)
        workingPhone = v
        lastError = null
        break outerMedia
      } catch (err) {
        lastError = err
        if (
          !isRecipientNotAllowedError(String(err)) &&
          !isRecipientRejection(err)
        ) {
          throw err
        }
      }
    }
    console.warn(
      `[flows media] address ${address} rejected (${lastError instanceof Error ? lastError.message : String(lastError)}); trying the contact's next identifier`,
    )
  }
  if (lastError) throw lastError

  if (contact.id && workingPhone !== sanitized && isDialablePhone(workingPhone)) {
    await db
      .from('contacts')
      .update({ phone: workingPhone, updated_at: new Date().toISOString() })
      .eq('id', contact.id)
      .eq('account_id', args.accountId)
  }

  // content_type='image'|'video'|'document' — these are already in the
  // messages_content_type_check constraint (migration 001 + 010).
  // content_text carries the caption (or empty) so the conversation
  // list preview shows something meaningful when the user glances at it.
  const preview = args.caption?.trim() || `[${args.kind}]`
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.kind,
    content_text: args.caption ?? null,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: waMessageId }
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 *
 * Persists the outgoing message to `messages` with
 * `content_type='interactive'` and `sender_type='bot'` so the inbox
 * surfaces it with the "Button reply" affordance and the conversation
 * thread reflects the bot's prompt.
 *
 * Returns the Meta message id so the caller (engine) can stash it on
 * the `flow_runs.last_prompt_message_id` field for later reference.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'buttons' })
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 * Used when the flow needs more than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'list' })
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function sendInteractiveViaMeta(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact + whatsapp_config lookups by account_id —
  // same defense-in-depth rationale as automations/meta-send.ts.
  // Migration 017 moved both tables to account-scoped tenancy.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select(OUTBOUND_CONTACT_COLUMNS)
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact) {
    throw new Error('contact not found for this account')
  }
const { to: target, sanitized, isPhone } = await prepareRecipient(
    contact,
    input.accountId,
    input.conversationId,
  )

  // #131009 anchor — same rule as the text sender: an opaque id is
  // deliverable only as a reply to the customer's own message. This also
  // covers the automations engine, whose interactive sends delegate here.
  const anchorMessageId = await resolveAnchorOrRefuse(db, {
    conversationId: input.conversationId,
    isPhone,
    target,
  })

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', input.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'buttons') {
      const r = await sendInteractiveButtons({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        bodyText: input.bodyText,
        buttons: input.buttons,
        headerText: input.headerText,
        footerText: input.footerText,
        contextMessageId: anchorMessageId,
      })
      return r.messageId
    }
    const r = await sendInteractiveList({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      bodyText: input.bodyText,
      buttonLabel: input.buttonLabel,
      sections: input.sections,
      headerText: input.headerText,
      footerText: input.footerText,
      contextMessageId: anchorMessageId,
    })
    return r.messageId
  }

  // Dynamic recipient resolution + retry, identical policy to the text and
  // media senders: walk this contact's addresses (and format variants of
  // each) until Meta accepts one.
  const addressQueue = await recipientAddressQueue(
    contact,
    input.accountId,
    target,
    input.conversationId,
  )
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  outerInteractive: for (const address of addressQueue) {
    for (const v of sendVariantsFor(address)) {
      try {
        waMessageId = await attempt(v)
        workingPhone = v
        lastError = null
        break outerInteractive
      } catch (err) {
        lastError = err
        if (
          !isRecipientNotAllowedError(String(err)) &&
          !isRecipientRejection(err)
        ) {
          throw err
        }
      }
    }
    console.warn(
      `[flows interactive] address ${address} rejected (${lastError instanceof Error ? lastError.message : String(lastError)}); trying the contact's next identifier`,
    )
  }
  if (lastError) throw lastError

  if (contact.id && workingPhone !== sanitized && isDialablePhone(workingPhone)) {
    await db
      .from('contacts')
      .update({ phone: workingPhone, updated_at: new Date().toISOString() })
      .eq('id', contact.id)
      .eq('account_id', input.accountId)
  }

  // Persist the bot's prompt to the messages table so it appears in
  // the inbox. content_type='interactive' is supported as of
  // migration 010; sender_type='bot' distinguishes flow sends from
  // manual agent sends (the conversation list preview will pick up
  // last_message_text as a sensible summary).
  //
  // We do NOT set interactive_reply_id here — that column is reserved
  // for the customer's tap on this message, populated by the webhook
  // when their reply arrives. We DO persist the structured payload so
  // the inbox thread re-renders the buttons/rows the bot sent (round-
  // trip), matching the composer + automation send paths.
  const interactivePayload: InteractiveMessagePayload =
    input.kind === 'buttons'
      ? {
          kind: 'buttons',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          buttons: input.buttons,
        }
      : {
          kind: 'list',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          button_label: input.buttonLabel,
          sections: input.sections,
        }

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: 'interactive',
    content_text: input.bodyText,
    interactive_payload: interactivePayload,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: input.bodyText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)

  return { whatsapp_message_id: waMessageId }
}
