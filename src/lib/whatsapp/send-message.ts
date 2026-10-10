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
  toDialable,
  isRecipientNotAllowedError,
  isPlaceholderValue,
  isOpaqueWaId,
} from '@/lib/whatsapp/phone-utils';
import {
  isDialablePhone,
  isRecipientRejection,
  resolveRecipient,
  sendWithRecipientFallback,
  latestInboundAnchorId,
  createAnchorResolver,
  type ResolvedRecipient,
} from '@/lib/whatsapp/recipient-resolver';
import {
  buildDestinationCascadeReport,
  printDestinationCascadeReport,
  formatDestinationCascadeReport,
  toDiagnosticHttp,
  HOW_TO_FIX_DESTINATION,
} from '@/lib/whatsapp/recipient-cascade';
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

/** How long after the customer's last inbound a BSUID-only reply may ride. */
export const REDACTED_BSUID_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Operator-facing fix for a BSUID-only contact whose 24h customer-service
 * window has closed. Exposed so the send core, the HTTP layers and the UI
 * all quote the exact same copy.
 */
export const HOW_TO_FIX_BSUID_WINDOW =
  'CÓMO SOLUCIONARLO: envía una Plantilla (Template) — aunque la ventana de ' +
  '24 h esté cerrada, una plantilla aprobada inicia una conversación con un ' +
  'número protegido por Meta. Si además conoces el teléfono real del ' +
  'contacto, escríbelo con código de país en el panel derecho y presiona ' +
  'Guardar para habilitar la respuesta libre fuera de la ventana.';

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  /**
   * The waterfall `diagnostic_report` (raw value per cascade source), surfaced
   * on the HTTP 422 when no destination could be resolved — or on any Meta
   * rejection, so the operator sees exactly what each source held.
   */
  readonly diagnosticReport?: Record<string, string> | null;
  /** Operator-facing fix instructions, carried on destination failures. */
  readonly howToFix?: string | null;
  /** Metas's verbatim error body (or message) when Meta rejected the send. */
  readonly metaResponse?: string | null;
  /**
   * True only for `bsuid_window_closed`: the contact is addressed by a
   * privacy-redacted id and the 24h customer-service window expired. Lets a
   * caller surface the exact "Ventana de 24h cerrada" warning on its own.
   */
  readonly windowClosed?: boolean;
  constructor(
    code: string,
    message: string,
    status: number,
    extra?: {
      diagnosticReport?: Record<string, string> | null;
      howToFix?: string | null;
      metaResponse?: string | null;
      windowClosed?: boolean;
    }
  ) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
    this.diagnosticReport = extra?.diagnosticReport ?? null;
    this.howToFix = extra?.howToFix ?? null;
    this.metaResponse = extra?.metaResponse ?? null;
    this.windowClosed = extra?.windowClosed ?? false;
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
   * A phone number supplied by the caller next to `conversationId`
   * (e.g. the UI knows the customer's number even if it was never
   * persisted). Sanitized to digits; if it is a valid number and the
   * contact row has no usable `phone`, it is persisted with the service
   * role BEFORE the recipient is resolved, so the send goes straight on
   * CAMINO A and the DB is corrected permanently.
   */
  phone?: string | null;
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

/**
 * Persist a send we refused BEFORE any HTTP request, so the thread shows a
 * real `failed` bubble instead of silently swallowing the operator's message.
 * Best-effort by design: a failure to record the failure must never mask the
 * original cause (it is logged and swallowed), exactly like the bot path's
 * `recordFailedSend`.
 */
async function recordSendFailure(
  db: SupabaseClient,
  args: {
    conversationId: string;
    senderType: 'agent' | 'bot';
    messageType: string;
    contentText: string | null;
    mediaUrl: string | null;
    errorDetail: string;
  }
): Promise<void> {
  try {
    const { error } = await db.from('messages').insert({
      conversation_id: args.conversationId,
      sender_type: args.senderType,
      content_type: args.messageType,
      content_text: args.contentText,
      media_url: args.mediaUrl,
      status: 'failed',
      message_id: null,
      error_detail: args.errorDetail,
    });
    if (error) {
      console.error(
        '[send-message] could not record the refused send:',
        error.message,
        error.code ?? '',
        error.details ?? ''
      );
    }
  } catch (err) {
    console.error(
      '[send-message] could not record the refused send:',
      err instanceof Error ? err.message : err
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

  let contact = conversation.contact;
  if (!contact) {
    throw new SendMessageError(
      'bad_request',
      'Contact not found for this conversation',
      400
    );
  }

  // STRICT RECIPIENT OVERRIDE. The address that reaches Meta must come from
  // THIS contact row, never from anything the caller claimed. The embed above
  // is read under the caller's RLS (column policies can trim `phone`, and a
  // contacts join can come back partial), so the full row is re-read with the
  // service role key: RLS cannot hide `phone` / `wa_id` / `wa_user_id` /
  // `username` here. The embed survives as a fallback only for a runtime where
  // the admin client is unconfigured. The read is defensive: an override
  // failure must never take the send down.
  let adminContact: Record<string, unknown> | null = null;
  try {
    const { data, error } = await supabaseAdmin()
      .from('contacts')
      .select('*')
      .eq('id', contact.id)
      .single();
    if (!error && data) {
      adminContact = data as unknown as Record<string, unknown>;
      console.log(
        `[send-message] strict contact override: contact ${contact.id} re-read via service role → phone="${data.phone ?? ''}", wa_id="${data.wa_id ?? ''}", wa_user_id="${data.wa_user_id ?? ''}", username="${data.username ?? ''}"`
      );
    } else if (error) {
      console.warn(
        '[send-message] service-role contact override unavailable for',
        contact.id,
        '- falling back to the RLS-scoped embed:',
        error.message
      );
    }
  } catch (err) {
    console.warn(
      '[send-message] service-role contact override unavailable for',
      contact.id,
      '- falling back to the RLS-scoped embed:',
      err instanceof Error ? err.message : err
    );
  }
  if (adminContact) {
    contact = adminContact as typeof contact;
  }

  // TAREA 1 — AUTO-PERSISTENCIA INCONDICIONAL DEL TELÉFONO. El número puede
  // venir del payload (`phone`), del embed o del override por service role.
  // Si hay un número válido (>= 8 dígitos tras sanitizar espacios/guiones/
  // '+', '/@') y la columna `contacts.phone` está vacía o no es usable, se
  // persiste AHORA con la service role — la BD queda corregida sin depender
  // de que nadie presione "Guardar" en la UI, y la resolución baja por el
  // CAMINO A (teléfono directo, sin `context`).
  const payloadPhone = toDialable(params.phone ?? null);
  if (payloadPhone && !toDialable(contact.phone ?? null)) {
    console.log(
      `[send-message] persisting payload phone "${payloadPhone}" for contact ${contact.id} ` +
        `(contacts.phone was "${contact.phone ?? ''}") via service role`,
    );
    const { error: persistErr } = await supabaseAdmin()
      .from('contacts')
      .update({ phone: payloadPhone })
      .eq('id', contact.id);
    if (persistErr) {
      console.warn(
        '[send-message] failed to persist payload phone',
        payloadPhone,
        '- sending with the in-memory value',
        persistErr.message,
      );
    }
    contact = { ...contact, phone: payloadPhone };
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

  // Sender phone_number_id. Preference per the recipient engine (rule 1):
// 1. the number the webhook recorded on THIS conversation (migration 071),
// 2. the account config, 3. the number recorded on THIS contact (migration
// 053), then — enforced inside meta-api's `messagesUrl` — the process env
// (WHATSAPP_PHONE_NUMBER_ID / META_PHONE_NUMBER_ID). The `'unknown'`
// placeholder is never accepted and the send is refused before any HTTP
// call, so a POST to `/{unknown}/messages` is impossible.
  const senderPhoneNumberId =
    [
      (conversation as { phone_number_id?: string | null }).phone_number_id,
      config.phone_number_id,
      (contact as { phone_number_id?: string | null }).phone_number_id,
    ]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find((value) => value && !isPlaceholderValue(value)) ??
    config.phone_number_id;

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

  // CASCADA DE RESOLUCIÓN DE DESTINATARIO (waterfall pipeline). Con la
  // service role (bypass RLS) se inspeccionan, EN ORDEN ESTRICTO, las cinco
  // fuentes — 1. contacts.phone, 2. contacts.metadata, 3. conversations.wa_id
  // / metadata, 4. ID del canal / BSUID numérico, 5. último mensaje entrante.
  // Cada fuente se sanea a dígitos puros (>= 8 → VALIDO) y gana la PRIMERA
  // válida. El INFORME_DIAGNOSTICO_DESTINATARIO se imprime SIEMPRE antes de
  // tocar Meta Graph API.
  const cascadeReport = await buildDestinationCascadeReport({
    conversationId,
    contactId: contact.id,
    accountId,
    contact,
    conversation,
  });
  printDestinationCascadeReport(cascadeReport);

  // UNIFIED DESTINATION. The waterfall only ever emits a digits-only id. When
  // it lands one, that wins — it may have seen a conversational source
  // (`conversations.wa_id`, a channel BSUID, the last inbound `from`) the
  // contact row does not carry. When it lands NOTHING, the SHARED ladder
  // (`resolveRecipient`) — the exact resolver the follow-up timers and the
  // broadcast path use — gets the final word under CASO A/B/C: a real E.164
  // number (CASO A), a numeric opaque wa_id the contact row does not carry
  // (CASO B), or a namespaced BSUID (CASO C, sent in Meta's `recipient`
  // field). A `@username` is NEVER a destination and keeps the structured 422.
  let resolved: ResolvedRecipient;
  const cascadeTo = cascadeReport.finalTo;
  if (cascadeTo && isDialablePhone(cascadeTo)) {
    resolved = {
      to: cascadeTo,
      source:
        cascadeReport.chosen === 'latest_inbound_from'
          ? 'recovered'
          : cascadeReport.chosen === 'contacts_phone' ||
              cascadeReport.chosen === 'contacts_metadata'
            ? 'phone'
            : 'wa_id',
      isPhone: true,
    };
  } else {
    // The cascade landed an OPAQUE numeric id (or nothing). A real number is
    // always the better destination — Meta accepts it directly in `to`, while
    // an opaque id needs a `context.message_id` anchor (CASO B). So before
    // accepting the opaque id, ask the SHARED ladder: it can recover a number
    // Meta already used on this contact's OWN inbound thread
    // (`messages.sender_phone`). Prefer that number; then a namespaced BSUID
    // (CASO C, which the digit-only cascade would have mangled), then the
    // cascade's opaque id, then the ladder's numeric id.
    const ladder = await resolveRecipient(contact, accountId, conversationId);
    if (isDialablePhone(ladder.to)) {
      resolved = ladder;
    } else if (ladder.isBsuid) {
      // CASO C — a namespaced BSUID travels in Meta's `recipient` field,
      // NOT in `to`. The resolver marks isBsuid: true; we keep the flag
      // but set the destination field to recipient-compatible form.
      resolved = {
        to: ladder.to,
        source: 'bsuid',
        isPhone: false,
        isBsuid: true,
      };
    } else if (cascadeTo) {
      resolved = {
        to: cascadeTo,
        source: cascadeReport.chosen === 'latest_inbound_from' ? 'recovered' : 'wa_id',
        isPhone: false,
        isBsuid: false,
      };
    } else if (ladder.to && isOpaqueWaId(ladder.to)) {
      resolved = ladder;
    } else {
      // B) Sin ningún destinatario entregable en NINGUNA fuente: se CANCELA la
      // llamada a Meta y se responde 422 estructurado con el informe + la guía
      // de solución — sin gastar un request que Meta solo iba a rechazar o a
      // tragarse en silencio.
      const technical =
        `No destination could be resolved for conversation ${conversationId} / contact ${contact.id}: ` +
        `every cascade source was missing, placeholder or non-numeric, and the shared ` +
        `recipient ladder found no deliverable number, numeric wa_id or BSUID (CASO A/B/C). ` +
        `No HTTP request was sent to Meta.`;
      console.error(
        `[send-message] INVALID RECIPIENT for conversation ${conversationId} / contact ${contact.id}: ${technical}`,
      );
      await recordSendFailure(db, {
        conversationId,
        senderType: params.senderType ?? 'agent',
        messageType,
        contentText: contentText ?? null,
        mediaUrl: mediaUrl || null,
        errorDetail: technical,
      });
      throw new SendMessageError(
        'no_delivery_destination',
        'Error de entrega de mensaje',
        422,
        {
          diagnosticReport: toDiagnosticHttp(cascadeReport),
          howToFix: HOW_TO_FIX_DESTINATION,
        },
      );
    }
  }

  // VENTANA DE 24 HORAS (contactos opacos / redactados por privacidad de Meta).
  // Un contacto sin teléfono real solo puede recibir mensajes de texto/libre
  // citando SU propio mensaje entrante — y eso exige que haya escrito en las
  // últimas 24h. `latest_inbound_at` no es una columna: se deriva del
  // `created_at` del mensaje entrante más reciente (Fuente 5 de la cascada).
  // Si la ventana cerró, se BLOQUEA el envío libre antes de tocar Meta con el
  // aviso exacto en `error` + `how_to_fix`; las PLANTILLAS siguen permitidas
  // (Meta las acepta fuera de la ventana) y un teléfono dialable ni entra aquí.
  const latestInboundAtMs = cascadeReport.latestInboundAt
    ? new Date(cascadeReport.latestInboundAt).getTime()
    : Number.NaN;
  const windowOpen =
    Number.isFinite(latestInboundAtMs) &&
    Date.now() - latestInboundAtMs < REDACTED_BSUID_WINDOW_MS;
  const needsWindow =
    Boolean(resolved.to) && !resolved.isPhone && messageType !== 'template';
  if (needsWindow && !windowOpen) {
    const technical =
      `Opaque-id contact ${contact.id} (to="${resolved.to}", source=${resolved.source}) ` +
      `has no inbound customer message within the last 24h ` +
      `(latest_inbound_at=${cascadeReport.latestInboundAt ?? 'none'}) — the ` +
      `customer-service window is closed. Templates are still allowed. ` +
      `No HTTP request was sent to Meta.`;
    console.error(
      `[send-message] OPAQUE WINDOW CLOSED for conversation ${conversationId}: ${technical}`,
    );
    await recordSendFailure(db, {
      conversationId,
      senderType: params.senderType ?? 'agent',
      messageType,
      contentText: contentText ?? null,
      mediaUrl: mediaUrl || null,
      errorDetail: technical,
    });
    throw new SendMessageError(
      'bsuid_window_closed',
      'Ventana de atención de 24 horas cerrada para este contacto. Para iniciar conversación con un número protegido por Meta se requiere enviar una Plantilla (Template).',
      422,
      {
        diagnosticReport: toDiagnosticHttp(cascadeReport),
        howToFix: HOW_TO_FIX_BSUID_WINDOW,
        windowClosed: true,
      },
    );
  }

  // Resolve the reply target to its Meta message_id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id, sender_type')
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
    const parentIsOurs =
      parent.sender_type === 'agent' || parent.sender_type === 'bot';
    const destinationIsOpaque = Boolean(resolved.to) && !resolved.isPhone && !resolved.isBsuid;
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no Meta message_id; sending without context'
      );
    } else if (parentIsOurs && destinationIsOpaque) {
      // WhatsApp only accepts an opaque id as a reply QUOTING ONE OF THE
      // CUSTOMER'S OWN messages — quoting our agent/bot bubble leaves Meta
      // with nothing that authorizes the destination (#131009). Fall
      // through to the thread's newest customer wamid below.
      console.warn(
        `[send-message] reply target ${parent.message_id} is our own message; an opaque destination needs the customer's wamid — anchoring to the thread's newest inbound instead`
      );
    } else {
      contextMessageId = parent.message_id;
    }
  }

  // A contact addressed by a numeric opaque wa_id (CASO B) cannot be sent as
  // a cold destination in Meta's `to`: sent bare it has been observed to come
  // back as (#131009) "Recipient phone number not in allowed list" while the
  // message is dropped. WhatsApp accepts an opaque id only as a QUOTE of one
  // of that person's own messages. The AI path always supplied that anchor,
  // which is why the bot could answer these contacts while an operator typing
  // the same thing in the INBOX got a 200 and no delivery.
  //
  // So when the resolved address is opaque, anchor to the newest inbound wamid
  // in this thread — exactly what `engineSendAiReply` does with the inbound it
  // was answering. Only for opaque addresses: a contact with a dialable number
  // (CASO A) is addressed directly and is left completely untouched, so the
  // ordinary case is byte-identical to before. A TEMPLATE is Meta's
  // business-initiated, out-of-window channel: it is exempt (as it is from the
  // 24h gate above), because it does not need a customer message to quote. A
  // numeric wa_id whose thread has NO inbound wamid to quote is REFUSED here
  // (log + stop, CASO B): Meta only authorizes opaque destinations through
  // `context`, so a cold send would be a doomed probe.
  if (
    !contextMessageId &&
    resolved.to &&
    !resolved.isPhone &&
    messageType !== 'template'
  ) {
    // `messages` can be RLS-blocked for a user-scoped client, so the anchor is
    // read with the service role — the lookup must never be held hostage by RLS.
    contextMessageId =
      (await latestInboundAnchorId(supabaseAdmin(), conversationId)) ?? undefined;
    if (contextMessageId) {
      console.log(
        `[send-message] contact ${contact.id} is addressed by ${
          resolved.isBsuid ? 'an opaque BSUID (CASO C)' : 'an opaque wa_id (CASO B)'
        } (${resolved.source}); ` +
          `anchoring the send to inbound message ${contextMessageId} so WhatsApp accepts it`
      );
    } else if (resolved.isBsuid) {
      // CASO C: a BSUID does not require a contextMessageId anchor — it travels
      // in Meta's `recipient` field. Without an anchor the send is still
      // permissible, so we just leave contextMessageId as undefined.
      console.log(
        `[send-message] contact ${contact.id} is addressed by a BSUID (CASO C); ` +
          'no contextMessageId anchor is required, sending without quote.'
      );
    } else {
      // CASO B: an opaque wa_id is deliverable only as a reply to one of the
      // customer's own messages. With no inbound wamid in the thread there is
      // nothing to quote, so the send is REFUSED — logging the error and
      // stopping, exactly as the recipient engine dictates.
      const technical =
        `Opaque destination ${resolved.to} (source: ${resolved.source}) for conversation ` +
        `${conversationId} / contact ${contact.id} has NO inbound customer wamid to quote — ` +
        `CASO B requires a context.message_id anchor, so the send is refused. ` +
        `No HTTP request was sent to Meta.`;
      console.error(`[send-message] CASO B NO ANCHOR: ${technical}`);
      await recordSendFailure(db, {
        conversationId,
        senderType: params.senderType ?? 'agent',
        messageType,
        contentText: contentText ?? null,
        mediaUrl: mediaUrl || null,
        errorDetail: technical,
      });
      throw new SendMessageError(
        'no_delivery_destination',
        'Error de entrega de mensaje',
        422,
        {
          diagnosticReport: toDiagnosticHttp(cascadeReport),
          howToFix: HOW_TO_FIX_BSUID_WINDOW,
        },
      );
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

  // The anchor FOLLOWS the address. The reply quote / opaque-first anchor
  // resolved above is fixed, but a phone-first send that Meta rejects
  // escalates to an opaque id inside `sendWithRecipientFallback` — and
  // that escalated attempt needs the thread's customer wamid or Meta
  // answers (#131009) "Parameter value is not valid". Lazily resolved and
  // memoized, so an all-phone send never queries `messages`.
  const anchorFor = createAnchorResolver(
    supabaseAdmin(),
    conversationId,
    contextMessageId
  );

  const attempt = async (phone: string): Promise<string> => {
    const anchor = await anchorFor(phone)
    // The resolved address travels in `to`, whatever its shape. The Meta
    // senders route it to the right field via `canonicalToField`: a dialable
    // number (CASO A) and a numeric opaque wa_id (CASO B) go in `to`, and a
    // namespaced BSUID (CASO C) is moved into Meta's `recipient` field
    // automatically. The caller never pre-splits the address, so every send
    // path — text, media, template, interactive — resolves and routes
    // identically from the single shared resolver above.
    if (messageType === 'template') {
      const result = await sendTemplateMessage({
        phoneNumberId: senderPhoneNumberId,
        accessToken,
        to: phone,
        templateName: templateName!,
        language: sendLanguage,
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId: anchor,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await sendMediaMessage({
        phoneNumberId: senderPhoneNumberId,
        accessToken,
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId: anchor,
      });
      return result.messageId;
    }
    if (messageType === 'interactive') {
      const p = interactivePayload!;
      if (p.kind === 'buttons') {
        const result = await sendInteractiveButtons({
          phoneNumberId: senderPhoneNumberId,
          accessToken,
          to: phone,
          bodyText: p.body,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          buttons: p.buttons,
          contextMessageId: anchor,
        });
        return result.messageId;
      }
      const result = await sendInteractiveList({
        phoneNumberId: senderPhoneNumberId,
        accessToken,
        to: phone,
        bodyText: p.body,
        buttonLabel: p.button_label,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        sections: p.sections,
        contextMessageId: anchor,
      });
      return result.messageId;
    }
    const result = await sendTextMessage({
      phoneNumberId: senderPhoneNumberId,
      accessToken,
      to: phone,
      text: contentText!,
      contextMessageId: anchor,
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
  console.log(
    `[send-message] sending to conversation ${conversationId}: ladder → to="${resolved.to}" (source=${resolved.source}, isPhone=${resolved.isPhone}); ` +
      `context=${contextMessageId ?? 'none (direct number)'}`
  );
  let waMessageId = '';
  let workingPhone = contact.phone ?? '';
  try {
    waMessageId = await sendWithRecipientFallback({
      contact,
      accountId,
      conversationId,
      // The destination was chosen by the CASCADE above (which may have found
      // a conversational source the contact row does not carry) — make it the
      // head of the retry queue instead of re-deriving it from the row.
      first: resolved,
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
        // Persist the recovered number through the service role so an
        // RLS-scoped caller can never be the thing that loses it.
        await supabaseAdmin()
          .from('contacts')
          .update({ phone })
          .eq('id', contact.id);
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown Meta API error';
    console.error('[send-message] Meta send failed:', message);

    // C) Errores de la API de Meta: se imprime la respuesta COMPLETA de Meta
    // (verbatim) junto con el [INFORME_DIAGNOSTICO_DESTINATARIO], y la
    // respuesta HTTP devuelve el mensaje de Meta + la guía `how_to_fix`.
    if (err instanceof MetaApiError) {
      console.log(formatDestinationCascadeReport(cascadeReport));
      console.error(
        '[send-message] Meta response body:',
        err.rawBody ?? message,
      );
    }

    // Recipient problems are OUR data problem, not an upstream outage, and
    // must never masquerade as one. Either the contact has no address we
    // could resolve (`InvalidRecipientError`, raised before any HTTP call)
    // or Meta rejected the destination / the payload — the operator can act
    // on both (repair the contact's number, fix the caption/attachment), so
    // they surface as a typed 422 carrying the verbatim cause instead of a
    // generic 502 that reads like Meta is down. 502 stays reserved for what
    // it actually means: Meta answered 5xx, timed out, or the network died.
    // A typed failure already surfaced must travel untouched — re-wrapping it
    // as a 502 would hide the cause.
    if (err instanceof SendMessageError) {
      throw err;
    }
    if (err instanceof InvalidRecipientError) {
      throw new SendMessageError('invalid_recipient', 'Error de entrega de mensaje', 422, {
        diagnosticReport: toDiagnosticHttp(cascadeReport),
        howToFix: HOW_TO_FIX_DESTINATION,
        metaResponse: message,
      });
    }
    if (err instanceof MetaApiError) {
      const metaResponse = err.rawBody ?? message;
      if (err.recipientInvalid) {
        throw new SendMessageError(
          'invalid_recipient',
          'Error de entrega de mensaje',
          422,
          {
            diagnosticReport: toDiagnosticHttp(cascadeReport),
            howToFix: HOW_TO_FIX_DESTINATION,
            metaResponse,
          }
        );
      }
      if (err.status >= 400 && err.status < 500) {
        throw new SendMessageError(
          'meta_rejected',
          'Error de entrega de mensaje',
          422,
          {
            diagnosticReport: toDiagnosticHttp(cascadeReport),
            howToFix: HOW_TO_FIX_DESTINATION,
            metaResponse,
          }
        );
      }
    }
    throw new SendMessageError('meta_error', 'Error de entrega de mensaje', 502, {
      diagnosticReport: toDiagnosticHttp(cascadeReport),
      howToFix: HOW_TO_FIX_DESTINATION,
      metaResponse: message,
    });
  }

  // Persist whichever real number worked so the next send goes straight to
  // it. Only ever a number — a working BSUID/handle must never overwrite
  // the phone column. Written with the service role: RLS must never block
  // the correction that makes the contact sendable.
  if (
    workingPhone &&
    workingPhone !== contact.phone &&
    isDialablePhone(workingPhone)
  ) {
    console.log(
      `[send-message] Auto-corrected contact phone: ${contact.phone} → ${workingPhone}`
    );
    await supabaseAdmin()
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