import { supabaseAdmin } from './admin-client';
import { loadAiConfig } from './config';
import { apiKeyFingerprint } from './key-fingerprint';
import { buildConversationContext } from './context';
import { retrieveKnowledge } from './knowledge';
import { generateReply, stripInternalReasoning } from './generate';
import { buildSystemPrompt } from './defaults';
import { logAiUsage } from './usage';
import { latestUserMessage } from './query';
import {
  AI_TOOLS,
  executeToolCall,
  extractBookingResult,
  isCitaMutatingTool,
  loadContactContext,
  type BookingToolResult,
} from './tools';
import { calendarConfigured, MEET_FALLBACK_LINK } from '@/lib/calendar';
import { gmailConfigured } from '@/lib/gmail';
import { stripRawTimestamps } from '@/lib/whatsapp/clean-ai-text';
import {
  engineSendAiReply,
  engineSendText,
  resolveOutboundAddressQueue,
} from '@/lib/flows/meta-send';
import { isRecipientRejection } from '@/lib/whatsapp/recipient-resolver';
import { scheduleFollowUp } from '@/lib/whatsapp/follow-up-worker';
import {
  autoUnblockConversation,
  autoUnblockEnabled,
} from './unblock';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AiError, AiKeyDecryptError, type ChatMessage } from './types';

/** Maximum tool-call rounds per inbound to avoid infinite loops. */
const MAX_TOOL_ROUNDS = 3;

/**
 * ============================================================
 * GOLDEN RULE: NEVER LEAVE A CUSTOMER WITHOUT A WHATSAPP REPLY.
 * ============================================================
 * The pre-LLM context (knowledge retrieval + contact profile) is the one
 * part of the turn that talks to Postgres and to the embeddings provider
 * BEFORE anything has been said to the customer. If either of those hangs,
 * the whole turn dies while the UI still shows "AI assistant is replying
 * automatically" — which is precisely the frozen state this guards
 * against.
 *
 * So neither lookup is allowed to block the reply:
 *   * retrieveKnowledge gets KNOWLEDGE_TIMEOUT_MS. Past that the bot
 *     answers from the system prompt alone (fewer sources, never zero
 *     words).
 *   * loadContactContext degrades to no profile/citas.
 * Both are best-effort by design: a missing knowledge excerpt or a missing
 * name is a slightly worse answer, a silent thread is no answer at all.
 */
const KNOWLEDGE_TIMEOUT_MS = 2_500;

/**
 * Rejects with a labelled error if `promise` has not settled within `ms`.
 * The timer is always cleared, so a fast resolution never keeps the event
 * loop (or a serverless invocation) alive for the rest of the timeout.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[ai auto-reply] ${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Knowledge retrieval under a hard 2.5s ceiling. NEVER rejects: a timeout,
 * a dead database or a failed embeddings call all resolve to no excerpts so
 * the model still generates and the reply still goes out.
 */
async function safeRetrieveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfigLike, 'embeddingsApiKey'>,
  queryText: string
): Promise<string[]> {
  try {
    return await withTimeout(
      retrieveKnowledge(db, accountId, config, queryText),
      KNOWLEDGE_TIMEOUT_MS,
      'knowledge retrieval'
    );
  } catch (err) {
    console.error(
      `[ai auto-reply] knowledge retrieval unavailable for account ${accountId} — continuing WITHOUT the knowledge base so the customer still gets an answer:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * Contact profile/citas for the prompt. NEVER rejects — `loadContactContext`
 * has no error handling of its own, so an unguarded throw here used to
 * reject the shared `Promise.all` and cancel the entire turn.
 */
async function safeLoadContactContext(
  db: SupabaseClient,
  contactId: string
): Promise<Awaited<ReturnType<typeof loadContactContext>>> {
  try {
    return await withTimeout(
      loadContactContext(db, contactId),
      KNOWLEDGE_TIMEOUT_MS,
      'contact context lookup'
    );
  } catch (err) {
    console.error(
      `[ai auto-reply] contact context unavailable for contact ${contactId} — continuing without it:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * ============================================================
 * DIAGNOSTIC BYPASS — TEMPORAL. QUÍTALO AL TERMINAR LA PRUEBA.
 * ============================================================
 * Activar con `AI_AUTOREPLY_BYPASS=true` en el entorno.
 *
 * Qué hace:
 *   1. Salta `is_active` / `auto_reply_enabled` y, si falta la fila de
 *      `ai_configs` o la key no se puede descifrar, usa una config de
 *      emergencia para poder llamar al proveedor y ver su error real.
 *   2. Salta el gate de automatizaciones activas.
 *   3. Salta `assigned_agent_id` (el "pause" real; no existe is_paused).
 *   4. Si el proveedor de IA falla o devuelve texto vacío, envía un texto
 *      plano de prueba para separar "falla la IA" de "falla WhatsApp".
 *
 * Por qué está detrás de una bandera en vez de eliminado: la pausa por
 * agente y el override de automatizaciones son comportamiento del
 * producto. Borrarlos Would deja al bot respondiendo sobre hilos que un
 * humano tomó a propósito. Con la variable el bypass es explícito,
 * reversible y no se activa por accidente en producción.
 * ============================================================
 */
function bypassEnabled(): boolean {
  return process.env.AI_AUTOREPLY_BYPASS === 'true';
}

/**
 * Config mínima para que el bypass todavía pueda llamar al proveedor y
 * reportar su error real. Se combina sobre la config real cuando ésta
 * existe, así que una key válida nunca se descarta.
 */
function emergencyConfig(base: AiConfigLike | null): AiConfigLike {
  const fallback: AiConfigLike = {
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    apiKey: process.env.AI_AUTOREPLY_BYPASS_KEY ?? '',
    systemPrompt:
      'You are a WhatsApp assistant. Reply in one short sentence.',
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 99999,
    handoffAgentId: null,
    embeddingsApiKey: null,
  };
  return base ? { ...fallback, ...base, isActive: true, autoReplyEnabled: true } : fallback;
}

/** Structural alias so this file doesn't need a circular import for one type. */
interface AiConfigLike {
  provider: 'openai' | 'anthropic' | 'openrouter';
  model: string;
  apiKey: string;
  systemPrompt: string | null;
  isActive: boolean;
  autoReplyEnabled: boolean;
  autoReplyMaxPerConversation: number;
  handoffAgentId: string | null;
  embeddingsApiKey: string | null;
}

/**
 * Connectivity probe. Sends a fixed plain-text message so the operator can
 * tell, from the customer's side, whether the WhatsApp OUTBOUND path works
 * at all — independent of the AI provider. If this arrives but the AI
 * reply doesn't, the fault is the provider/key/config, not Meta.
 *
 * Deliberately does NOT reuse the model's voice: a fixed string means its
 * arrival is unambiguous evidence.
 */
async function sendOutboundProbe(
  args: DispatchArgs,
  reason: string
): Promise<void> {
  console.warn(
    `[ai auto-reply] BYPASS: sending outbound connectivity probe to conversation ${args.conversationId} (reason: ${reason})`
  );
  try {
    const result = await engineSendText({
      accountId: args.accountId,
      userId: args.configOwnerUserId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text: 'Test de respuesta automática',
    });
    console.warn(
      `[ai auto-reply] BYPASS: outbound probe DELIVERED (${result.whatsapp_message_id}) — WhatsApp outbound works; the fault is the AI provider/config.`
    );
  } catch (err) {
    console.error(
      '[ai auto-reply] BYPASS: outbound probe FAILED — WhatsApp outbound is broken too:',
      err
    );
  }
}

/**
 * REGLA DE ORO — emergency acknowledgement.
 *
 * Puts SOMETHING on WhatsApp when a turn dies before/while the LLM was
 * being called: an undecryptable stored key, a context load failure, a
 * provider rejection. The outbound path does NOT depend on the AI key, so
 * this works precisely when the AI key is the thing that is broken.
 *
 * The text is `buildUngroundedAckMessage` — it asserts nothing that could
 * be false (no cita, no fecha, no enlace). It NEVER fires when the caller
 * already decided to stay silent: `suppressReply` (Flow answered / reaction)
 * turns it into a log line only. Returns true when it reached WhatsApp.
 */
async function sendTurnFallback(
  args: DispatchArgs,
  reason: string
): Promise<boolean> {
  if (args.suppressReply) {
    console.warn(
      `[ai auto-reply] fallback_skipped conversation=${args.conversationId} reason=${reason} (suppressReply=true — something else already owns this message)`
    );
    return false;
  }
  try {
    await engineSendAiReply({
      accountId: args.accountId,
      userId: args.configOwnerUserId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text: buildUngroundedAckMessage(),
      aiGenerated: true,
      composeMessageId: args.composeMessageId,
      single: true,
    });
    console.warn(
      `[ai auto-reply] fallback_sent conversation=${args.conversationId} reason=${reason}`
    );
    return true;
  } catch (err) {
    console.error(
      `[ai auto-reply] fallback_failed conversation=${args.conversationId} reason=${reason}`,
      err instanceof Error ? { message: err.message, stack: err.stack } : err
    );
    return false;
  }
}

/**
 * Tope de auto-respuestas a partir del cual NO hay tope: cualquier valor
 * configurado mayor o igual a este se envía al RPC como este mismo número
 * (un límite alto pero real), de modo que el bot conteste siempre a cada
 * mensaje entrante mientras no haya un humano asignado, sin exigir un
 * "Take over" manual para desbloquear.
 * 99999 es el valor por defecto del panel desde la migración 044.
 */
const UNLIMITED_AUTO_REPLIES = 99999;

/**
 * Traduce el tope configurado en el panel al parámetro `max_replies` del RPC
 * `claim_ai_reply_slot`.
 *
 * CRÍTICO: el valor "sin tope" que se envía es UNLIMITED_AUTO_REPLIES, NO 0.
 *
 * Cada versión del RPC interpreta `max_replies` de forma distinta:
 *
 *   * 029 (original):  `ai_reply_count < max_replies`
 *   * 041 / 046:        `max_replies = 0 OR ...` / `max_replies >= 99999 OR ...`
 *
 * Enviar 0 sólo funciona con 041 en adelante. Con la función de la 029,
 * el predicado queda `ai_reply_count (0, recién reiniciado) < 0` → FALSE →
 * el UPDATE no hace match → el RPC devuelve false → el despacho hace
 * `return` y NO ENVÍA NADA. Como el contador se reinicia a cero en cada
 * mensaje entrante (ver `resetAutoReplyCounter`), 0 es justamente el valor
 * que garantiza el silencio permanente: el bot nunca responde, para ningún
 * contacto, hasta que se apliquen las migraciones 041/046.
 *
 * Mandar 99999 hace que el claim tenga éxito en las TRES versiones:
 *   029 → `0 < 99999` ✓   041 → `0 < 99999` ✓   046 → `>= 99999` ✓
 *
 * Y como el contador se reinicia a 0 en cada mensaje entrante, el tope nunca
 * llega a alcanzarse: el claim conserva su atomicidad (el lock de fila sigue
 * serializando dos despachos concurrentes) sin poder silenciar el hilo.
 */
function effectiveMaxReplies(configured: number): number {
  if (!Number.isFinite(configured) || configured <= 0) {
    return UNLIMITED_AUTO_REPLIES;
  }
  return Math.min(Math.floor(configured), UNLIMITED_AUTO_REPLIES);
}

/**
 * Reinicia el contador de auto-respuestas de una conversación al entrar un
 * mensaje nuevo y limpia el flag legacy `ai_autoreply_disabled`.
 *
 * Sin esto, un `ai_reply_count` acumulado por una versión anterior del bot
 * (o un flag de pausa heredado) podía dejar el hilo mudo de forma
 * permanente sin que nadie lo hubiera decidido: era el bug clásico de
 * "el bot dejó de responder y tocaba tomar el control a mano". Como el
 * tope vigente es ilimitado, el contador solo sirve como métrica, así que
 * reiniciarlo en cada mensaje entrante es seguro y no afecta el reporte de
 * uso (que viene de `ai_usage_log`, no de esta columna).
 *
 * Nunca propaga el error: un fallo al resetear no debe impedir responder.
 */
async function resetAutoReplyCounter(
  db: SupabaseClient,
  conversationId: string
): Promise<void> {
  const { error } = await db
    .from('conversations')
    .update({ ai_reply_count: 0, ai_autoreply_disabled: false })
    .eq('id', conversationId);
  if (error) {
    console.warn(
      `[ai auto-reply] could not reset the reply counter for ${conversationId}:`,
      error.message
    );
  }
}

/**
 * Deterministic, customer-facing reschedule confirmation built from the REAL
 * reagendar_cita result.
 *
 * Reached only when the tool reported `confirmado:true`, which happens only
 * AFTER the provider accepted the `events.patch` and the CRM row was updated —
 * so this bubble cannot claim a move that did not happen. It quotes the link
 * the provider returned for the NEW slot, which is the whole point of
 * re-reading it after a patch: the customer must not be handed the URL of the
 * appointment they just moved away from.
 *
 * Returns null when nothing was actually moved.
 */
export function buildRescheduleConfirmationMessage(
  booking: BookingToolResult,
  contactName?: string | null
): string | null {
  if (booking.confirmado !== true) return null;
  const nombre = contactName?.trim() || 'Humberto';
  const fecha = booking.fecha ?? booking.inicio?.slice(0, 10) ?? '';
  const hora = booking.hora ?? booking.inicio?.slice(11, 16) ?? '';
  const link = booking.link || MEET_FALLBACK_LINK;
  return `¡Listo, ${nombre}! Tu cita fue reagendada con éxito para el ${fecha} a las ${hora}.\n\nEste es el enlace actualizado de tu videollamada de Google Meet:\n${link}`;
}

/**
 * Deterministic reply for a reschedule that did NOT happen.
 *
 * The point of this function is that a failed or impossible move must never
 * reach the customer as a confirmation. Two outcomes are kept apart because
 * they need opposite replies:
 *
 *  - `sin_cita_previa`: there was nothing to move. That is a normal turn — say
 *    so kindly and offer to book a new one.
 *  - anything else (slot taken, provider error, unreadable date): the move was
 *    refused. Apologise, state the move did not happen, and never quote a date
 *    or a link, because the appointment is still at its original time.
 *
 * Returns null when there is no failure to report.
 */
export function buildRescheduleFailureMessage(
  booking: BookingToolResult,
  contactName?: string | null
): string | null {
  if (booking.exito !== false) return null;
  const nombre = contactName?.trim();

  if (booking.motivo === 'sin_cita_previa') {
    return nombre
      ? `${nombre.trim()}, no encontré ninguna cita previa tuya activa, así que no hay nada que reagendar por ahora. Con gusto te agendo una nueva: dime qué fecha y hora prefieres.`
      : 'No encontré ninguna cita previa tuya activa, así que no hay nada que reagendar por ahora. Con gusto te agendo una nueva: dime qué fecha y hora prefieres.';
  }

  const slotBusy = booking.motivo === 'horario_ocupado';
  return (
    (nombre ? `Perdón, ${nombre.trim()}: ` : 'Perdón: ') +
    (slotBusy
      ? 'ese horario ya está ocupado, así que no pude mover tu cita a esa hora. Tu cita sigue en su horario original. ¿Te ofrezco otros horarios libres?'
      : 'no pude reagendar tu cita en este momento. Tu cita sigue como estaba, sin cambios. ¿Intentamos con otra fecha y hora?')
  );
}

/**
 * Customer-facing fallback when a scheduling tool ran but we could not
 * produce a confirmation with a Meet link (tool threw, or the model ran
 * out of rounds). Sent instead of leaving the customer in silence.
 */
export const AGENDAR_FALLBACK_MESSAGE =
  'Tu cita ha sido procesada, pero tuvimos un inconveniente generando el enlace de Google Meet. Un asesor te contactará en breve.';

/**
 * Fallback for a reschedule whose outcome is unknown because the tool itself
 * blew up. It must NOT claim the move happened.
 */
export const REAGENDAR_FALLBACK_MESSAGE =
  'No pude confirmar el cambio de horario de tu cita. Tu cita sigue en su horario original; por favor confirma la fecha y hora con un asesor.';

/**
 * Neutral acknowledgement for the turns where the grounding guard
 * deliberately DROPS the model's text (an ungrounded booking claim, or a
 * bare "un momento…" / link promise with no real link behind it), and for
 * turns that end with no text at all.
 *
 * Dropping the text is right — it stops a fabricated confirmation reaching the
 * customer — but returning without sending anything leaves the thread on
 * "seen", which is the exact failure mode this whole path exists to prevent.
 * So we send THIS instead of nothing.
 *
 * It deliberately asserts nothing that could be false:
 *   - no confirmed cita, no date, no link (so it can never contradict a real
 *     agendar_cita result);
 *   - no promise that a human was assigned — this path NEVER auto-assigns, so
 *     "un asesor te contactará" would be a lie. It asks for the next step
 *     instead, which also keeps the booking flow moving.
 */
export function buildUngroundedAckMessage(contactName?: string | null): string {
  const nombre = contactName?.trim();
  return nombre
    ? `¡Gracias, ${nombre}! Recibí tu información. ¿Deseas que agende tu cita ahora?`
    : '¡Gracias! Recibí tu información. ¿Deseas que agende tu cita ahora?';
}

/**
 * Deterministic, customer-facing booking confirmation built from the REAL
 * agendar_cita tool result (fecha/hora/link) — it does not depend on the
 * model echoing the link back. Dispatched by the backend the instant a
 * booking succeeds, so a booked appointment ALWAYS reaches the customer
 * in ONE bubble (the sender is told to skip its paragraph splitter). The
 * Google Meet URL is MANDATORY: it uses the real link returned by the
 * tool (hangoutLink/entryPoints/htmlLink) or the MEET_FALLBACK_LINK —
 * the message is never sent without a URL.
 * Returns null when the booking was not confirmed.
 */
export function buildBookingConfirmationMessage(
  booking: BookingToolResult,
  contactName?: string | null
): string | null {
  if (booking.confirmado !== true) return null;
  const nombre = contactName?.trim() || 'Humberto';
  const fecha = booking.fecha ?? booking.inicio?.slice(0, 10) ?? '';
  const hora = booking.hora ?? booking.inicio?.slice(11, 16) ?? '';
  const link = booking.link || MEET_FALLBACK_LINK;
  return `¡Listo, ${nombre}! Tu cita ha sido agendada con éxito para el ${fecha} a las ${hora}.\n\nPuedes unirte a la videollamada de Google Meet directamente desde este enlace:\n${link}`;
}

/**
 * Notificación determinística cuando la cita se registró en el CRM pero la
 * creación del evento en Google Calendar falló (timeout o error de API),
 * de modo que NO existe un enlace real de Meet. Se envía al cliente en
 * lugar de simular un éxito con un enlace inexistente, para que la
 * conversación nunca quede en silencio. Devuelve null si la cita no
 * quedó confirmada.
 */
export function buildBookingCalendarErrorMessage(
  booking: BookingToolResult,
  contactName?: string | null
): string | null {
  if (booking.confirmado !== true || booking.calendarSynced !== false) {
    return null;
  }
  const nombre = contactName?.trim() || 'Humberto';
  const fecha = booking.fecha ?? booking.inicio?.slice(0, 10) ?? '';
  const hora = booking.hora ?? booking.inicio?.slice(11, 16) ?? '';
  const cuando = fecha && hora ? ` para el ${fecha} a las ${hora}` : '';
  return (
    `¡Gracias, ${nombre}! Registramos tu cita${cuando}, pero en este momento no pudimos crear el evento en Google Calendar ni generar el enlace de Google Meet. ` +
    'Un asesor te enviará el enlace de la videollamada en breve.'
  );
}

/**
 * Deterministic reply for "mándame el link": the customer asked for the
 * Meet link of an ALREADY-booked cita. Built from the meet_link stored in
 * the `citas` table — never invented by the model.
 */
export function buildMeetLinkResendMessage(
  link: string,
  citaInfo?: { fecha: string | null; hora: string | null } | null
): string {
  const base = `Aquí tienes el enlace de tu reunión de Google Meet:\n${link}`;
  const fecha = citaInfo?.fecha || '';
  const hora = citaInfo?.hora || '';
  return fecha && hora
    ? `${base}\n\nCorresponde a tu cita del ${fecha} a las ${hora}.`
    : base;
}

/** Phrases where the customer is explicitly asking for their link. */
const RESEND_LINK_RE =
  /(?:m[aá]ndame|env[ií]a(?:me)?|p[aá]same|d[aá]me|comparte(?:me)?|r[eé]pite(?:me)?|quiero|necesito)\s+(?:el\s+|mi\s+|nuevamente\s+|otra\s+vez\s+|de\s+nuevo\s+)?(?:enlace|link|url)\b|(?:enlace|link|url)\s+(?:de|del)\s+(?:la\s+|mi\s+|tu\s+)?(?:cita|reuni[oó]n|meet|google\s*meet)\b|no\s+(?:me\s+)?(?:lleg[oó]|recib[ií]|veo)\s+(?:el\s+|mi\s+)?(?:enlace|link|url)\b/i;

/** True when the user's latest message asks to be sent their link. */
function wantsMeetLink(message: string | null | undefined): boolean {
  return typeof message === 'string' && RESEND_LINK_RE.test(message);
}

/** Latest confirmed cita of the contact that still has a usable link. */
interface StoredCitaConLink {
  id: string;
  fecha_inicio: string;
  meet_link: string;
}

async function latestCitaConLink(
  db: SupabaseClient,
  contactId: string
): Promise<StoredCitaConLink | null> {
  try {
    const { data, error } = await db
      .from('citas')
      .select('id, fecha_inicio, meet_link')
      .eq('contact_id', contactId)
      .eq('estado', 'confirmada')
      .not('meet_link', 'is', null)
      .order('fecha_inicio', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data || typeof data.meet_link !== 'string') return null;
    return {
      id: data.id as string,
      fecha_inicio: data.fecha_inicio as string,
      meet_link: data.meet_link,
    };
  } catch (err) {
    console.error('[ai auto-reply] latest cita link lookup failed:', err);
    return null;
  }
}

/** Bogota-local YYYY-MM-DD / HH:MM of an ISO instant (tool numeric style). */
function fechaHoraBogota(inicioIso: string): { fecha: string; hora: string } {
  const start = new Date(inicioIso);
  if (Number.isNaN(start.getTime())) return { fecha: '', hora: '' };
  const fecha = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/Bogota',
  }).format(start);
  const hora = new Intl.DateTimeFormat('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'America/Bogota',
  })
    .format(start)
    .replace(/[^\d:]/g, '');
  return { fecha, hora };
}

/**
 * Google Meet / Google Calendar URL patterns that ONLY the real tool
 * output may contain. Any occurrence generated by the model is fake.
 */
const FAKE_LINK_SRC =
  'https?:\\/\\/(?:meet\\.google\\.com\\/[\\w-]+|calendar\\.google\\.com\\/event[^\\s"\\)]*)';
const FAKE_LINK_RE = new RegExp(FAKE_LINK_SRC, 'gi');
const FAKE_LINK_DETECT = new RegExp(FAKE_LINK_SRC, 'i');

/** Phrases the model uses for a "wait, I'm on it" message WHILE NO tool
 *  has actually run. Under the no-repetitive-intermediate rule these are
 *  not acceptable as the final WhatsApp message for a booking request. */
const INTERMEDIATE_ACK_RE =
  /un momento|en un momento|un instante|enseguida|estoy registrando|estoy agendando|estoy confirmando|estoy revisando|estoy verificando|d[eé]jame (?:revisar|verificar|ver|consultar|agendar)|ya te (?:confirmo|aviso|digo)|ya mismo|por favor espera|espera un moment|perm[ií]teme|un segundo/i;

/** Phrases that PROMISE a Meet/meeting link. A final WhatsApp message
 *  containing one of these but no REAL link (from the tool result) would
 *  go out as a dangling "aquí está el enlace:" — never send that. */
const LINK_PROMISE_RE =
  /este es el enlace|aqu[ií] tienes el enlace|a trav[eé]s de este enlace|para que te conectes|para acceder a (?:la|tu) (?:videollamada|reuni[oó]n|llamada)|[uú]nete a (?:la|tu) (?:videollamada|reuni[oó]n|llamada)|(?:el|este) enlace de (?:Google )?Meet\s*:/i;

/** Booking signals in the conversation: an ack/claim is only intercepted
 *  when the customer is actually trying to schedule. */
const BOOKING_INTENT_RE =
  /\bcita\b|agendar|reagendar|reuni[oó]n|horario|disponible|disponibilidad|a qu[eé] hora|qu[eé] horario|consult(?:a|ar|aci[oó]n)|valoraci[oó]n|ma[nñ]ana a las|hoy a las|semana que viene/i;

function hasBookingIntent(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) => typeof m.content === 'string' && BOOKING_INTENT_RE.test(m.content)
  );
}

function looksLikeBookingConfirmation(text: string): boolean {
  if (!/\bcita\b/i.test(text)) return false;
  if (FAKE_LINK_DETECT.test(text)) return true;
  return /agend(?:ad[oa]|é|amos)|confirm(?:ad[oa]|ada)|qued(?:ó|o)\s+/i.test(
    text
  );
}

/**
 * Deterministic guard against hallucinated bookings. Runs on the final
 * message BEFORE it is sent:
 *  - raw wall-clock/timestamp reads ("17:32:11 -05:00", ISO datetimes) are
 *    stripped first so the bubble only ever carries the final text the AI
 *    redacted for the customer,
 *  - real scheduling success + link → replace every Meet/calendar URL
 *    with that link (append it if the model omitted it),
 *  - real success but no link         → use MEET_FALLBACK_LINK, keeping a
 *    Google Meet URL in any confirmation,
 *  - no real success this turn: never promise a booking. When the text
 *    claims a booking (and the customer was trying to schedule) OR is an
 *    intermediate "un momento…" wait message (always, booking or not)
 *    return null so the caller skips the turn without muting; anything
 *    else keeps its fake URLs stripped.
 *
 * `authoritative` marks text the BACKEND composed from a verified tool result
 * (a reschedule confirmation, or the truthful account of a refused one). That
 * text is not a model claim, so the suppression branches are skipped for it —
 * otherwise the accurate "no encontré ninguna cita previa… te agendo una nueva"
 * would be mistaken for a fabricated booking and dropped, and the customer
 * would get a redundant acknowledgement instead of the real answer.
 */
export function guardBookingReply(
  raw: string,
  booking: BookingToolResult | null,
  opts: { bookingContext?: boolean; authoritative?: boolean } = {}
): string | null {
  if (!raw) return raw;

  // ÚNICAMENTE el texto final redactado por la IA sale por WhatsApp: se
  // filtran marcas de hora/zona en crudo del resultado de una herramienta
  // (p. ej. "17:32:11 -05:00" o "2026-09-17T17:32:11-05:00").
  const text = stripRawTimestamps(raw);
  if (!text) return null;

  const confirmed = booking?.confirmado === true;
  // Un mensaje de confirmación NUNCA queda sin URL: el link real si la
  // tool lo devolvió, si no el fallback de Meet.
  const resolvedLink: string = booking?.link || MEET_FALLBACK_LINK;

  if (confirmed) {
    const replaced = text.replace(FAKE_LINK_RE, resolvedLink);
    return replaced.includes(resolvedLink)
      ? replaced
      : `${replaced}\nAquí tienes el enlace de tu reunión: ${resolvedLink}`;
  }

  if (opts.authoritative) return text.replace(FAKE_LINK_RE, '');

  // NUNCA enviar un texto que prometa un enlace de Meet/meeting sin que la
  // tool lo haya devuelto: "Este es el enlace de Google Meet para que te
  // conectes:" sin URL sería una burbuja vacía.
  if (LINK_PROMISE_RE.test(text)) return null;
  if (INTERMEDIATE_ACK_RE.test(text)) return null;
  if (opts.bookingContext ?? false) {
    if (looksLikeBookingConfirmation(text)) return null;
  }
  return text.replace(FAKE_LINK_RE, '');
}

interface DispatchArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  configOwnerUserId: string;
  /** Meta id (wamid) of the inbound message being answered — used to
   *  keep WhatsApp's typing indicator alive across the multi-part reply. */
  composeMessageId?: string;
  /**
   * Set by the webhook when Meta disclosed no dialable number for this
   * sender (BSUID / @username only). Adds the "ask for your number" rule to
   * the system prompt — see `buildSystemPrompt`.
   */
    missingPhone?: boolean;
    /**
     * Record the inbound in the model's context but do not put anything on the
     * wire.
     *
     * Used for messages where silence is the correct answer but ignorance is
     * not: a WhatsApp reaction (a bare 👍 is an acknowledgement of something we
     * already said, not a question) and any message a Flow has already
     * answered. Previously the webhook `return`ed before dispatch, so these
     * messages were invisible to the LLM forever - it could not tell the
     * customer had approved a quote or reacted to a photo, and would sometimes
     * re-raise the same topic.
     */
    suppressReply?: boolean;
  }

/**
 * Re-resolve the recipient and retry the reply once.
 *
 * Called only after `engineSendAiReply` threw a recipient rejection, so the
 * contact row may have changed since the senders read it. Returns true when
 * the reply went out, false when there was simply no other address to try.
 *
 * A retry here is only safe because it happens exclusively on a recipient
 * error: the previous attempt never reached the customer, so this cannot
 * duplicate a delivered message.
 */
async function retryAiReplyWithFreshRecipient(args: {
  accountId: string;
  conversationId: string;
  contactId: string;
  userId: string;
  text: string;
  composeMessageId?: string;
  single?: boolean;
  previousError: unknown;
}): Promise<boolean> {
  const db = supabaseAdmin();

  const { data } = await db
    .from('contacts')
    .select('id, phone, wa_user_id, username')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle();

  const contact = (data as
    | { id: string; phone?: string | null; wa_user_id?: string | null; username?: string | null }
    | null) ?? null;
  if (!contact) return false;

  const queue = await resolveOutboundAddressQueue(
    contact,
    args.accountId,
    args.conversationId,
  );
  if (queue.length === 0) return false;

  console.warn(
    `[ai auto-reply] contact ${args.contactId}: re-resolved ${queue.length} candidate address(es) after a recipient rejection (${args.previousError instanceof Error ? args.previousError.message : String(args.previousError)})`
  );

  // No address left that the sender didn't already try.
  if (queue.length <= 1) return false;

  try {
    await engineSendAiReply({
      accountId: args.accountId,
      userId: args.userId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text: args.text,
      aiGenerated: true,
      composeMessageId: args.composeMessageId,
      single: args.single,
    });
    return true;
  } catch (err) {
    // The retry walked the same full queue; rethrow so the caller logs it.
    throw err;
  }
}

/** Best-effort phone lookup so every skip diagnostic can name the contact. */
async function contactPhoneFor(
  db: SupabaseClient,
  contactId: string
): Promise<string | null> {
  try {
    const { data } = await db
      .from('contacts')
      .select('phone')
      .eq('id', contactId)
      .maybeSingle();
    return (data as { phone?: string | null } | null)?.phone ?? null;
  } catch {
    return null;
  }
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args;

  // Every early return below logs the reason. A gate that returns quietly
  // is indistinguishable from a hung LLM call, which is exactly why
  // "the bot just doesn't answer" was undiagnosable.
  console.log(
    `[ai auto-reply] dispatch requested — conversation ${conversationId}, contact ${contactId}, account ${accountId}`
  );

  const bypass = bypassEnabled();
  if (bypass) {
    console.warn(
      `[ai auto-reply] ===== BYPASS MODE ACTIVE (AI_AUTOREPLY_BYPASS=true) — ignoring assignment, pause, automation override and the on/off toggles. REMOVE THIS VARIABLE WHEN DONE. =====`
    );
  }

  // Tracks whether this turn already put a message on the wire. Every gate
  // that deliberately stays silent RETURNS instead of throwing, so anything
  // that reaches the catch block is an UNINTENDED failure — and an
  // unintended failure always earns the neutral acknowledgement (the
  // helper itself honours `suppressReply`, so a Flow-consumed message or a
  // reaction can never be answered by accident).
  let replyDispatched = false;

  // A suppressed dispatch still walks every gate above (config, assignment,
  // rate limit) purely to keep the logs honest, but never reaches the wire:
  // `sendTurnFallback` refuses to send under `suppressReply`, so neither a
  // turn failure nor a config failure can answer a message a Flow or a
  // reaction already owns.
  if (args.suppressReply) {
    console.log(
      `[ai auto-reply] dispatch requested for conversation ${conversationId} with suppressReply=true — ` +
        `the message is recorded as context but no reply will be sent.`
    );
  }

  try {
    const db = supabaseAdmin();

    let config: AiConfigLike | null;
    try {
      config = await loadAiConfig(db, accountId);
    } catch (err) {
      // A stored key that cannot be decrypted (rotated ENCRYPTION_KEY,
      // corrupt ciphertext, partial write) is a KEY failure — the operator
      // never chose silence. REGLA DE ORO: name the real cause and put the
      // neutral acknowledgement on WhatsApp; the send path does not need
      // the AI key, so it works even when the AI key is unusable.
      if (err instanceof AiKeyDecryptError) {
        console.error(
          '[CRITICAL_AI_KEY_ERROR]: No se pudo desencriptar la API Key. Verifica ENCRYPTION_KEY en las variables de entorno'
        );
      }
      console.error('[ai auto-reply] config_load_failed', {
        accountId,
        conversationId,
        contactId,
        message: err instanceof Error ? err.message : String(err),
      });
      await sendTurnFallback(args, 'ai config could not be loaded/decrypted');
      return;
    }
    if (!config || !config.autoReplyEnabled) {
      // loadAiConfig returns null for a missing row, is_active=false, or an
      // empty api_key — three very different operator mistakes that all
      // used to collapse into one invisible no-op. Re-read the raw row so
      // the log says WHICH one it is: "I updated the key and the bot went
      // quiet" is answerable from this line alone.
      const { data: rawRow } = await db
        .from('ai_configs')
        .select('is_active, auto_reply_enabled, api_key')
        .eq('account_id', accountId)
        .maybeSingle();
      const row = (rawRow ?? null) as {
        is_active?: boolean;
        auto_reply_enabled?: boolean;
        api_key?: string | null;
      } | null;
      const gap = row
        ? `row exists, is_active=${row.is_active}, auto_reply_enabled=${row.auto_reply_enabled}, key_present=${Boolean(row.api_key)}`
        : 'no ai_configs row';
      console.warn(
        `[ai auto-reply] not enabled for account ${accountId} — skipping. ${gap}.`
      );
      if (bypass) {
        config = emergencyConfig(config);
        console.warn(
          `[ai auto-reply] BYPASS: continuing with an emergency config — provider=${config.provider} model=${config.model} keyPresent=${Boolean(config.apiKey)}`
        );
        if (!config.apiKey) {
          console.error(
            '[ai auto-reply] BYPASS: no API key available at all (set AI_AUTOREPLY_BYPASS_KEY). Sending an outbound probe instead.'
          );
          await sendOutboundProbe(args, 'no AI key available under bypass');
          return;
        }
      } else {
        // Toggles off (or no row at all) is a deliberate operator choice —
        // stay silent as logged. But a row whose switches are ON and whose
        // key has vanished is not: honour the REGLA DE ORO and answer.
        if (row && row.is_active && row.auto_reply_enabled && !row.api_key) {
          await sendTurnFallback(args, 'ai_configs row has no API key');
        }
        return;
      }
    }

    console.log(
      `[ai auto-reply] config OK — provider=${config.provider} model=${config.model} ` +
        `key_fingerprint=${apiKeyFingerprint(config.apiKey)} ` +
        `is_active=${config.isActive} auto_reply_enabled=${config.autoReplyEnabled}`
    );

    const { data: autoResponders, error: autoResponderErr } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1);
    if (autoResponderErr) {
      console.error(
        '[ai auto-reply] could not read the automations table; proceeding without the override check:',
        autoResponderErr.message
      );
    }
    if (autoResponders && autoResponders.length > 0) {
      console.warn(
        `[ai auto-reply] an active automation (id ${autoResponders[0].id}) already answers "new_message_received"/"keyword_match" for account ${accountId} — the bot stands down to avoid double replies. Disable that automation to let the AI answer.`
      );
      if (!bypass) return;
      console.warn('[ai auto-reply] BYPASS: ignoring the automation override.');
    }

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id')
      .eq('id', conversationId)
      .maybeSingle();
    if (convErr || !conv) {
      console.error(
        `[ai auto-reply] could not load conversation ${conversationId} — skipping:`,
        convErr?.message ?? 'row not found'
      );
      if (bypass) {
        await sendOutboundProbe(args, 'conversation could not be loaded');
      }
      return;
    }
    // Único criterio de silencio: un humano que tomó el control. No existe
    // flag de pausa ni de handoff (ai_autoreply_disabled) ni límite de
    // respuestas: mientras no haya agente asignado, la IA responde SIEMPRE
    // cada mensaje entrante ("Hola", "?", etc.) sin dejar en visto.
    if (conv.assigned_agent_id) {
      // Last-chance auto-unlock. The webhook already clears this on inbound
      // (see autoUnblockConversation), so reaching this point with an
      // assignment still set means the thread was taken over BETWEEN the
      // webhook's unblock and this gate — or the webhook unblock was
      // disabled. Diagnostic names the contact so the operator can act.
      const phone = await contactPhoneFor(db, contactId);
      if (autoUnblockEnabled()) {
        const unblocked = await autoUnblockConversation(
          db,
          conversationId,
          phone
        );
        if (unblocked.changed) {
          console.warn(
            `[ai auto-reply] phone ${phone ?? 'unknown'}: took over a thread that was assigned and is now answering it (cleared: ${unblocked.reasons.join(', ')})`
          );
        } else {
          console.warn(
            `[ai auto-reply] phone ${phone ?? 'unknown'}: auto-unblock did not clear the assignment; answering anyway under auto-unblock.`
          );
        }
      } else {
        console.warn(
          `[ai auto-reply] SKIPPED — phone ${phone ?? 'unknown'} (conversation ${conversationId}) is assigned to agent ${conv.assigned_agent_id}: a human took this thread over. Unassign it, or set AI_AUTOREPLY_AUTO_UNBLOCK=false/undefined to keep this behaviour.`
        );
        return;
      }
    }

    // Cada mensaje entrante arranca con el contador en cero y sin flags
    // legacy: un hilo que quedó con el contador en el límite de una versión
    // anterior se desbloquea solo al llegarle un mensaje nuevo, sin que un
    // agente tenga que hacer un "Take over" manual.
    await resetAutoReplyCounter(db, conversationId);

    let messages: ChatMessage[];
    try {
      messages = await buildConversationContext(db, conversationId);
    } catch (err) {
      // A DB failure building the transcript is not a gate decision — the
      // customer's message already arrived and nobody chose to ignore it.
      // REGLA DE ORO: log it and answer with the neutral acknowledgement.
      console.error('[ai auto-reply] context_load_failed', {
        accountId,
        conversationId,
        contactId,
        message: err instanceof Error ? err.message : String(err),
      });
      await sendTurnFallback(args, 'conversation context could not be loaded');
      return;
    }
    if (messages.length === 0) {
      console.error(
        `[ai auto-reply] conversation context for ${conversationId} came back empty — nothing to answer.`
      );
      if (bypass) {
        await sendOutboundProbe(args, 'conversation context was empty');
      }
      return;
    }

    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount
    );
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`
      );
      if (bypass) {
        console.warn(
          '[ai auto-reply] BYPASS: ignoring the per-account rate limit (30/min).'
        );
      } else {
        return;
      }
    }

    // Every gate that deliberately stays silent has now passed (each one
    // RETURNs; none throws), so from here on any failure must reach the
    // customer — which the catch block's fallback guarantees.

    // ...unless this particular inbound was context-only. Placed after the
    // gates so the logs still show how the account was configured, and before
    // any provider call so a suppressed reaction costs nothing.
    if (args.suppressReply) {
      console.log(
        `[ai auto-reply] conversation ${conversationId}: message recorded as context only (suppressReply) — no model call, no outbound send.`
      );
      return;
    }

    // Pre-LLM context is fetched in parallel (knowledge retrieval and
    // the contact profile/citas are independent) so the reply isn't held
    // for two sequential DB + embedding round trips.
    //
    // BOTH are wrapped: knowledge under a 2.5s ceiling, contact context
    // against any rejection. Neither may cancel the turn — if either one
    // hangs or fails, the bot answers from what it already has rather
    // than leaving the message on "seen" forever.
    const [knowledge, contactCtx] = await Promise.all([
      safeRetrieveKnowledge(
        db,
        accountId,
        config,
        latestUserMessage(messages)
      ),
      safeLoadContactContext(db, contactId),
    ]);

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      contactName: contactCtx?.name,
      contactEmail: contactCtx?.email,
      contactLocation: contactCtx?.location,
      calendarEnabled: calendarConfigured(),
      gmailEnabled: gmailConfigured(),
      citas: contactCtx?.citas,
      missingPhone: args.missingPhone === true,
    });

    // Tool execution loop: the model may request tool calls before
    // producing a final text reply. We feed tool results back and
    // re-generate up to MAX_TOOL_ROUNDS times.
    let finalText: string | null = '';
    let finalUsage = null;
    let toolFallback: string | null = null;
    // true en cuanto el modelo invocó agendar_cita este turno. Garantiza que
    // una intención real de agendamiento NUNCA termine sin mensaje aunque el
    // modelo devuelva texto vacío (bot "congelado").
    let bookingAttempted = false;
    // Latest REAL successful booking from a scheduling tool's JSON_RESULT.
    // Everything else that looks like a confirmation is hallucination.
    let realBooking: BookingToolResult | null = null;
    // Latest REAL failure from a scheduling tool. Kept so a refused move is
    // reported truthfully instead of leaving the customer on silence (or, far
    // worse, letting the model's prose confirm a move that never happened).
    let bookingFailure: BookingToolResult | null = null;
    /** True once `finalText` came from the backend, not from the model. */
    let finalTextIsDeterministic = false;
    const conversationMessages: ChatMessage[] = [...messages];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      // Logged immediately before the network call: if the provider hangs
      // or rejects, this line is the last thing in the logs and tells you
      // the request left the app (vs. never being attempted).
      console.log(
        `[ai auto-reply] calling ${config.provider}/${config.model} — round ${round + 1}/${MAX_TOOL_ROUNDS + 1}, ${conversationMessages.length} message(s) in context`
      );
      const result = await generateReply({
        config,
        systemPrompt,
        messages: conversationMessages,
        tools: AI_TOOLS,
      }).catch((err: unknown) => {
        // Structured provider-failure line — the ONE line to read when
        // "the bot stopped answering". Carries: which provider/model was
        // called, our mapped status, the UPSTREAM HTTP status OpenRouter
        // actually returned (401 bad key / 402 no credit / 404 unknown
        // model / 429 / 500), AiError's code (invalid_key, rate_limited,
        // timeout, empty_response, provider_error) and the provider's own
        // error message verbatim. Then rethrow: the outer catch owns the
        // customer-facing fallback.
        console.error('[ai auto-reply] provider_failure', {
          provider: config.provider,
          model: config.model,
          round: round + 1,
          conversationId,
          accountId,
          code: err instanceof AiError ? err.code : 'unknown',
          status: err instanceof AiError ? err.status : undefined,
          upstream_status: err instanceof AiError ? err.upstreamStatus : undefined,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      });

      console.log(
        `[ai auto-reply] provider replied — text=${result.text?.length ?? 0} chars, toolCalls=${result.toolCalls?.length ?? 0}`
      );

      finalUsage = result.usage;

      // If the model returned tool calls, execute them and continue.
      if (result.toolCalls && result.toolCalls.length > 0) {
        const toolResults: ChatMessage[] = [];
        for (const tc of result.toolCalls) {
          let output: string;
          try {
            output = await executeToolCall(db, accountId, contactId, tc);
          } catch (err) {
            // A thrown tool must never abort the whole turn — that would
            // leave the customer with no message at all. Turn the failure
            // into a tool result the model can relay, and remember a
            // deterministic fallback for the scheduling case.
            console.error(`[ai auto-reply] tool "${tc.name}" threw:`, err);
            if (tc.name === 'agendar_cita') {
              toolFallback = AGENDAR_FALLBACK_MESSAGE;
            } else if (tc.name === 'reagendar_cita') {
              // Never say "moví tu cita" when we do not know what happened.
              toolFallback = REAGENDAR_FALLBACK_MESSAGE;
            }
            output = isCitaMutatingTool(tc.name)
              ? (toolFallback ?? 'Error: la herramienta no pudo completarse.')
              : `Error: la herramienta ${tc.name} no pudo completarse.`;
          }
          // Grounding: remember the LAST confirmed booking's real link so
          // the outgoing message can never carry a link the tool didn't
          // return. Ignore tool results that announced an error.
          if (isCitaMutatingTool(tc.name)) {
            bookingAttempted = true;
            const parsed = extractBookingResult(output);
            if (parsed?.confirmado) {
              realBooking = parsed;
              bookingFailure = null;
            } else if (parsed && parsed.exito === false) {
              bookingFailure = parsed;
            }
          }
          toolResults.push({
            role: 'tool',
            content: output,
            toolCallId: tc.id,
          });
        }
        // Append the assistant message carrying the requested tool_calls
        // plus the results so the model can reason over them on the next
        // round, then loop for a final reply.
        conversationMessages.push({
          role: 'assistant',
          content: result.text || '',
          toolCalls: result.toolCalls,
        });
        conversationMessages.push(...toolResults);
        continue;
      }

      // No tool calls — this is the final text reply.
      finalText = result.text;
      break;
    }

    // La creación del evento en Google Calendar falló (timeout/error de
    // API) pero la cita sí quedó registrada: se notifica al cliente con un
    // mensaje determinístico en lugar de simular un enlace de Meet real.
    const calendarFailed =
      realBooking?.confirmado === true && realBooking.calendarSynced === false;

    if (calendarFailed) {
      finalText = buildBookingCalendarErrorMessage(
        realBooking as BookingToolResult,
        contactCtx?.name
      );
      toolFallback = null;
      finalTextIsDeterministic = true;
    } else if (realBooking?.confirmado) {
      // The instant a scheduling tool REALLY succeeded, the backend composes
      // and dispatches the confirmation itself — it must never depend on the
      // model's final echo (which can be empty or a handoff, leaving a booked
      // or moved cita with NO WhatsApp message). Covers the case where Google
      // generated the Meet link or the fallback link.
      // A move is worded as a move: reusing the booking wording here would
      // tell the customer a cita was "agendada" when it was in fact shifted.
      const deterministic =
        realBooking.accion === 'reagendar'
          ? buildRescheduleConfirmationMessage(
              realBooking,
              contactCtx?.name
            )
          : buildBookingConfirmationMessage(realBooking, contactCtx?.name);
      if (deterministic) {
        finalText = deterministic;
        toolFallback = null;
        finalTextIsDeterministic = true;
      }
    } else if (bookingFailure) {
      // The tool refused. Replace whatever the model wrote — including a
      // confident "¡listo, te la movimos!" — with the truthful outcome.
      const truthful = buildRescheduleFailureMessage(
        bookingFailure,
        contactCtx?.name
      );
      if (truthful) {
        finalText = truthful;
        toolFallback = null;
        finalTextIsDeterministic = true;
      }
    }

    // "Mándame el link": el cliente pide (de nuevo) el enlace de su cita.
    // Garantía determinística — se lee la última cita confirmada del
    // contacto directamente de la BD y se responde con su meet_link real.
    // Solo aplica cuando NO se agendó en este turno: si agendar_cita acaba
    // de correr, el enlace recién creado gana.
    if (
      !realBooking?.confirmado &&
      wantsMeetLink(latestUserMessage(messages))
    ) {
      const stored = await latestCitaConLink(db, contactId);
      if (
        stored &&
        stored.meet_link &&
        stored.meet_link !== MEET_FALLBACK_LINK
      ) {
        const { fecha, hora } = fechaHoraBogota(stored.fecha_inicio);
        realBooking = {
          confirmado: true,
          link: stored.meet_link,
          inicio: stored.fecha_inicio,
          idCita: stored.id,
          fecha,
          hora,
        };
        finalText = buildMeetLinkResendMessage(stored.meet_link, {
          fecha,
          hora,
        });
        toolFallback = null;
      }
    }

    // The tool round must NOT be the end of the turn. Force one extra,
    // tool-free generation so the model turns the tool output (the Meet
    // link, the booked time) into a customer-facing confirmation even
    // when the round budget was exhausted by repeated tool calls.
    if (!finalText) {
      try {
        const final = await generateReply({
          config,
          systemPrompt,
          messages: conversationMessages,
        });
        finalUsage = final.usage ?? finalUsage;
        finalText = final.text;
      } catch (err) {
        console.error('[ai auto-reply] final confirmation pass failed:', err);
      }
    }

    // Last resort: if a scheduling tool was attempted (threw or errored) and
    // the model still said nothing, send the fallback rather than going
    // silent — the customer must ALWAYS get a WhatsApp reply.
    if (!finalText && (toolFallback || bookingAttempted)) {
      finalText = toolFallback ?? AGENDAR_FALLBACK_MESSAGE;
    }

    // Anti-hallucination guard: the final message must be grounded in a
    // REAL tool result. Fake Meet/calendar URLs are replaced with the
    // returned link; a booking claim or an intermediate "un momento…"
    // without a real success never goes out. A wait-only phrase ("un
    // momento…") only skips that turn WITHOUT muting the conversation —
    // the next message is answered normally instead of leaving the chat
    // permanently silent.
    if (finalText) {
      const raw = finalText;
      // Chain-of-Thought / thinking blocks are NEVER part of the answer.
      // Stripped again here (idempotent, defense-in-depth on top of
      // parseGeneration) so no internal reasoning reaches WhatsApp even
      // if the model leaks it into the final bubble.
      finalText = guardBookingReply(
        stripInternalReasoning(finalText),
        calendarFailed ? null : realBooking,
        {
          bookingContext: hasBookingIntent(messages),
          // Backend-composed text is already grounded; suppressing it would
          // swallow the accurate answer to a refused move.
          authoritative: finalTextIsDeterministic,
        }
      );
      const isWaitOnly =
        (INTERMEDIATE_ACK_RE.test(raw) || LINK_PROMISE_RE.test(raw)) &&
        !looksLikeBookingConfirmation(raw);
      if (finalText === null && isWaitOnly) {
        console.log(
          '[ai auto-reply] dropped an empty reply without a link — sending a neutral acknowledgement instead of staying silent.'
        );
        if (bypass) {
          await sendOutboundProbe(args, 'model produced only a link promise');
          return;
        }
        finalText = buildUngroundedAckMessage(contactCtx?.name);
      }
      if (finalText === null) {
        console.log(
          '[ai auto-reply] dropped an ungrounded text — sending a neutral acknowledgement instead of staying silent.'
        );
        if (bypass) {
          await sendOutboundProbe(args, 'model text failed the grounding guard');
          return;
        }
        finalText = buildUngroundedAckMessage(contactCtx?.name);
      }
    }

    // Record token spend on the account's BYO key.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage: finalUsage,
    });

    // El modelo se quedó sin texto (turno en blanco tras usar herramientas).
    // Antes este caso devolvía el turno sin enviar NADA, dejando al cliente
    // con el mensaje en visto. Ahora se responde con un acuse neutro: no
    // afirma que exista una cita, no inventa fecha ni enlace, y no marca la
    // conversación como muda ni la asigna a un humano — el siguiente mensaje
    // se sigue respondiendo con normalidad.
    if (!finalText) {
      console.log(
        '[ai auto-reply] no final text — sending a neutral acknowledgement instead of staying silent.'
      );
      if (bypass) {
        await sendOutboundProbe(args, 'the model returned empty text');
        return;
      }
      finalText = buildUngroundedAckMessage(contactCtx?.name);
    }

    // The per-conversation slot claim. It exists to keep the row-level lock
    // that serialises two concurrent dispatches on the same thread, and it
    // is NO LONGER allowed to gate the send:
    //
    //   * `resetAutoReplyCounter` zeroes `ai_reply_count` on every inbound,
    //     so no stored cap can ever be reached — the cap is meaningless.
    //   * A missing function, a missing `service_role` EXECUTE grant, or a
    //     stale definition from an older migration all made this RPC fail
    //     or refuse the slot, which silenced the bot for EVERY inbound
    //     while looking like a healthy run. That is exactly the class of
    //     silent failure this whole path is meant to stop having.
    //
    // So a failure here is logged loudly and the reply still goes out.
    // Duplicate deliveries of the same Meta message are already filtered
    // upstream by the `messages` upsert (ignoreDuplicates), so honouring
    // the claim is not what protects against double-sends.
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        // El tope sale de la configuración real de la cuenta. El valor
        // "sin tope" se envía como 99999 (NO como 0): ver effectiveMaxReplies
        // — mandar 0 deja al bot mudo de forma permanente si la función
        // claim_ai_reply_slot instalada es la de la migración 029.
        max_replies: effectiveMaxReplies(config.autoReplyMaxPerConversation),
      }
    );
    if (claimErr) {
      console.error(
        '[ai auto-reply] claim_ai_reply_slot failed; sending anyway. Check that the function exists and that service_role has EXECUTE on it (supabase/ci/verify-schema.sql asserts both):',
        claimErr
      );
    } else if (claimed !== true) {
      console.warn(
        `[ai auto-reply] claim_ai_reply_slot returned false for conversation ${conversationId}; sending anyway. The installed DB function may predate migration 046.`
      );
    }

    const enviado = await engineSendAiReply({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: stripInternalReasoning(finalText),
      aiGenerated: true,
      composeMessageId: args.composeMessageId,
      // La confirmación de una cita REAL va en UNA sola burbuja: se salta
      // el split por párrafos para que el cliente reciba la fecha, la hora
      // y el enlace de Meet juntos, sin cortes que puedan dejar el enlace
      // fuera o dividido en varios mensajes. Lo mismo para el aviso
      // determinístico de un reagendamiento rechazado: es una sola
      // explicación, no una conversación.
      single: realBooking?.confirmado === true || finalTextIsDeterministic,
    }).catch(async (err: unknown) => {
      // The model already produced an answer, so a send failure is the
      // one error the operator most needs verbatim: "contact phone
      // invalid", "WhatsApp not configured for this account", a bad
      // access_token, or Meta rejecting every number variant (131030 =
      // outside the 24h window).
      console.error(
        `[ai auto-reply] SEND to WhatsApp FAILED for conversation ${conversationId} (contact ${contactId}, account ${accountId}). The reply text was generated but never delivered:`,
        err instanceof Error
          ? { message: err.message, stack: err.stack, ...(err as object) }
          : err
      );

      // Meta rejected the address we picked. The sender already tried every
      // identifier on the contact row, so the only thing left that it
      // cannot see is a value the CRM learned since that row was written
      // — e.g. an operator correcting the number, or a number recovered
      // from a merged sibling contact. Re-resolve from the current row and
      // retry once.
      //
      // Restricted to recipient rejections: retrying a template, permission
      // or provider failure against a different address would double-send
      // the same reply.
      if (isRecipientRejection(err)) {
        try {
          const requeued = await retryAiReplyWithFreshRecipient({
            accountId,
            conversationId,
            contactId,
            userId: configOwnerUserId,
            text: stripInternalReasoning(finalText),
            composeMessageId: args.composeMessageId,
            single: realBooking?.confirmado === true || finalTextIsDeterministic,
            previousError: err,
          });
          if (requeued) {
            console.log(
              `[ai auto-reply] conversation ${conversationId}: reply delivered on retry after re-resolving the recipient`
            );
            return;
          }
        } catch (retryErr) {
          console.error(
            `[ai auto-reply] conversation ${conversationId}: retry after re-resolving the recipient also failed:`,
            retryErr instanceof Error ? retryErr.message : retryErr
          );
        }

      }
      throw err;
    });

    console.log('[AUTO-REPLY] Mensaje enviado con éxito a WhatsApp:', enviado);
    replyDispatched = true;

    // SISTEMA DE SEGUIMIENTOS: el bot acaba de responder — si el cliente
    // no replica en 10 minutos, un runner enviará un recordatorio natural.
    // Bandera explícita (igual que el auto-unblock) para que el operador
    // pueda apagar los recordatorios sin tocar el auto-reply.
    if (process.env.FOLLOW_UP_ENABLED !== 'false') {
      await scheduleFollowUp(db, {
        conversationId,
        contactId,
        accountId,
      }).catch((err) => {
        // Nunca deja caer el turno: un fallo al programar solo significa
        // "esta vuelta no habrá recordatorio".
        console.error(
          `[ai auto-reply] could not schedule the 10-minute follow-up for conversation ${conversationId}:`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  } catch (error) {
    // Global safety net around the ENTIRE reply block. Never throws, so the
    // webhook's 200 to Meta is unaffected — but a turn can no longer die
    // without a line naming the conversation and the full provider / Meta
    // error (message, stack, and AiError's code/status when present).
    console.error(
      '[AUTOREPLY ERROR CRÍTICO]',
      error,
      error instanceof Error
        ? {
            conversationId,
            contactId,
            accountId,
            message: error.message,
            stack: error.stack,
            ...(error as object),
          }
        : { conversationId, contactId, accountId }
    );

    // Under bypass, an outbound probe distinguishes "the AI provider is
    // broken" from "WhatsApp outbound is broken" — the two failure modes
    // that look identical from the customer's side.
    if (bypassEnabled()) {
      await sendOutboundProbe(args, 'dispatch threw');
      return;
    }

    // The turn blew up after every deliberate gate had already passed and
    // before anything reached WhatsApp. This is the exact shape of "the
    // customer is staring at a typing indicator that never resolves", so
    // the last resort is not another log line: send the neutral
    // acknowledgement. It asserts nothing that could be false (no cita, no
    // date, no link, no promise of a human), and it keeps the thread alive.
    // REGLA DE ORO: a throw reached here, so this was NOT a deliberate
    // stay-silent decision (those all return above). Put the neutral
    // acknowledgement on WhatsApp unless something already went out.
    if (!replyDispatched) {
      const sent = await sendTurnFallback(
        args,
        'dispatch threw after the original error was logged'
      );
      if (sent) replyDispatched = true;
    }
  }
}
