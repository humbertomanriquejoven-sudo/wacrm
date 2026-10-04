import { sendTextMessage } from '@/lib/whatsapp/meta-api'
import type { MessageTemplate } from '@/types'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  isDialablePhone,
  phoneVariants,
  isRecipientNotAllowedError,
  sanitizePhoneForMeta,
} from '@/lib/whatsapp/phone-utils'
import {
  resolveTemplateRow,
  templateContentText,
} from '@/lib/whatsapp/template-body'
import { supabaseAdmin } from './admin-client'
import {
  resolveBestRecipient,
  isRecipientRejection,
} from '@/lib/whatsapp/recipient-resolver'

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand. Kept here (rather than refactoring the user-facing send
// route) to avoid risk to the working manual-send path — they can
// converge in a later refactor.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
  /** Meta field destination: 'to' for phone numbers, 'recipient' for BSUID/username. */
  destination?: 'to' | 'recipient'
  /** Meta id (wamid) of the inbound message this send answers. Used to anchor
   *  the reply via `context`, which is the only way Meta delivers to a
   *  contact it cannot address directly. Resolved from the conversation when
   *  omitted, so callers rarely need to pass it. */
  contextMessageId?: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
  destination?: 'to' | 'recipient'
  contextMessageId?: string
}

/**
 * Record a delivery FAILURE as a `messages` row.
 *
 * Without this a Meta rejection left no trace in the database at all: the
 * send threw, the insert never ran, and the only evidence was a console
 * line that scrolls away. Persisting `status='failed'` with Meta's own
 * complaint in `content_text` makes the failure visible in the thread and
 * queryable in the EasyPanel logs, and keeps a retry/audit path open.
 *
 * Best-effort by design: this must never mask the original Meta error, so a
 * failure to write the row is logged and swallowed.
 */
async function recordFailedSend(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    conversationId: string
    text: string
    error: unknown
    address?: string | null
  },
): Promise<void> {
  const detail = args.error instanceof Error ? args.error.message : String(args.error)
  try {
    const { error } = await db.from('messages').insert({
      conversation_id: args.conversationId,
      sender_type: 'bot',
      content_type: 'text',
      content_text: args.text,
      status: 'failed',
      error_detail: `${detail}${args.address ? ` (to: ${args.address})` : ''}`,
    })
    if (error) {
      console.error('[meta-send] could not record the failed send:', error.message)
    }
  } catch (e) {
    console.error('[meta-send] could not record the failed send:', e)
  }
}

/**
 * The wamid of the most recent INBOUND message in a conversation.
 *
 * Meta authorizes a reply to a contact it cannot address directly (a
 * `@user` / `@lid` display id, or an anonymous id) only when the request
 * quotes the message that started the thread. This reads that id back from
 * the thread itself rather than requiring every caller to thread it through,
 * which keeps the send generic: no destination-specific knowledge, and it
 * works for any contact regardless of how they entered.
 *
 * Best-effort — a conversation with no inbound row yet simply yields null,
 * and the send then proceeds without a context anchor (and will be refused
 * by `sendTextMessage` if the address is not independently addressable).
 */
async function findInboundWamid(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<string | undefined> {
  const { data } = await db
    .from('messages')
    .select('message_id, sender_type')
    .eq('conversation_id', conversationId)
    .not('message_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(10)

  // `sender_type` distinguishes the customer's messages from our own; only
  // the customer's wamid is valid in `context`.
  for (const row of (data ?? []) as Array<{
    message_id?: string | null
    sender_type?: string | null
  }>) {
    if (row.message_id && row.sender_type !== 'bot') return row.message_id
  }
  return undefined
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' })
}

interface SendInteractiveArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  payload: InteractiveMessagePayload
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine.
 *
 * Delegates to the Flows interactive senders
 * (`engineSendInteractiveButtons` / `engineSendInteractiveList`), which
 * already own the account-scoped lookup, phone-variant retry, and the
 * `messages` insert with `interactive_payload` + `sender_type='bot'`.
 * Both engines want identical behaviour here, so there's one
 * implementation rather than a second hand-rolled copy that could drift.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args
  const common = { accountId, userId, conversationId, contactId }
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    })
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaMeta(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact + config lookups by account_id, not user_id.
  // The engine uses the service-role client (bypassing RLS); without
  // this filter, an authenticated user could fire their own
  // automations against another tenant's contact UUID and send via
  // their own WhatsApp config to that contact's phone. The 017
  // migration moved both tables to account-scoped tenancy, so the
  // check is the same defense-in-depth as before, just keyed on the
  // new tenancy column.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    // `wa_id` and `recipient_id` are selected deliberately: a contact who
    // entered through a `@user` / `@lid` display id has no dialable number,
    // and those two columns are the only place the id Meta actually used is
    // preserved. Omitting them forced the resolver to fall through to
    // `username` and then fail.
    .select('id, phone, wa_user_id, username, wa_id, recipient_id')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact) {
    throw new Error('contact not found for this account')
  }

  // Dynamic recipient resolution — nothing about the destination is hardcoded.
  // Priority is decided from the row at call time:
  //   1. a dialable `phone`;
  //   2. `wa_id` (the numeric id from the inbound message's `from`);
  //   3. `wa_user_id` (the BSUID);
  //   4. `recipient_id`;
  //   5. `username`, plus recovery from this contact's own message history.
  const recipient = await resolveBestRecipient(
    contact,
    input.accountId,
    input.conversationId,
  )
  if (!recipient.to) throw new Error('contact not found for this account')

  // Build the body based on whether this is a phone or an opaque identifier.
  const isPhone = recipient.isPhone

  // Fetch config after we know what we're sending, to avoid unnecessary decryption.
  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', input.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  // Message text — resolved template body for templates, raw text otherwise.
  // The template row is resolved ONCE here and reused for the persisted
  // `content_text` below; the two used to be fetched independently, which
  // meant a second round-trip for a row already in hand.
  let messageText: string
  let templateRow: MessageTemplate | null = null
  if (input.kind === 'template') {
    const resolved = await resolveTemplateRow(
      db,
      input.accountId,
      input.templateName,
      input.language,
    )
    templateRow = resolved.row
    messageText = templateContentText(resolved.row, input.params ?? []) ?? ''
  } else {
    messageText = input.text
  }

  // Resolve the outbound address.
  //
  // The resolved address is passed as `to` and NOTHING else:
  // `sendTextMessage` owns the routing decision, classifying the value into
  // Meta's `to` (E.164 phone) or `recipient` (opaque id such as a BSUID or a
  // `@lid`). This module previously declared its own input shape with a
  // `recipient` field and sent `to: ''` for the non-phone case — but
  // `sendTextMessage` never accepted that field, so the id was silently
  // discarded and `to: ''` tripped `assertDialableRecipient`. Every BSUID /
  // `@lid` automation send therefore threw before reaching the network.
  //
  // `contextMessageId` anchors the reply to the inbound wamid. That block is
  // the ONLY thing that authorizes delivery to a contact Meta will not
  // accept as a bare `to` value, so it is resolved dynamically from the
  // conversation when the caller didn't supply it.
  let waMessageId = ''
  let workingPhone = ''

  const contextMessageId =
    input.contextMessageId ?? (await findInboundWamid(db, input.conversationId))

  const attemptSend = async (
    address: string,
    recipientField?: 'to' | 'recipient',
  ): Promise<string> => {
    try {
      const result = await sendTextMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: address,
        text: messageText,
        contextMessageId,
        recipientField,
      })
      return result.messageId
    } catch (err) {
      // Surface Meta's exact complaint. `MetaApiError` already logs the raw
      // envelope under META_API_SEND_ERROR / META_API_REJECTED inside
      // meta-api; re-logging here keeps the address that failed attached to
      // it, which is the piece needed to tell "stale number" from
      // "identifier Meta won't accept".
      console.error(
        `META_API_SEND_ERROR: ${JSON.stringify({
          address,
          recipient_field: recipientField ?? 'to',
          conversation_id: input.conversationId,
          context_message_id: contextMessageId ?? null,
          reason: err instanceof Error ? err.message : String(err),
        })}`,
      )
      throw err
    }
  }

  /**
   * Send one address, falling back to Meta's alternate `recipient` field when
   * the primary `to` form is rejected.
   *
   * The primary payload carries a bare numeric id in `to`, which is what Meta
   * documents for both a phone number and a BSUID / `@lid` id. If Meta refuses
   * that shape for this account, retrying once with the id intact in
   * `recipient` covers the other documented addressing mode instead of
   * dropping the message. Single-shot: a second failure is real and is
   * surfaced, not looped on.
   */
  const sendWithFieldFallback = async (address: string): Promise<string> => {
    try {
      return await attemptSend(address)
    } catch (err) {
      if (!isRecipientRejection(err)) throw err
      console.warn(
        `[meta-send] Meta rejected the "to" form for ${address}; retrying with the "recipient" field.`,
      )
      return attemptSend(address, 'recipient')
    }
  }

  try {
    if (isPhone) {
      // A real number: retry its trunk-prefix variants. Meta rejects the
      // alternate national-format spellings often enough to be worth walking.
      const sanitized = isDialablePhone(recipient.to!) ? sanitizePhoneForMeta(recipient.to!) : recipient.to!
      const variants = phoneVariants(sanitized)
      let lastError: unknown = null
      for (const v of variants) {
        try {
          waMessageId = await sendWithFieldFallback(v)
          workingPhone = v
          lastError = null
          break
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (!isRecipientNotAllowedError(msg)) throw err
          lastError = err
        }
      }
      if (lastError) throw lastError
    } else {
      // BSUID / @lid / @user: exactly one form, no phone variants.
      // `toMetaTargetId` inside sendTextMessage reduces it to the bare
      // numeric id Meta accepts, anchored by `context` when we have the wamid.
      workingPhone = recipient.to!
      waMessageId = await sendWithFieldFallback(recipient.to!)
    }
  } catch (err) {
    // Meta refused the delivery (or the network did). Leave a `failed` row so
    // the attempt is visible in the thread and in the logs, then rethrow so
    // the engine's own retry/fallback policy still runs.
    await recordFailedSend(db, {
      conversationId: input.conversationId,
      text: messageText,
      error: err,
      address: recipient.to ?? null,
    })
    throw err
  }

  // Remember a real number that worked, so the next send goes straight to it
  // instead of re-walking the variant list. Gated on `isDialablePhone`: a
  // working BSUID / `@lid` id is opaque to WhatsApp's numbering rules and must
  // never be written over the `phone` column — doing so would replace a
  // deliverable number with an undeliverable one on the next send.
  if (
    contact.id &&
    workingPhone &&
    workingPhone !== recipient.to &&
    isDialablePhone(workingPhone)
  ) {
    await db
      .from('contacts')
      .update({ phone: workingPhone, updated_at: new Date().toISOString() })
      .eq('id', contact.id)
      .eq('account_id', input.accountId)
  }

  // Persist the sent message so it appears in the inbox with a real
  // Meta message id. sender_type='bot' distinguishes automation sends
  // from manual agent sends. This runs for EVERY recipient shape — a phone,
  // a BSUID, a `@lid` / `@user` id — so the AI reply is on screen even when
  // the contact has no traditional number.
  const content_type = input.kind === 'template' ? 'template' : 'text'
  const content_text = input.kind === 'text' ? messageText : templateContentText(templateRow, input.params ?? [])
  const template_name = input.kind === 'template' ? input.templateName : null

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type,
    content_text,
    template_name,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    // Meta already has the message; record the DB error but don't pretend
    // the send failed. The engine wraps this in a log line.
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text:
        input.kind === 'template'
          ? (content_text ?? `[template:${input.templateName}]`)
          : input.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)

  return { whatsapp_message_id: waMessageId }
}