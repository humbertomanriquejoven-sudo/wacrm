"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { enviarTexto, log, waMessageIdSaliente } from "@/lib/whatsapp";
import { VENTANA_HORAS } from "@/lib/config";

export async function toggleBot(waId: string): Promise<void> {
  const contacto = await prisma.contacto.findUnique({ where: { waId } });
  if (!contacto) return;
  await prisma.contacto.update({
    where: { waId },
    data: { botActivo: !contacto.botActivo },
  });
  log("acciones", `bot ${contacto.botActivo ? "pausado" : "activado"} para ${waId}`);
}

export async function enviarMensaje(waId: string, texto: string): Promise<void> {
  const contacto = await prisma.contacto.findUnique({ where: { waId } });
  if (!contacto) throw new Error("Conversación no encontrada.");

  const ventanaValida =
    contacto.ventanaExpira && contacto.ventanaExpira.getTime() > Date.now();
  if (!ventanaValida) {
    throw new Error(
      "La ventana de 24 h ha expirado. Espera a que el cliente escriba."
    );
  }

  await enviarTexto(waId, texto);
  await prisma.mensaje.create({
    data: {
      contactoId: contacto.id,
      waMessageId: waMessageIdSaliente(),
      tipo: "texto",
      direccion: "saliente",
      texto,
    },
  });
  log("acciones", `mensaje manual enviado a ${waId}`);
}

export async function borrarConversacion(waId: string): Promise<never> {
  const contacto = await prisma.contacto.findUnique({
    where: { waId },
    include: {
      mensajes: { select: { id: true } },
      citas: { select: { id: true, googleEventId: true, cancelada: true, fin: true } },
    },
  });
  if (!contacto) redirect("/conversaciones");

  const { borrarEvento } = await import("@/lib/calendario");

  // Borrar eventos de Google solo de citas activas (no canceladas).
  const citasActivas = contacto.citas.filter((c) => !c.cancelada);
  for (const cita of citasActivas) {
    await borrarEvento(cita.googleEventId).catch((err) => {
      log("acciones", `error borrando evento ${cita.googleEventId}: ${err}`);
    });
  }

  const idsMensajes = contacto.mensajes.map((m) => m.id);
  const claveContacto = String(contacto.id);

  // Borrar jobs que correspondan a esta conversación.
  await prisma.job.deleteMany({
    where: {
      OR: [
        { clave: claveContacto },
        { clave: { in: idsMensajes.map(String) } },
      ],
    },
  });

  // Borrar en cascada: mensajes, citas y contacto.
  await prisma.mensaje.deleteMany({ where: { contactoId: contacto.id } });
  await prisma.cita.deleteMany({ where: { contactoId: contacto.id } });
  await prisma.contacto.delete({ where: { id: contacto.id } });

  log("acciones", `conversación ${waId} borrada`);
  redirect("/conversaciones");
}