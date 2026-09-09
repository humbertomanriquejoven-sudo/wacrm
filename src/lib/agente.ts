import { prisma } from "./prisma";
import {
  ANTICIPACION_MINIMA_MIN,
  aRFC3339Local,
  desdeLocal,
  diaDeAtencion,
  DURACION_CITA_MIN,
  entorno,
  fechaHoraLegible,
  horaLegible,
  partesLocales,
  fechaLegible,
} from "./config";
import {
  bloquesOcupados,
  borrarEvento,
  crearEvento,
  moverEvento,
  obtenerEvento,
} from "./calendario";
import { enviarTexto, log, waMessageIdSaliente } from "./whatsapp";
import type { PayloadResponder } from "./cola";

// Mensajes en el formato de OpenAI/OpenRouter.
type MensajeChat =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCallAO[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCallAO {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface RespuestaOpenRouter {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: ToolCallAO[];
    };
  }>;
  error?: { message?: string };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const HERRAMIENTAS = [
  {
    type: "function",
    function: {
      name: "ver_disponibilidad",
      description:
        "Consulta los huecos libres del calendario entre dos fechas (formato AAAA-MM-DD, en hora local). Devuelve hasta 6 horarios disponibles dentro del horario de atención. Solo se pueden ofrecer horarios que salgan de esta herramienta.",
      parameters: {
        type: "object",
        properties: {
          desde: { type: "string", description: "Fecha inicial, formato AAAA-MM-DD" },
          hasta: {
            type: "string",
            description: "Fecha final, formato AAAA-MM-DD (máximo 30 días después de hoy)",
          },
        },
        required: ["desde", "hasta"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agendar_cita",
      description:
        "Crea una cita de 60 minutos en el calendario. El inicio va en formato AAAA-MM-DDTHH:MM en hora local (por ejemplo 2026-08-20T16:00). Verifica de nuevo la disponibilidad antes de crear.",
      parameters: {
        type: "object",
        properties: {
          inicio: { type: "string", description: "Inicio de la cita, formato AAAA-MM-DDTHH:MM en hora local" },
          nombre: { type: "string", description: "Nombre del cliente" },
          motivo: { type: "string", description: "Motivo de la cita (lo que pide el cliente, o vacío si no dice)" },
        },
        required: ["inicio", "nombre"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reagendar_cita",
      description:
        "Mueve una cita existente a un nuevo horario. Mueve el MISMO evento, no crea uno nuevo. El id_cita se indica en el mensaje del sistema. Verifica la disponibilidad del nuevo horario antes de mover.",
      parameters: {
        type: "object",
        properties: {
          id_cita: { type: "number", description: "Id de la cita a mover (los tienes en el mensaje del sistema)" },
          nuevo_inicio: { type: "string", description: "Nuevo inicio, formato AAAA-MM-DDTHH:MM en hora local" },
        },
        required: ["id_cita", "nuevo_inicio"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancelar_cita",
      description:
        "Cancela una cita existente: borra el evento del calendario y la marca como cancelada. Necesitas el id_cita, que se indica en el mensaje del sistema.",
      parameters: {
        type: "object",
        properties: {
          id_cita: { type: "number", description: "Id de la cita a cancelar" },
        },
        required: ["id_cita"],
      },
    },
  },
];

function parsearInicioLocal(valor: string): Date {
  // Acepta "AAAA-MM-DDTHH:MM" o "AAAA-MM-DD HH:MM" en hora local.
  const limpio = valor.trim().replace(" ", "T");
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(limpio);
  if (!m) throw new Error(`Fecha inválida: ${valor}`);
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  const hora = Number(m[4]);
  const minuto = Number(m[5]);
  return desdeLocal(anio, mes, dia, hora, minuto);
}

// Huecos libres de 60 minutos, dentro del horario de atención y con al menos
// 2 horas de anticipación. Devuelve hasta `max` inicios.
async function huecosLibres(
  desde: Date,
  hasta: Date,
  ignorarRango?: { inicio: Date; fin: Date },
  max = 6
): Promise<{ inicio: Date; fin: Date }[]> {
  const ocupados = (await bloquesOcupados(desde, hasta)).filter((b) =>
    ignorarRango
      ? !(
          b.inicio.getTime() >= ignorarRango.inicio.getTime() - 60_000 &&
          b.fin.getTime() <= ignorarRango.fin.getTime() + 60_000
        )
      : true
  );

  const pDesde = partesLocales(desde);
  const pHasta = partesLocales(hasta);
  const primerDia = desdeLocal(pDesde.anio, pDesde.mes, pDesde.dia, 0, 0);
  const ultimoDia = desdeLocal(pHasta.anio, pHasta.mes, pHasta.dia, 23, 59);
  const ahora = new Date();
  const minimo = new Date(ahora.getTime() + ANTICIPACION_MINIMA_MIN * 60_000);

  const salida: { inicio: Date; fin: Date }[] = [];
  for (
    let dia = primerDia;
    dia.getTime() <= ultimoDia.getTime();
    dia = new Date(dia.getTime() + 24 * 3600_000)
  ) {
    const atencion = diaDeAtencion(dia);
    if (!atencion) continue;
    const p = partesLocales(dia);
    for (
      let minuto = atencion.apertura * 60;
      minuto + DURACION_CITA_MIN <= atencion.cierre * 60;
      minuto += 30
    ) {
      const inicio = desdeLocal(p.anio, p.mes, p.dia, Math.floor(minuto / 60), minuto % 60);
      if (inicio.getTime() < minimo.getTime()) continue;
      const fin = new Date(inicio.getTime() + DURACION_CITA_MIN * 60_000);
      const choca = ocupados.some(
        (b) => b.inicio.getTime() < fin.getTime() && b.fin.getTime() > inicio.getTime()
      );
      if (choca) continue;
      salida.push({ inicio, fin });
      if (salida.length >= max) return salida;
    }
  }
  return salida;
}

function formatearOpciones(huecos: { inicio: Date }[]): string {
  if (huecos.length === 0) return "No hay horarios disponibles en ese rango.";
  return huecos
    .map((h) => `${fechaLegible(h.inicio)} a las ${horaLegible(h.inicio)}`)
    .join("\n");
}

function textoErrorOcupado(disponibles: { inicio: Date }[]): string {
  return `ESE HORARIO YA NO ESTÁ DISPONIBLE. No lo ofrezcas. Estos sí están libres:\n${formatearOpciones(disponibles)}`;
}

async function ejecutarHerramienta(
  nombre: string,
  argumentos: Record<string, unknown>,
  contactoId: number
): Promise<string> {
  try {
    switch (nombre) {
      case "ver_disponibilidad": {
        const desde = parsearInicioLocal(`${String(argumentos.desde)}T00:00`);
        const hasta = parsearInicioLocal(`${String(argumentos.hasta)}T23:59`);
        const huecos = await huecosLibres(desde, hasta);
        log(
          "agente",
          `ver_disponibilidad ${String(argumentos.desde)}..${String(argumentos.hasta)}: ${huecos.length} huecos`
        );
        return formatearOpciones(huecos);
      }

      case "agendar_cita": {
        const inicio = parsearInicioLocal(String(argumentos.inicio));
        const nombre = String(argumentos.nombre ?? "").trim();
        const motivo = String(argumentos.motivo ?? "").trim();
        const fin = new Date(inicio.getTime() + DURACION_CITA_MIN * 60_000);

        // Validación sin guardar estado: se vuelve a consultar el calendario.
        const huecos = await huecosLibres(inicio, fin);
        const libre = huecos.some(
          (h) =>
            Math.abs(h.inicio.getTime() - inicio.getTime()) < 60_000 &&
            h.fin.getTime() === fin.getTime()
        );
        if (!libre) {
          const alternativos = await huecosLibres(
            inicio,
            new Date(inicio.getTime() + 14 * 24 * 3600_000),
            undefined,
            3
          );
          return textoErrorOcupado(alternativos);
        }

        const idEvento = await crearEvento(
          inicio,
          fin,
          nombre ? `Cita con ${nombre}` : "Cita por WhatsApp",
          motivo
        );
        const cita = await prisma.cita.create({
          data: {
            contactoId,
            googleEventId: idEvento,
            inicio,
            fin,
            cancelada: false,
            notas: motivo,
          },
        });
        log(
          "agente",
          `cita ${cita.id} creada (evento ${idEvento}) a las ${aRFC3339Local(inicio)}`
        );
        return `Cita agendada correctamente: ${fechaLegible(inicio)} a las ${horaLegible(inicio)} (id ${cita.id}). Confirmasela al cliente.`;
      }

      case "reagendar_cita": {
        const idCita = Number(argumentos.id_cita);
        const nuevoInicio = parsearInicioLocal(String(argumentos.nuevo_inicio));
        const nuevoFin = new Date(nuevoInicio.getTime() + DURACION_CITA_MIN * 60_000);

        const cita = await prisma.cita.findUnique({ where: { id: idCita } });
        if (!cita || cita.cancelada) {
          return `No existe la cita vigente con id ${idCita}. Pide al cliente que repita su nombre o el motivo.`;
        }
        const evento = await obtenerEvento(cita.googleEventId);

        // freeBusy devuelve el propio evento como ocupado: se ignora su bloque
        // actual para poder validar el cambio.
        const huecos = await huecosLibres(nuevoInicio, nuevoFin, {
          inicio: evento.inicio,
          fin: evento.fin,
        });
        const libre = huecos.some(
          (h) =>
            Math.abs(h.inicio.getTime() - nuevoInicio.getTime()) < 60_000 &&
            h.fin.getTime() === nuevoFin.getTime()
        );
        if (!libre) {
          const alternativos = await huecosLibres(
            nuevoInicio,
            new Date(nuevoInicio.getTime() + 14 * 24 * 3600_000),
            { inicio: evento.inicio, fin: evento.fin },
            3
          );
          return textoErrorOcupado(alternativos);
        }

        await moverEvento(cita.googleEventId, nuevoInicio, nuevoFin);
        await prisma.cita.update({
          where: { id: idCita },
          data: { inicio: nuevoInicio, fin: nuevoFin },
        });
        log("agente", `cita ${idCita} movida a ${aRFC3339Local(nuevoInicio)}`);
        return `Cita movida correctamente a ${fechaLegible(nuevoInicio)} a las ${horaLegible(nuevoInicio)}. Confirmasela al cliente.`;
      }

      case "cancelar_cita": {
        const idCita = Number(argumentos.id_cita);
        const cita = await prisma.cita.findUnique({ where: { id: idCita } });
        if (!cita || cita.cancelada) {
          return `No existe una cita vigente con id ${idCita}.`;
        }
        await borrarEvento(cita.googleEventId);
        await prisma.cita.update({ where: { id: idCita }, data: { cancelada: true } });
        log("agente", `cita ${idCita} cancelada`);
        return `Cita cancelada correctamente. Confirmasela al cliente.`;
      }

      default:
        return `Herramienta desconocida: ${nombre}`;
    }
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    log("agente", `error ejecutando ${nombre}: ${mensaje}`);
    return `Ocurrió un error interno al usar ${nombre}: ${mensaje}. Pide disculpas y sugiere otra vía de contacto.`;
  }
}

async function llamarModelo(
  historial: MensajeChat[],
  sistema: string
): Promise<RespuestaOpenRouter> {
  const respuesta = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${entorno.openrouterApiKey}`,
      "HTTP-Referer": "https://panel.agente.citas",
      "X-Title": "agente-citas-whatsapp",
    },
    body: JSON.stringify({
      model: entorno.modelo,
      messages: [{ role: "system", content: sistema }, ...historial],
      tools: HERRAMIENTAS,
      tool_choice: "auto",
      usage: { include: true },
      stream: false,
    }),
  });
  if (!respuesta.ok) {
    const texto = await respuesta.text();
    throw new Error(`OpenRouter respondió ${respuesta.status}: ${texto}`);
  }
  return (await respuesta.json()) as RespuestaOpenRouter;
}

function construirSistema(
  contacto: { nombre?: string | null },
  citasVigentes: string
): string {
  const ahora = new Date();
  return `Eres la recepcionista de un negocio que agenda citas por WhatsApp. Respondes SIEMPRE en español neutro, sin emojis, breve y natural, como si fueras una persona.

Horario de atención: lunes a viernes de 9:00 a 18:00, sábados de 9:00 a 13:00, domingos cerrado. Las citas duran 60 minutos. Solo se puede agendar con al menos 2 horas de anticipación.

Fecha y hora de HOY (en hora local, sin segundos): ${fechaHoraLegible(ahora)}.

REGLAS IMPRESCINDIBLES:
1. JAMÁS inventes horarios disponibles. Solo puedes ofrecer horarios que hayan salido de ver_disponibilidad en esta misma conversación. Si el cliente pide un horario que no verificaste, llama a ver_disponibilidad antes de ofrecer nada.
2. Nunca repitas un horario que ya respondiste que no está disponible.
3. Si el cliente no da su nombre, pregúntaselo antes de agendar.
4. Usa las herramientas para agendar, mover o cancelar citas.
5. Para mover una cita usa reagendar_cita sobre la misma cita: se mueve, no se crea otra.
6. Ofrece máximo 3 horarios a la vez del resultado de ver_disponibilidad.

Citas vigentes de este contacto (usa el id para reagendar o cancelar):
${citasVigentes || "No tiene citas vigentes."}

El cliente ${contacto.nombre ? `se llama ${contacto.nombre}` : "aún no dio su nombre"}.`;
}

// Punto de entrada del worker para responder a un contacto.
export async function responder(payload: PayloadResponder): Promise<void> {
  const contacto = await prisma.contacto.findUnique({
    where: { id: payload.contactoId },
    include: { citas: true },
  });
  if (!contacto) return;

  // La comprobación del bot va AQUÍ, justo antes de llamar al modelo (no al
  // encolar). Si estuviera al encolar, pausar durante el debounce llegaría tarde.
  if (!contacto.botActivo) {
    log("agente", `bot en pausa para ${contacto.waId}, no se responde`);
    return;
  }

  const historial = await cargarHistorial(contacto.id);
  if (historial.length === 0) return;

  const citasVigentes = contacto.citas
    .filter((c) => !c.cancelada && c.fin.getTime() > Date.now())
    .map((c) => `- id ${c.id}: ${fechaLegible(c.inicio)} a las ${horaLegible(c.inicio)}`)
    .join("\n");

  const sistema = construirSistema(contacto, citasVigentes);
  const mensajes: MensajeChat[] = historial;
  let textoFinal: string | null = null;

  for (let vuelta = 1; vuelta <= 6; vuelta++) {
    const respuesta = await llamarModelo(mensajes, sistema);
    if (respuesta.error?.message) throw new Error(respuesta.error.message);
    if (respuesta.usage) {
      log(
        "agente",
        `uso vuelta ${vuelta}: ${respuesta.usage.prompt_tokens ?? 0} entrada + ${respuesta.usage.completion_tokens ?? 0} salida`
      );
    }
    const mensaje = respuesta.choices?.[0]?.message;
    const herramientas = mensaje?.tool_calls ?? [];

    if (herramientas.length > 0) {
      const crudo: MensajeChat = mensaje?.content
        ? { role: "assistant", content: mensaje.content, tool_calls: herramientas }
        : { role: "assistant", content: "", tool_calls: herramientas };
      mensajes.push(crudo);

      for (const herramienta of herramientas) {
        let argumentos: Record<string, unknown> = {};
        try {
          argumentos = JSON.parse(herramienta.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          argumentos = {};
        }
        const resultado = await ejecutarHerramienta(
          herramienta.function.name,
          argumentos,
          contacto.id
        );
        mensajes.push({
          role: "tool",
          tool_call_id: herramienta.id,
          content: resultado,
        });
        log("agente", `tool ${herramienta.function.name} -> ${resultado.slice(0, 100)}`);
      }
      // El bucle continúa: el modelo ya vio el resultado de las herramientas.
      continue;
    }

    textoFinal = mensaje?.content?.trim() || null;
    break;
  }

  if (!textoFinal) {
    textoFinal =
      "Perdón, no logro revisar mi agenda en este momento. En un rato te atiende una persona de nuestro equipo.";
  }

  await enviarTexto(contacto.waId, textoFinal);
  await prisma.mensaje.create({
    data: {
      contactoId: contacto.id,
      waMessageId: waMessageIdSaliente(),
      tipo: "texto",
      direccion: "saliente",
      texto: textoFinal,
    },
  });
  log("agente", `respondido a ${contacto.waId}: ${textoFinal.slice(0, 80)}`);
}

async function cargarHistorial(contactoId: number): Promise<MensajeChat[]> {
  const filas = await prisma.mensaje.findMany({
    where: { contactoId },
    orderBy: { creadoEn: "desc" },
    take: 12,
  });
  filas.reverse();
  return filas.map((m) => ({
    role: m.direccion === "saliente" ? ("assistant" as const) : ("user" as const),
    content: m.texto,
  }));
}