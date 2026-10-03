/**
 * Client-side helper for recording a contact's real phone number.
 *
 * Deliberately NOT a direct Supabase write like the other contact editors.
 * Writing the phone straight from the browser would update the row but
 * never attempt the reply that is parked waiting for it — the customer
 * would still see silence after the operator did the right thing. The
 * server route saves the number, folds in any orphan contact and delivers
 * the deferred reply in one request, so every editor has to go through it.
 */
export interface ContactPhoneUpdateResult {
  phone: string;
  changed: boolean;
  merged?: boolean;
  pending_replies_sent?: number;
  pending_replies_failed?: number;
  pending_conversations?: string[];
}

export async function updateContactPhone(
  contactId: string,
  phone: string
): Promise<ContactPhoneUpdateResult> {
  const response = await fetch(`/api/contacts/${contactId}/phone`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });

  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & Partial<ContactPhoneUpdateResult>;

  if (!response.ok) {
    throw new Error(body.error ?? 'Failed to update the phone number');
  }

  return body as ContactPhoneUpdateResult;
}