/**
 * Copy shared between the server (which parks the reply and logs the
 * reason) and the Inbox banner that tells the operator what is happening.
 *
 * Lives in its own module — not in `pending-reply.ts` — because that file
 * reaches `recipient-resolver`, which imports the service-role admin
 * client. A client component importing the constant must not drag
 * server-only credentials into the browser bundle, so the string is
 * duplicated by re-export rather than imported from there.
 *
 * Kept as one literal (not translated) because it is the exact wording the
 * operator sees and the wording the product specifies.
 */
export const AWAITING_PHONE_NOTICE =
  'Esperando número de teléfono válido para enviar respuesta';