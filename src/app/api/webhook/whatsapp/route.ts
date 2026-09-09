import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encolar, TIPO } from "@/lib/cola";
import { extraerMensajes, firmaValida, log } from "@/lib/whatsapp";
import { ahora, DEBOUNCE_SEG, VENTANA_HORAS } from "@/lib/config";
import type { PayloadMedia, PayloadResponder } from "@/lib/cola";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET: verificación del webhook de Meta. El challenge va EN CRUDO, no envuelto
// en JSON: si lo envuelves, la verificación falla y Meta no te dice por qué.
export function GET(request: Request): NextResponse {
  const url = new URL(request.url);
  const modo = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (modo === "subscribe" && token === process.env.WA_VERIFY_TOKEN && challenge) {
    log("webhook", "verificación GET aceptada");
    return new NextResponse(challenge, { status: 200 });
  }
  log("webhook", "verificación GET rechazada");
  return new NextResponse("forbidden", { status: 403 });
}

interface ArchivoEnMensaje {
  tipo: string;
  mediaId: string;
  mime: string;
  caption?: string;
}

function archivoDelMensaje(
  mensaje: ReturnType<typeof extraerMensajes>[number]
): ArchivoEnMensaje | null {
  if (!mensaje.mediaId) return null;
  return {
    tipo: mensaje.tipo,
    mediaId: mensaje.mediaId,
    mime: mensaje.mime ?? "",
    caption: mensaje.caption,
  };
}

// POST: lee el cuerpo con await req.text() ANTES de parsearlo, porque el HMAC
// se calcula sobre el cuerpo crudo. El handler solo guarda, encola y devuelve
// 200; el modelo y el calendario se tocan en el worker.
export async function POST(request: Request): Promise<NextResponse> {
  const cuerpoCrudo = await request.text();
  const firma = request.headers.get("x-hub-signature-256");

  if (!firmaValida(cuerpoCrudo, firma)) {
    log("webhook", "firma inválida");
    return new NextResponse("firma inválida", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(cuerpoCrudo);
  } catch {
    return new NextResponse("json inválido", { status: 400 });
  }

  const mensajes = extraerMensajes(payload);
  if (mensajes.length === 0) {
    // Pings o notificaciones de estado: se confirman y ya.
    return new NextResponse("ok", { status: 200 });
  }

  // Un mensaje que falle no puede impedir el 200: si devolvemos 500, Meta
  // reintenta el lote entero.
  for (const mensaje of mensajes) {
    await procesarMensaje(mensaje).catch((err) => {
      const detalle = err instanceof Error ? err.message : String(err);
      log("webhook", `error procesando ${mensaje.waMessageId}: ${detalle}`);
    });
  }

  return new NextResponse("ok", { status: 200 });
}

async function procesarMensaje(
  mensaje: ReturnType<typeof extraerMensajes>[number]
): Promise<void> {
  const contactoEncontrado = await prisma.contacto.findUnique({
    where: { waId: mensaje.waId },
    select: { id: true },
  });
  const contacto = contactoEncontrado ?? (await prisma.contacto.create({ data: { waId: mensaje.waId } }));

  // Cada mensaje entrante renueva la ventana de 24 h.
  await prisma.contacto.update({
    where: { id: contacto.id },
    data: { ventanaExpira: new Date(Date.now() + VENTANA_HORAS * 3600_000) },
  });

  // Idempotencia: guarda el mensaje con waMessageId único; el duplicado se
  // descarta capturando el error P2002. No es "consulto y después inserto":
  // eso se rompe justo con dos entregas en paralelo.
  try {
    await prisma.mensaje.create({
      data: {
        contactoId: contacto.id,
        waMessageId: mensaje.waMessageId,
        tipo: mensaje.tipo,
        direccion: "entrante",
        texto: mensaje.texto,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      log("webhook", `duplicado descartado: ${mensaje.waMessageId}`);
      return;
    }
    throw err;
  }
  log("webhook", `nuevo mensaje ${mensaje.waMessageId} de ${mensaje.waId} (${mensaje.tipo})`);

  const archivo = archivoDelMensaje(mensaje);

  if (archivo) {
    // Trae archivo: primero se entiende, después se encola la respuesta.
    const fila = await prisma.mensaje.findUniqueOrThrow({
      where: { waMessageId: mensaje.waMessageId },
      select: { id: true },
    });
    const media: PayloadMedia = {
      messageId: fila.id,
      contactoId: contacto.id,
      mediaId: archivo.mediaId,
      mime: archivo.mime,
      tipo: archivo.tipo,
      caption: archivo.caption,
    };
    // Para ENTENDER_MEDIA la clave es el id del mensaje (distinto en cada
    // archivo). El contactoId va en el payload.
    await encolar(TIPO.ENTENDER_MEDIA, String(fila.id), ahora(), media);
    return;
  }

  // Texto puro: respuesta directa con el debounce de 8 segundos.
  const responder: PayloadResponder = { contactoId: contacto.id };
  await encolar(
    TIPO.RESPONDER,
    String(contacto.id),
    new Date(Date.now() + DEBOUNCE_SEG * 1000),
    responder
  );
}