// ============================================================
// Human-readable stand-ins for inbound content the LLM cannot see.
//
// An image has no words, a voice note has no text until STT runs, and a shared
// contact card is not prose at all. Left empty, those rows were skipped by the
// auto-reply gate and the customer got silence. Left as `[Unsupported message
// type: contacts]` (the old `default` branch), the model was told the truth in
// a form it could not act on.
//
// Every type gets a sentence in the customer's language that (a) names what
// arrived, so the agent can acknowledge it naturally, and (b) tells the agent
// it does not know the CONTENT, so it must ask rather than invent. That second
// half matters: without it a model handed "[El usuario envió una foto]" tends to
// guess what is in the photo.
//
// Generic by construction - keyed off `content_type`, never off a particular
// contact, id or number.
// ============================================================

/**
 * What the agent is told, per content type, when there is no usable text.
 *
 * `document` deliberately defers to the filename carried in `content_text`
 * when there is one; these are the sentences for when there is not.
 */
const PLACEHOLDERS: Record<string, string> = {
  text: '[El usuario envió un mensaje de texto]',
  image: '[El usuario envió una foto]',
  video: '[El usuario envió un video]',
  audio: '[El usuario envió un mensaje de voz]',
  document: '[El usuario envió un documento]',
  location: '[El usuario compartió su ubicación]',
  template: '[El usuario interactuó con una plantilla]',
  interactive: '[El usuario seleccionó una opción]',
  contacts: '[El usuario compartió un contacto]',
  poll: '[El usuario respondió una encuesta]',
  sticker: '[El usuario envió un sticker]',
  reaction: '[El usuario reaccionó a un mensaje]',
};

/** Types the webhook folds into a stored type before persistence. */
const TYPE_ALIASES: Record<string, string> = {
  sticker: 'image',
  animation: 'image',
  voice: 'audio',
  button: 'interactive',
  interactive_reply: 'interactive',
  poll: 'interactive',
  poll_response: 'interactive',
  order: 'interactive',
  // `messages.content_type` is constrained by a CHECK that does not include
  // `contacts` or `reaction`, so neither may be stored. The extracted name and
  // phone live in `content_text` (and the full envelope in
  // `raw_meta_payload`), which is what the agent actually reads; the stored
  // type is a label, not the payload.
  contacts: 'text',
  reaction: 'text',
  unknown: 'text',
  unsupported: 'text',
};

/** Every `content_type` the agent should be able to read back. */
export const AI_CONTEXT_CONTENT_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'location',
  'template',
  'interactive',
  'contacts',
] as const;

/**
 * Fold a raw WhatsApp envelope type into the stored `content_type`.
 *
 * WhatsApp ships more types than the `messages.content_type` CHECK allows, and
 * more over time. Anything unmapped becomes `text` rather than being dropped,
 * so an unknown type is still a message somebody can answer.
 */
export function normalizeContentType(raw: string | undefined | null): string {
  const key = (raw ?? '').trim();
  if (!key) return 'text';
  return TYPE_ALIASES[key] ?? (PLACEHOLDERS[key] ? key : 'text');
}

/**
 * The sentence shown to the agent for one inbound message.
 *
 * Prefers whatever real content the pipeline managed to extract - a caption, a
 * transcription, a list_reply title, a document filename, a formatted location
 * - and only falls back to a placeholder when there is nothing. So a captioned
 * photo reaches the model as its caption rather than as "a photo".
 */
export function describeInboundContent(input: {
  contentType: string;
  contentText?: string | null;
}): string {
  const text = input.contentText?.trim();
  if (text) return text;
  return PLACEHOLDERS[input.contentType] ?? PLACEHOLDERS.text;
}

/**
 * True when the agent cannot know what this message actually said.
 *
 * Used by the prompt builder to keep the model from inventing content, and by
 * the webhook to decide whether a reply is still owed. A captioned image is
 * known; a bare sticker is not.
 */
export function isOpaqueToModel(input: {
  contentType: string;
  contentText?: string | null;
}): boolean {
  if (input.contentText?.trim()) return false;
  return (PLACEHOLDERS[input.contentType] ?? PLACEHOLDERS.text).includes(
    '[El usuario'
  );
}
