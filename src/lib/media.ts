import type { PayloadMedia } from "./cola";
import { entorno } from "./config";
import { log } from "./whatsapp";
import { prisma } from "./prisma";

const MEDIA_TIPO = {
  imagen: "imagen",
  nota_de_voz: "audio",
  audio: "audio",
  video: "video",
  documento: "documento",
} as const;

interface DetalleMedia {
  url: string;
  mime: string;
}

// Primer paso: GET al endpoint de media que devuelve la URL temporal.
// Segundo paso: GET a esa URL con el MISMO token (detalle que traba a todos)
// y con User-Agent.
export async function descargarMedia(mediaId: string): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    const metadatos = await fetch(
      `https://graph.facebook.com/${"v21.0"}/${mediaId}`,
      { headers: { Authorization: `Bearer ${entorno.waToken}` } }
    );
    if (!metadatos.ok) {
      log("media", `metadatos de ${mediaId} fallaron: ${metadatos.status}`);
      return null;
    }
    const detalle = (await metadatos.json()) as DetalleMedia;
    const archivo = await fetch(detalle.url, {
      headers: {
        Authorization: `Bearer ${entorno.waToken}`,
        "User-Agent": "agente-citas-whatsapp/1.0",
      },
    });
    if (!archivo.ok) {
      log("media", `descarga de ${mediaId} falló: ${archivo.status}`);
      return null;
    }
    const bytes = Buffer.from(await archivo.arrayBuffer());
    return { bytes, mime: detalle.mime };
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    log("media", `descarga de ${mediaId} rompió: ${mensaje}`);
    return null;
  }
}

function formatoAudio(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp3")) return "mp3";
  if (mime.includes("m4a")) return "m4a";
  if (mime.includes("wav")) return "wav";
  return "mpeg";
}

interface RespuestaOpenRouter {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

async function entenderConMedia(contenido: unknown, prompt: string): Promise<string | null> {
  const respuesta = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${entorno.openrouterApiKey}`,
      "HTTP-Referer": "https://panel.agente.citas",
      "X-Title": "agente-citas-whatsapp",
    },
    body: JSON.stringify({
      model: entorno.modeloMedia,
      max_tokens: 500,
      temperature: 0.2,
      messages: [
        { role: "system", content: "Eres un asistente que entiende audios e imágenes." },
        { role: "user", content: [{ type: "text", text: prompt }, ...(Array.isArray(contenido) ? contenido : [contenido]) as unknown[]] },
      ],
    }),
  });

  if (!respuesta.ok) {
    const texto = await respuesta.text();
    log("media", `OpenRouter media respondió ${respuesta.status}: ${texto}`);
    return null;
  }

  const datos = (await respuesta.json()) as RespuestaOpenRouter;
  if (datos.error?.message) {
    log("media", `error de OpenRouter media: ${datos.error.message}`);
    return null;
  }
  if (datos.usage) {
    log(
      "media",
      `uso del modelo media: ${datos.usage.prompt_tokens} entrada + ${datos.usage.completion_tokens} salida`
    );
  }
  return datos.choices?.[0]?.message?.content?.trim() || null;
}

export interface ResultadoMedia {
  messageId: number;
  contactoId: number;
  texto: string;
}

// Descarga el archivo, lo convierte a texto (transcripción o descripción) y
// actualiza el mensaje. Si falla, devuelve null y el agente responde normal
// pidiendo que se lo escriban: nunca se cae la conversación por un audio.
export async function entenderMedia(datos: PayloadMedia): Promise<ResultadoMedia | null> {
  const mensaje = await prisma.mensaje.findUnique({
    where: { id: datos.messageId },
    include: { contacto: true },
  });
  if (!mensaje) return null;

  const archivado = await descargarMedia(datos.mediaId);
  if (!archivado) return null;

  // Guarda los bytes por si luego quieres verlos.
  await prisma.media.upsert({
    where: { messageId: datos.messageId },
    create: {
      messageId: datos.messageId,
      tipo: datos.tipo,
      mime: archivado.mime,
      datos: new Uint8Array(archivado.bytes),
    },
    update: { mime: archivado.mime, datos: new Uint8Array(archivado.bytes) },
  });

  const b64 = archivado.bytes.toString("base64");
  let textoEntendido: string | null = null;

  if (datos.tipo === "nota_de_voz" || datos.tipo === "audio") {
    const format = formatoAudio(archivado.mime);
    const contenido = [
      {
        type: "input_audio" as const,
        input_audio: { data: b64, format },
      },
    ];
    textoEntendido = await entenderConMedia(
      contenido,
      "Transcribe la nota de voz en español, tal cual, sin comentarios ni interpretaciones. Devuelve soloc el texto hablado."
    );
    if (textoEntendido) {
      await prisma.mensaje.update({
        where: { id: datos.messageId },
        data: { texto: textoEntendido },
      });
      log("media", `nota de voz ${datos.messageId} transcrita`);
      return { messageId: datos.messageId, contactoId: datos.contactoId, texto: textoEntendido };
    }
  } else if (datos.tipo === "imagen" || datos.tipo === "video") {
    const contenido = [
      {
        type: "image_url" as const,
        image_url: { url: `data:${archivado.mime};base64,${b64}` },
      },
    ];
    const conCaption = datos.caption
      ? ` La imagen venía con este pie: "${datos.caption}".`
      : "";
    textoEntendido = await entenderConMedia(
      contenido,
      `Describe la imagen en una o dos frases, enfocándote en lo que sea útil para agendar una cita (un comprobante, la captura de un horario, una foto de referencia). Responde solo la descripción.${conCaption}`
    );
    if (textoEntendido) {
      // El agente debe saber que fue una foto y no texto escrito por la persona.
      const conPrefijo = `[imagen que envió] ${textoEntendido}`;
      await prisma.mensaje.update({
        where: { id: datos.messageId },
        data: { texto: conPrefijo },
      });
      log("media", `imagen ${datos.messageId} descrita`);
      return { messageId: datos.messageId, contactoId: datos.contactoId, texto: conPrefijo };
    }
  }

  // Si no se pudo entender, deja el marcador original y el agente preguntará.
  log("media", `no se pudo entender ${datos.tipo} ${datos.messageId}`);
  if (datos.caption) {
    await prisma.mensaje.update({
      where: { id: datos.messageId },
      data: { texto: datos.caption },
    });
  }
  return null;
}