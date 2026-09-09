import { prisma } from "@/lib/prisma";
import { Conversaciones } from "./lista";

export const dynamic = "force-dynamic";

function normalizar(filtro: string | undefined): "todas" | "ventana" | "cita" {
  if (filtro === "ventana") return "ventana";
  if (filtro === "cita") return "cita";
  return "todas";
}

export default async function ConversacionesPage({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: string; seleccion?: string; busqueda?: string }>;
}) {
  const params = await searchParams;
  const filtro = normalizar(params.filtro);
  const busqueda = (params.busqueda ?? "").trim().toLowerCase();
  const seleccionId = params.seleccion ? Number(params.seleccion) : null;

  const ahora = new Date();

  const contactos = await prisma.contacto.findMany({
    include: {
      mensajes: {
        orderBy: { creadoEn: "desc" },
        take: 1,
      },
      citas: {
        where: { cancelada: false },
        select: { id: true },
      },
    },
  });

  // Ordenar por último mensaje (el más reciente primero).
  let lista = contactos
    .map((c) => ({
      ...c,
      ultimoMensaje: c.mensajes[0] ?? null,
      tieneCita: c.citas.length > 0,
    }))
    .sort((a, b) => {
      const fa = a.ultimoMensaje?.creadoEn?.getTime?.() ?? 0;
      const fb = b.ultimoMensaje?.creadoEn?.getTime?.() ?? 0;
      return fb - fa;
    });

  // Filtros.
  if (filtro === "ventana") {
    lista = lista.filter(
      (c) => c.ventanaExpira && c.ventanaExpira.getTime() > ahora.getTime()
    );
  }
  if (filtro === "cita") {
    lista = lista.filter((c) => c.tieneCita);
  }
  if (busqueda) {
    lista = lista.filter(
      (c) =>
        (c.nombre ?? "").toLowerCase().includes(busqueda) ||
        c.waId.includes(busqueda)
    );
  }

  // Conversación seleccionada.
  let seleccion = null;
  if (seleccionId) {
    const [contacto, mensajes] = await Promise.all([
      prisma.contacto.findUnique({
        where: { id: seleccionId },
        include: {
          citas: {
            where: { cancelada: false, fin: { gte: ahora } },
            orderBy: { inicio: "asc" },
          },
        },
      }),
      prisma.mensaje.findMany({
        where: { contactoId: seleccionId },
        orderBy: { creadoEn: "asc" },
      }),
    ]);
    if (contacto) {
      seleccion = { contacto, mensajes };
    }
  }

  return (
    <Conversaciones
      contactos={lista.map((c) => ({
        id: c.id,
        waId: c.waId,
        nombre: c.nombre,
        botActivo: c.botActivo,
        ventanaExpira: c.ventanaExpira?.toISOString?.() ?? null,
        tieneCita: c.tieneCita,
        ultimoMensaje: c.ultimoMensaje
          ? {
              texto: c.ultimoMensaje.texto,
              tipo: c.ultimoMensaje.tipo,
              direccion: c.ultimoMensaje.direccion,
              creadoEn: c.ultimoMensaje.creadoEn.toISOString(),
            }
          : null,
      }))}
      seleccion={
        seleccion
          ? {
              contacto: {
                id: seleccion.contacto.id,
                waId: seleccion.contacto.waId,
                nombre: seleccion.contacto.nombre,
                botActivo: seleccion.contacto.botActivo,
                ventanaExpira: seleccion.contacto.ventanaExpira?.toISOString?.() ?? null,
              },
              mensajes: seleccion.mensajes.map((m) => ({
                id: m.id,
                texto: m.texto,
                tipo: m.tipo,
                direccion: m.direccion,
                creadoEn: m.creadoEn.toISOString(),
              })),
              citas: seleccion.contacto.citas.map((c) => ({
                id: c.id,
                inicio: c.inicio.toISOString(),
                fin: c.fin.toISOString(),
              })),
            }
          : null
      }
      filtro={filtro}
      busqueda={params.busqueda ?? ""}
      ahora={ahora.toISOString()}
    />
  );
}