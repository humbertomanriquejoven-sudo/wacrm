"use client";

import { isDialablePhone, toDialable } from "@/lib/whatsapp/phone-utils";

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
 * 1. Si hay wa_id y no es dialable (es un ID opaco numérico tipo 15 dígitos) → recipient_type: "phone", recipient_address: wa_id
 * 2. Si hay bsuid (wa_user_id) y no es dialable → recipient_type: "bsuid", recipient_address: bsuid
 * 3. Si phone es dialable → recipient_type: "phone", recipient_address: phone
 * 4. Si no hay nada → retornar null
 * 
 * NOTA importante: `isDialablePhone` ya incluye la comprobación de que no tenga prefijo BSUID (CO./WAID.),
 * así que valores como "CO.123456789012345" serán clasificados como false y caerán a la regla BSUID/phone.
 */
export function resolveWhatsAppRecipient(
  contact: {
    phone?: string | null;
    wa_id?: string | null;
    bsuid?: string | null;
    username?: string | null;
  }
): { recipient_address: string; recipient_type: "phone" | "bsuid" } | null {
  // Limpiar valores inválidos primero
  const cleanPhone = cleanInvalidRecipient(contact.phone);
  const cleanWaId = cleanInvalidRecipient(contact.wa_id);
  const cleanBsuid = cleanInvalidRecipient(contact.bsuid);

  // Regla 1: Si hay wa_id y NO es dialable (es un ID opaco/BSUID)
  // isDialablePhone devuelve false para valores con prefijo namespace (CO./WAID.)
  // y también false para números con formato BSUID (>13 dígitos después de normalize)
  if (cleanWaId && !isDialablePhone(cleanWaId)) {
    return {
      recipient_address: cleanWaId,
      recipient_type: "phone" as "phone",
    };
  }

  // Regla 2: Si hay bsuid y NO es dialable
  if (cleanBsuid && !isDialablePhone(cleanBsuid)) {
    return {
      recipient_address: cleanBsuid,
      recipient_type: "bsuid" as "bsuid",
    };
  }

  // Regla 3: Si phone es dialable
  if (cleanPhone && isDialablePhone(cleanPhone)) {
    return {
      recipient_address: cleanPhone,
      recipient_type: "phone" as "phone",
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
 * @returns Objeto con recipient_address y recipient_type, o null si no hay destinatario
 */
export function getMetaRecipient(
  contact: {
    phone?: string | null;
    wa_id?: string | null;
    bsuid?: string | null;
    username?: string | null;
    recipient_address?: string | null;
    recipient_type?: "phone" | "bsuid" | null;
  },
  conversationId?: string,
  inboundMessageId?: string
): { recipient_address: string; recipient_type: "phone" | "bsuid" } | null {
  // Primero intentar usar recipient_address/recipient_type si ya están guardados
  if (contact.recipient_address && contact.recipient_type) {
    const validated = cleanInvalidRecipient(contact.recipient_address)
    if (validated && contact.recipient_type === "phone" && isDialablePhone(validated)) {
      return {
        recipient_address: validated,
        recipient_type: "phone",
      };
    }
    if (validated && contact.recipient_type === "bsuid") {
      return {
        recipient_address: validated,
        recipient_type: "bsuid",
      };
    }
  }

  // Si no hay valores guardados, calcular desde los campos individuales
  const calculated = resolveWhatsAppRecipient({
    phone: contact.phone,
    wa_id: contact.wa_id,
    bsuid: contact.bsuid,
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
    bsuid?: string | null;
    username?: string | null;
    recipient_address?: string | null;
    recipient_type?: "phone" | "bsuid" | null;
  }
): { valid: true; recipient_address: string; recipient_type: "phone" | "bsuid" } | { valid: false; reason: "MISSING" | "UNSUPPORTED"; details?: string } {
  const resolved = resolveWhatsAppRecipient({
    phone: contact.phone,
    wa_id: contact.wa_id,
    bsuid: contact.bsuid,
    username: contact.username,
  })

  if (!resolved) {
    return {
      valid: false,
      reason: "MISSING",
      details: "No hay identificador válido (wa_id, bsuid o phone) para este contacto",
    }
  }

  return {
    valid: true,
    recipient_address: resolved.recipient_address,
    recipient_type: resolved.recipient_type,
  }
}

/**
 * Formatea el destinatario para el payload de Meta Cloud API.
 * 
 * @param recipientAddress - El ID (wa_id o bsuid) a enviar
 * @param recipientType - 'phone' usa campo 'to', 'bsuid' usa campo 'recipient'
 * @param phoneNumberId - ID del número de teléfono de Meta (necesario para 'to')
 * @returns Objeto con el campo de destinatario formateado
 */
export function formatMetaRecipient(
  recipientAddress: string,
  recipientType: "phone" | "bsuid",
  phoneNumberId?: string
): { to?: string; recipient?: string } {
  if (recipientType === "phone") {
    // Para phone: el campo 'to' espera el número completo
    return { to: recipientAddress }
  } else {
    // Para bsuid: Meta Cloud API usa el campo 'recipient' (no 'to')
    return { recipient: recipientAddress }
  }
}