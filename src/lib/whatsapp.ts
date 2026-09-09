import { createHmac, timingSafeEqual, randomUUID } from "crypto";
import { entorno, META_GRAPH_VERSION } from "./config";

export function log(ambito: string, mensaje: string): void {
  console.log(`[${new Date().toISOString()}] [${ambito}] ${mensaje}`);
}

// Valida x-hub-signature-256 con HMAC SHA256 sobre el cuerpo CRUDO.
export function firmaValida(cuerpoCrudo: string, firma: string | null): boolean {
  if (!firma) return false;
  const esperado = createHmac("sha256", entorno.waAppSecret).update(cuerpoCrudo).digest("hex");
  const proporcionado = firma.replace(/^sha256=/, "");
  if (proporcionado.length !== esperado.length) return false;
  return timingSafeEqual(Buffer.from(esperado, "hex"), Buffer.from(proporcionado, "hex"));
}

export interface MensajeWebhook {
  waMessageId: string;
  waId: string;
  timestamp?: string;
  tipo: string; // "texto" | "nota_de_voz" | "audio" | "imagen" | "video" | "documento" | "otro"
  texto: string; // cuerpo de texto, caption o marcador [imagen]/[nota de voz]
  caption?: string;
  mediaId?: string;
  mime?: string;
}

// Desmenuza un payload de Meta Cloud API en mensajes planos. Tolera la
// estructura anidada de entry[] -> changes[] -> value.messages[].
export function extraerMensajes(payload: unknown): MensajeWebhook[] {
  const salida: MensajeWebhook[] = [];
  const raiz = payload as {
    entry?: Array<{ changes?: Array<{ value?: { contacts?: unknown[]; messages?: unknown[] } }> }>;
  };
  for (const entry of raiz.entry ?? []) {
    for (const cambio of entry.changes ?? []) {
      const valor = cambio.value;
      if (!valor) continue;
      const waId = (valor.contacts?.[0] as { wa_id?: string } | undefined)?.wa_id;
      for (const m of (valor.messages ?? []) as unknown[]) {
        const mensaje = m as {
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          audio?: { id?: string; mime_type?: string; voice?: boolean };
          image?: { id?: string; mime_type?: string; caption?: string };
          video?: { id?: string; mime_type?: string; caption?: string };
          document?: { id?: string; mime_type?: string; caption?: string };
          sticker?: { id?: string; mime_type?: string };
        };
        if (!mensaje.id || !mensaje.from) continue;

        const base: MensajeWebhook = {
          waMessageId: mensaje.id,
          waId: waId ?? mensaje.from,
          timestamp: mensaje.timestamp,
          tipo: "otro",
          texto: "",
        };

        switch (mensaje.type) {
          case "text":
            base.tipo = "texto";
            base.texto = mensaje.text?.body ?? "";
            break;
          case "audio": {
            // Las notas de voz llegan como type "audio" con audio.voice=true,
            // no como un tipo "voice" aparte.
            base.tipo = mensaje.audio?.voice ? "nota_de_voz" : "audio";
            base.mediaId = mensaje.audio?.id;
            base.mime = mensaje.audio?.mime_type;
            base.texto = "[nota de voz]";
            break;
          }
          case "image":
            base.tipo = "imagen";
            base.mediaId = mensaje.image?.id;
            base.mime = mensaje.image?.mime_type;
            base.caption = mensaje.image?.caption;
            base.texto = mensaje.image?.caption ?? "[imagen]";
            break;
          case "video":
            base.tipo = "video";
            base.mediaId = mensaje.video?.id;
            base.mime = mensaje.video?.mime_type;
            base.caption = mensaje.video?.caption;
            base.texto = mensaje.video?.caption ?? "[video]";
            break;
          case "document":
            base.tipo = "documento";
            base.mediaId = mensaje.document?.id;
            base.mime = mensaje.document?.mime_type;
            base.caption = mensaje.document?.caption;
            base.texto = mensaje.document?.caption ?? "[documento]";
            break;
          case "sticker":
            base.tipo = "imagen";
            base.mediaId = mensaje.sticker?.id;
            base.mime = mensaje.sticker?.mime_type;
            base.texto = "[imagen]";
            break;
          default:
            base.tipo = "otro";
            base.texto = "";
        }

        salida.push(base);
      }
    }
  }
  return salida;
}

// Envía un mensaje de texto por la API de Cloud API de Meta.
export async function enviarTexto(waId: string, texto: string): Promise<boolean> {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${entorno.waPhoneNumberId}/messages`;
  const respuesta = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${entorno.waToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: waId,
      type: "text",
      text: { body: texto, preview_url: false },
    }),
  });
  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    log("whatsapp", `fallo al enviar a ${waId}: ${respuesta.status} ${detalle}`);
    return false;
  }
  return true;
}

export function waMessageIdSaliente(): string {
  return `sal-${Date.now()}-${randomUUID()}`;
}