import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone, phonesMatch } from "@/lib/whatsapp/phone-utils";

/**
 * Contact de-duplication helpers, shared by the WhatsApp webhook, the
 * manual contact form, and CSV import so all paths agree on what
 * "same number" means (issue #212).
 *
 * The canonical key is `normalizePhone` (digits-only) — the same form
 * the DB stores in the generated `contacts.phone_normalized` column
 * and enforces unique per account. `phonesMatch` adds trunk-prefix
 * tolerance (last-8-digit match) for the softer "possible duplicate"
 * surfaces.
 */

/** Canonical de-dup key for a phone string (digits only). */
export function normalizeKey(phone: string): string {
  return normalizePhone(phone);
}

/** Minimal shape we need back from a contacts lookup. */
export interface ExistingContact {
  id: string;
  phone: string;
  name?: string | null;
  [key: string]: unknown;
}

/**
 * Find an existing contact in `accountId` whose phone matches `phone`,
 * or null.
 *
 * Two passes:
 *   1. Exact — `phone_normalized` is a STORED generated column (migration
 *      022) with a UNIQUE partial index on (account_id, phone_normalized),
 *      so the common case (the same digits already on file) resolves in a
 *      single indexed lookup. This is the hot path: every inbound from a
 *      known number runs it.
 *   2. Fuzzy — trunk-prefix tolerance (last-8-digit match, `phonesMatch`)
 *      for duplicates that differ only by country/trunk prefix, e.g.
 *      stored '37063949836' vs inbound '+370 063 949 836'. Reached only
 *      when no row holds the exact digits. Pre-filters in SQL by the
 *      last-8-digit suffix (a leading-wildcard LIKE that can't use a
 *      B-tree), then applies the strict `phonesMatch` in JS on the small
 *      candidate set.
 */
export async function findExistingContact(
  db: SupabaseClient,
  accountId: string,
  phone: string,
): Promise<ExistingContact | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const { data: exact, error: exactErr } = await db
    .from("contacts")
    .select("*")
    .eq("account_id", accountId)
    .eq("phone_normalized", normalized)
    .limit(1);

  if (
    !exactErr &&
    (exact as ExistingContact[] | null | undefined)?.find((c) =>
      phonesMatch(c.phone, phone)
    )
  ) {
    return (exact as ExistingContact[])[0];
  }

  const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;

  const { data, error } = await db
    .from("contacts")
    .select("*")
    .eq("account_id", accountId)
    .like("phone", `%${suffix}`);

  if (error || !data) return null;

  return (
    (data as ExistingContact[]).find((c) => phonesMatch(c.phone, phone)) ?? null
  );
}

/**
 * Find a contact in `accountId` with the given name but NO phone number
 * assigned yet (empty / null `phone`). The WhatsApp webhook uses this as
 * a fallback when an inbound message's number matches nothing, but the
 * sender's profile name matches a number-less contact row (e.g. one
 * created from the form or CSV without a phone). Matching on name alone
 * is too loose to use generally, so it is deliberately restricted to
 * rows that have no usable phone — the one case where only the name can
 * tie an inbound message to an existing customer.
 */
export async function findContactByNameWithoutPhone(
  db: SupabaseClient,
  accountId: string,
  name: string,
): Promise<ExistingContact | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const { data, error } = await db
    .from("contacts")
    .select("*")
    .eq("account_id", accountId)
    .eq("name", trimmed);

  if (error || !data) return null;

  return (
    (data as ExistingContact[]).find(
      (c) => !normalizePhone(c.phone ?? ""),
    ) ?? null
  );
}

/**
 * True when an existing contact is an *exact* normalized match for
 * `phone` (vs only a fuzzy trunk-variant match). The form hard-blocks
 * exact matches but only warns on fuzzy ones.
 */
export function isExactMatch(existing: ExistingContact, phone: string): boolean {
  return normalizeKey(existing.phone) === normalizeKey(phone);
}

/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505).
 * Used as the backstop when the DB unique index rejects a racing or
 * format-equal insert that slipped past the in-app check.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: string }).code === "23505";
}

/**
 * De-duplicate parsed CSV rows by normalized phone, keeping the first
 * occurrence of each. Rows with an empty normalized phone are dropped
 * (they can't be a valid contact). Returns the unique rows plus the
 * count removed as in-file duplicates.
 */
export function dedupeByPhone<T extends { phone: string }>(
  rows: T[],
): { unique: T[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;

  for (const row of rows) {
    const key = normalizeKey(row.phone);
    if (!key) {
      duplicates++;
      continue;
    }
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(row);
  }

  return { unique, duplicates };
}
