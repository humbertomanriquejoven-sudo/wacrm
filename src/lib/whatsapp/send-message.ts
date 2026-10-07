// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp config,
//   3. sends to Meta (with phone-variant retry + contact auto-fix),
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes a `SupabaseClient` and an
// `accountId` and throws `SendMessageError` on failure. The callers
// own auth, rate-limiting, body parsing, and mapping the error to
// their respective response shapes (internal `{ error }` vs the v1
// envelope). Behaviour is identical to the original inline route —
// this is a straight extraction so the public endpoint can reuse it
// without duplicating ~250 lines of Meta plumbing.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  InvalidRecipientError,
  MetaApiError,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { armResponseWaitIfIdle } from '@/lib/whatsapp/response-wait';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  sanitizePhoneForMeta,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import {
  isDialablePhone,
  isRecipientRejection,
  sendWithRecipientFallback,
  resolveRecipient,
  latestInboundAnchorId,
} from '@/lib/whatsapp/recipient-resolver';
import type { MessageTemplate } from '@/types';
import {
  resolveTemplateRow,
  templateBodyParams,
  templateContentText,
} from '@/lib/whatsapp/template-body';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  'interactive',
  ...MEDIA_KINDS,
] as const;

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Legacy positional body params (only used if messageParams.body unset). */
  templateParams?: string[];
  /** Structured template params (header/body/buttons). */
  templateMessageParams?: unknown;
  /** Structured payload for `messageType === 'interactive'`. */
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
  /**
   * Skip Timer 2's auto-arm for THIS send. Defaults to `true` for every
   * outbound (agent or bot): sending any message while the client has not
   * replied starts (or continues) this chat's "Esperar respuesta"
   * countdown. The Timer 2 runner passes `false` when it dispatches the
   * one-shot expiry nudge, so it cannot stack a second ACTIVE row while
   * the due row is still `active` (or spawn a fresh one if the client
   * replied at the exact moment of expiry).
   */
  autoArm?: boolean;
  /**
   * Persisted `messages.sender_type`. Defaults to `'agent'` (a human-style
   * outbound, exactly as before). The scheduled follow-up path passes
   * `'bot'` so the Inbox renders the AI nudge like any other bot reply.
   */
  senderType?: 'agent' | 'bot';
  /**
   * Marks the persisted row `ai_generated = true` so the Inbox badges it.
   * Only added to the INSERT when true, so a database that predates
   * migration 033 — and every ordinary send — is byte-identical to before.
   */
  aiGenerated?: boolean;
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** Meta's `wamid` for the delivered message. */
  whatsappMessageId: string;
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * `db` may be an RLS-scoped user client (dashboard) or the service-
 * role client (public API) — every query is filtered by `accountId`
 * either way, so tenancy holds regardless of which client is passed.
 */
/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation — otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
}): void {
  const { messageType, contentText, mediaUrl, templateName, interactivePayload } =
    params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  if (messageType === 'template' && !templateName) {
    throw new SendMessageError(
      'bad_request',
      'template_name is required for template messages',
      400
    );
  }

  // Interactive: validate the full structured payload against Meta's
  // limits up front so a bad payload 400s before we touch Meta.
  if (messageType === 'interactive') {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      throw new SendMessageError('bad_request', result.error, 400);
    }
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  // Meta caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    interactivePayload,
    replyToMessageId,
    autoArm,
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      'conversation_id is required',
      400
    );
  }

  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;
  if (!contact) {
    throw new SendMessageError(
      'bad_request',
      'Contact not found for this conversation',
      400
    );
  }

  // WhatsApp config, account-scoped.
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();

  if (configError || !config) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  const accessToken = decrypt(config.access_token);

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  if (isLegacyFormat(config.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            '[send-message] access_token GCM upgrade failed:',
            error.message
          );
        }
      });
  }

  // Resolve the reply target to its Meta message_id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no Meta message_id; sending without context'
      );
    } else {
      contextMessageId = parent.message_id;
    }
  }

  // The parity fix.
  //
  // A contact we can only identify by an opaque id — a `@user` display id, a
  // BSUID, a `WAID.`/`LID.` id — CANNOT be addressed directly in Meta's `to`.
  // WhatsApp only accepts such a message as a QUOTE of one of that person's own
  // messages. The AI path always supplied that anchor, which is why the bot
  // could answer these contacts while an operator typing the same thing in the
  // INBOX got a 200 and no delivery.
  //
  // So when the resolved address is opaque, anchor to the newest inbound wamid
  // in this thread — exactly what `engineSendAiReply` does with the inbound it
  // was answering. Only for opaque addresses: a contact with a dialable number
  // is addressed directly and is left completely untouched, so the ordinary
  // case is byte-identical to before.
  if (!contextMessageId) {
    const resolved = await resolveRecipient(contact, accountId, conversationId);
    if (resolved.to && !resolved.isPhone) {
      contextMessageId =
        (await latestInboundAnchorId(db, conversationId)) ?? undefined;
      if (contextMessageId) {
        console.log(
          `[send-message] contact ${contact.id} is addressed by an opaque id (${resolved.source}); ` +
            `anchoring the send to inbound message ${contextMessageId} so WhatsApp accepts it`
        );
      } else {
        console.warn(
          `[send-message] contact ${contact.id} has no dialable number and this conversation has ` +
            `no inbound wamid to quote; the send may be rejected by WhatsApp`
        );
      }
    }
  }

  // Template row — needed for the send-builder's header + button
  // components AND for the body we persist. The lookup tolerates the
  // en / en_US split so a caller that omits the language still resolves
  // a row (see resolveTemplateRow).
  let templateRow: MessageTemplate | null = null;
  let sendLanguage = templateLanguage || 'en_US';
  if (messageType === 'template' && templateName) {
    const resolved = await resolveTemplateRow(
      db,
      accountId,
      templateName,
      templateLanguage
    );
    if (resolved.malformed) {
      throw new SendMessageError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
        500
      );
    }
    templateRow = resolved.row;
    sendLanguage = resolved.language;
  }

  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'template') {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: templateName!,
        language: sendLanguage,
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await sendMediaMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    if (messageType === 'interactive') {
      const p = interactivePayload!;
      if (p.kind === 'buttons') {
        const result = await sendInteractiveButtons({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          bodyText: p.body,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          buttons: p.buttons,
          contextMessageId,
        });
        return result.messageId;
      }
      const result = await sendInteractiveList({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        bodyText: p.body,
        buttonLabel: p.button_label,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        sections: p.sections,
        contextMessageId,
      });
      return result.messageId;
    }
    const result = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };

  // Send via Meta.
  //
  // The recipient may be a phone number, a BSUID, or a public @handle —
  // `sendWithRecipientFallback` resolves the best address from the contact
  // and retries a different identifier when Meta rejects the first. Real
  // numbers additionally get their trunk-prefix variants (the sandbox's
  // #131030 quirk); an opaque id has exactly one form.
  let waMessageId = '';
  let workingPhone = contact.phone ?? '';
  try {
    waMessageId = await sendWithRecipientFallback({
      contact,
      accountId,
      conversationId,
      send: async (address) => {
        const variants = isDialablePhone(address)
          ? phoneVariants(sanitizePhoneForMeta(address))
          : [address];
        let lastError: unknown = null;
        for (const variant of variants) {
          try {
            const id = await attempt(variant);
            workingPhone = variant;
            return id;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (
              !isRecipientNotAllowedError(message) &&
              !isRecipientRejection(err)
            ) {
              throw err;
            }
            lastError = err;
            console.warn(
              `[send-message] variant "${variant}" rejected by Meta, trying next…`
            );
          }
        }
        throw lastError ?? new Error('Meta rejected every address variant');
      },
      onRecovered: async (phone) => {
        await db.from('contacts').update({ phone }).eq('id', contact.id);
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown Meta API error';
    console.error('[send-message] Meta send failed:', message);

    // Recipient problems are OUR data problem, not an upstream outage, and
    // must never masquerade as one. Either the contact has no address we
    // could resolve (`InvalidRecipientError`, raised before any HTTP call)
    // or Meta rejected the destination / the payload — the operator can act
    // on both (repair the contact's number, fix the caption/attachment), so
    // they surface as a typed 422 carrying the verbatim cause instead of a
    // generic 502 that reads like Meta is down. 502 stays reserved for what
    // it actually means: Meta answered 5xx, timed out, or the network died.
    if (err instanceof InvalidRecipientError) {
      throw new SendMessageError(
        'invalid_recipient',
        `Cannot resolve a WhatsApp address for this contact: ${message}`,
        422
      );
    }
    if (err instanceof MetaApiError) {
      if (err.recipientInvalid) {
        throw new SendMessageError(
          'invalid_recipient',
          `WhatsApp rejected the recipient address: ${message}`,
          422
        );
      }
      if (err.status >= 400 && err.status < 500) {
        throw new SendMessageError(
          'meta_rejected',
          `WhatsApp rejected the message: ${message}`,
          422
        );
      }
    }
    throw new SendMessageError('meta_error', `Meta API error: ${message}`, 502);
  }

  // Persist whichever real number worked so the next send goes straight to
  // it. Only ever a number — a working BSUID/handle must never overwrite
  // the phone column.
  if (
    workingPhone &&
    workingPhone !== contact.phone &&
    isDialablePhone(workingPhone)
  ) {
    console.log(
      `[send-message] Auto-corrected contact phone: ${contact.phone} → ${workingPhone}`
    );
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id);
  }

  // Persist the sent message. Field names MUST match the messages
  // schema (see 001_initial_schema.sql).
  // Interactive messages persist the body as content_text (so the
  // conversation-list preview reads sensibly) plus the full structured
  // payload so the thread can re-render the buttons / rows.
  //
  // Templates persist the *substituted* body. The composer pre-renders
  // and posts it as contentText; every other caller (the public API,
  // most importantly) sends none, and storing null there left the
  // Inbox rendering an empty bubble — issue #483.
  const persistedText =
    messageType === 'interactive'
      ? interactivePayload!.body
      : messageType === 'template'
        ? templateContentText(
            templateRow,
            templateBodyParams(templateParams, templateMessageParams),
            contentText
          )
        : (contentText ?? null);

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: params.senderType ?? 'agent',
      content_type: messageType,
      content_text: persistedText,
      media_url: mediaUrl || null,
      template_name: templateName || null,
      interactive_payload:
        messageType === 'interactive' ? interactivePayload : null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
      // Only written when true: a pre-033 schema never sees this key, and
      // manual sends keep relying on the column's `false` default.
      ...(params.aiGenerated === true ? { ai_generated: true } : {}),
    })
    .select()
    .single();

  if (msgError) {
    console.error('[send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Message sent to Meta but failed to save to DB: ${msgError.message}`,
      500
    );
  }

  const lastMessageText =
    messageType === 'interactive'
      ? interactivePayloadPreviewText(interactivePayload!)
      : persistedText || `[${messageType}]`;

  await db
    .from('conversations')
    .update({
      last_message_text: lastMessageText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // TIMER 2 AUTO-ARM — an OUTBOUND message means "we sent a message and are
  // now waiting for the client's reply", so start this chat's response-wait
  // countdown immediately ("en cuanto enviamos un mensaje"). It fires for
  // BOTH an agent and a bot (AI auto-reply) outbound, so the "Esperar
  // respuesta" countdown is always live after anything we send. Continues an
  // already-active countdown; after the client replied (webhook cancelled
  // it) arms from the chat's last-used duration (10 min by default).
  // Callers that must NOT spawn a row — the Timer 2 runner dispatching its
  // one-shot expiry nudge (autoArm: false) — opt out so the conversation's
  // single ACTIVE row can never be duplicated. Best-effort: a failure here
  // must never fail the send.
  if (autoArm !== false) {
    try {
      await armResponseWaitIfIdle(supabaseAdmin(), {
        conversationId,
        contactId: contact.id,
        accountId,
      });
    } catch (err) {
      console.error(
        '[send-message] response-wait auto-arm threw:',
        err instanceof Error ? err.message : err
      );
    }
  }

  // Pause any active Flow run for this contact — the agent stepping in
  // is the strongest "yield, human is here" signal. Best-effort.
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err
    );
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
