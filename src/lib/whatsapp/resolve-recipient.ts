"use client";

import { isDialablePhone } from "@/lib/whatsapp/phone-utils";

/**
 * Limpia y normaliza una dirección de destinatario removiendo valores inválidos.
 * Retorna null si el valor es "unknown", null, undefined o cadena vacía.
 */
function cleanInvalidRecipient(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "unknown" || trimmed === "" || trimmed === "null" || trimmed === "undefined") return null;
  return trimmed;
}

/**
 * Determina el tipo de destinatario y dirección a partir de los datos del contacto.
 *
 * Lógica de prioridad (misma en todo el sistema):
 * 1. Si hay wa_id y no es dialable (es un ID opaco numérico tipo 15 dígitos) → recipient_type: "phone", recipient_id: wa_id
 * 2. Si hay wa_user_id (BSUID) y no es dialable → recipient_type: "bsuid", recipient_id: wa_user_id
 * 3. Si phone es dialable → recipient_type: "phone", recipient_id: phone
 * 4. Si no hay nada → retornar null
 *
 * NOTA importante: `isDialablePhone` ya incluye la comprobación de que no tenga
 * prefijo BSUID (CO./WAID.), así que valores como "CO.123456789012345" serán
 * clasificados como false y caerán a la regla BSUID/phone.
 */
export function resolveWhatsAppRecipient(
  contact: {
    phone?: string | null;
    wa_id?: string | null;
    wa_user_id?: string | null;
    username?: string | null;
  }
): { recipient_id: string; recipient_type: "phone" | "bsuid" } | null {
  const cleanPhone = cleanInvalidRecipient(contact.phone);
  const cleanWaId = cleanInvalidRecipient(contact.wa_id);
  const cleanBsuid = cleanInvalidRecipient(contact.wa_user_id);

  // Regla 1: Si hay wa_id y NO es dialable (es un ID opaco/BSUID)
  if (cleanWaId && !isDialablePhone(cleanWaId)) {
    return {
      recipient_id: cleanWaId,
      recipient_type: "phone",
    };
  }

  // Regla 2: Si hay BSUID (wa_user_id) y NO es dialable
  if (cleanBsuid && !isDialablePhone(cleanBsuid)) {
    return {
      recipient_id: cleanBsuid,
      recipient_type: "bsuid",
    };
  }

  // Regla 3: Si phone es dialable
  if (cleanPhone && isDialablePhone(cleanPhone)) {
    return {
      recipient_id: cleanPhone,
      recipient_type: "phone",
    };
  }

  // No hay identificador válido
  return null;
}

/**
 * Obtiene el destinatario formateado para enviar a Meta Cloud API.
 *
 * @param contact - Datos del contacto de Supabase
 * @param conversationId - ID de la conversación (opcional)
 * @param inboundMessageId - ID del mensaje entrante (opcional, para anclar wa_id)
 * @returns Objeto con recipient_id y recipient_type, o null si no hay destinatario
 */
export function getMetaRecipient(
  contact: {
    phone?: string | null;
    wa_id?: string | null;
    wa_user_id?: string | null;
    username?: string | null;
    recipient_id?: string | null;
    identity_type?: string | null;
  },
  conversationId?: string,
  inboundMessageId?: string
): { recipient_id: string; recipient_type: "phone" | "bsuid" } | null {
  // Primero intentar usar recipient_id / identity_type si ya están guardados.
  // identity_type vale 'PHONE_E164' (→ phone) o 'BSUID' (→ bsuid).
  const storedRecipientId = cleanInvalidRecipient(contact.recipient_id);
  if (storedRecipientId && contact.identity_type) {
    if (contact.identity_type === "PHONE_E164" && isDialablePhone(storedRecipientId)) {
      return {
        recipient_id: storedRecipientId,
        recipient_type: "phone",
      };
    }
    if (contact.identity_type === "BSUID") {
      return {
        recipient_id: storedRecipientId,
        recipient_type: "bsuid",
      };
    }
  }

  // Si no hay valores guardados, calcular desde los campos individuales
  const calculated = resolveWhatsAppRecipient({
    phone: contact.phone,
    wa_id: contact.wa_id,
    wa_user_id: contact.wa_user_id,
    username: contact.username,
  })

  if (!calculated) return null

  return calculated
}

/**
 * Verifica si un destinatario es válido para enviar a Meta.
 * Retorna un error estructurado si no hay destinatario.
 */
export function validateRecipient(
  contact: {
    phone?: string | null;
    wa_id?: string | null;
    wa_user_id?: string | null;
    username?: string | null;
    recipient_id?: string | null;
    identity_type?: string | null;
  }
): { valid: true; recipient_id: string; recipient_type: "phone" | "bsuid" } | { valid: false; reason: "MISSING" | "UNSUPPORTED"; details?: string } {
  const resolved = resolveWhatsAppRecipient({
    phone: contact.phone,
    wa_id: contact.wa_id,
    wa_user_id: contact.wa_user_id,
    username: contact.username,
  })

  if (!resolved) {
    return {
      valid: false,
      reason: "MISSING",
      details: "No hay identificador válido (wa_id, wa_user_id o phone) para este contacto",
    }
  }

  return {
    valid: true,
    recipient_id: resolved.recipient_id,
    recipient_type: resolved.recipient_type,
  }
}

/**
 * Formatea el destinatario para el payload de Meta Cloud API.
 *
 * @param recipientId - El ID (wa_id o BSUID) a enviar
 * @param recipientType - 'phone' usa campo 'to', 'bsuid' usa campo 'recipient'
 * @param phoneNumberId - ID del número de teléfono de Meta (necesario para 'to')
 * @returns Objeto con el campo de destinatario formateado
 */
export function formatMetaRecipient(
  recipientId: string,
  recipientType: "phone" | "bsuid",
  phoneNumberId?: string
): { to?: string; recipient?: string } {
  if (recipientType === "phone") {
    // Para phone: el campo 'to' espera el número completo
    return { to: recipientId }
  } else {
    // Para bsuid: Meta Cloud API usa el campo 'recipient' (no 'to')
    return { recipient: recipientId }
  }
}