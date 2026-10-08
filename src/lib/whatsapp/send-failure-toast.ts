/**
 * Build the message a send-failure toast should show from the server payload.
 *
 * The `/api/whatsapp/send` failure shape carries `error` (the flattened
 * "Error de entrega de mensaje") plus `how_to_fix` (the CÓMO SOLUCIONARLO
 * guide) when the destination cascade could not deliver. Both are shown so
 * the agent sees what to do — not just that it failed. Falls back to
 * `fallback` for responses with no `error` (or network failures).
 */
export function sendFailureToastMessage(
  payload: unknown,
  fallback: string,
): string {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    const error = typeof p.error === 'string' ? p.error : '';
    const howToFix = typeof p.how_to_fix === 'string' ? p.how_to_fix : '';
    if (error) {
      return howToFix
        ? `Error de envío: ${error}\n\n${howToFix}`
        : `Error de envío: ${error}`;
    }
  }
  return fallback;
}