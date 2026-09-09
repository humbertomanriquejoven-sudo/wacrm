import { Job } from "@prisma/client";
import { prisma } from "./prisma";
import { log } from "./whatsapp";
import { DEBOUNCE_SEG } from "./config";

export const ESTADO = {
  PENDIENTE: "PENDIENTE",
  CORRIENDO: "CORRIENDO",
  HECHO: "HECHO",
  FALLIDO: "FALLIDO",
} as const;

export const TIPO = {
  ENTENDER_MEDIA: "ENTENDER_MEDIA",
  RESPONDER: "RESPONDER",
} as const;

export interface PayloadMedia {
  messageId: number;
  contactoId: number;
  mediaId: string;
  mime: string;
  tipo: string; // nota_de_voz | imagen | video | ...
  caption?: string;
}

export interface PayloadResponder {
  contactoId: number;
  mensajeId?: number;
}

// Encola con dedupe: si ya existe un job PENDIENTE con ese tipo y esa clave,
// no crea otro, solo le empuja la fecha. Ese dedupe es el debounce.
// La clave NO lleva índice único: dos mensajes del mismo contacto deben poder
// encolarse uno después de que el otro ya terminó.
export async function encolar(
  tipo: string,
  clave: string,
  correrEn: Date,
  payload: unknown
): Promise<void> {
  const bytes = JSON.stringify(payload);
  const existente = await prisma.job.findFirst({
    where: { tipo, clave, estado: ESTADO.PENDIENTE },
    select: { id: true },
  });
  if (existente) {
    await prisma.job.update({
      where: { id: existente.id },
      data: { correrEn },
    });
    log("cola", `dedupe: se empuja la fecha del job ${existente.id} (${tipo}/${clave})`);
    return;
  }
  await prisma.job.create({
    data: { tipo, clave, correrEn, estado: ESTADO.PENDIENTE, payload: bytes },
  });
  log("cola", `encolado ${tipo}/${clave} para las ${correrEn.toISOString()}`);
}

// Rescata jobs que llevan más de 5 minutos en CORRIENDO: si el proceso murió
// a mitad, esa fila se queda colgada para siempre.
async function rescatarColgados(): Promise<void> {
  const corte = new Date(Date.now() - 5 * 60 * 1000);
  const res = await prisma.job.updateMany({
    where: { estado: ESTADO.CORRIENDO, actualizadoEn: { lt: corte } },
    data: { estado: ESTADO.PENDIENTE },
  });
  if (res.count > 0) log("cola", `rescatados ${res.count} jobs colgados`);
}

// Marca como CORRIENDO hasta `max` jobs pendientes, de forma que dos vueltas
// del worker no agarren el mismo. El updateMany condicionado a PENDIENTE
// garantiza que si otro se lo llevó primero, el count vuelve en 0.
export async function tomarJobs(max = 3): Promise<Job[]> {
  await rescatarColgados();
  const candidatos = await prisma.job.findMany({
    where: { estado: ESTADO.PENDIENTE, correrEn: { lte: new Date() } },
    orderBy: { correrEn: "asc" },
    take: max,
    select: { id: true },
  });
  if (candidatos.length === 0) return [];
  const ids = candidatos.map((c) => c.id);
  const res = await prisma.job.updateMany({
    where: { id: { in: ids }, estado: ESTADO.PENDIENTE },
    data: { estado: ESTADO.CORRIENDO, intentos: { increment: 1 } },
  });
  if (res.count === 0) return [];
  return prisma.job.findMany({
    where: { id: { in: ids } },
    orderBy: { correrEn: "asc" },
  });
}

export async function marcarHecho(jobId: number): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { estado: ESTADO.HECHO, error: null },
  });
}

export async function marcarFallo(jobId: number, job: Job, error: string): Promise<void> {
  if (job.intentos >= 3) {
    await prisma.job.update({
      where: { id: jobId },
      data: { estado: ESTADO.FALLIDO, error },
    });
    log("cola", `job ${jobId} fallido definitivo (3 intentos): ${error}`);
    return;
  }
  // Reintento en 20 segundos.
  await prisma.job.update({
    where: { id: jobId },
    data: { estado: ESTADO.PENDIENTE, correrEn: new Date(Date.now() + 20_000), error },
  });
  log("cola", `job ${jobId} falló (intento ${job.intentos}): ${error}. Reintento en 20s`);
}

function marcarIniciado(jobId: number): void {
  // Toque para actualizar actualizadoEn (evita que lo rescate el rescate de colgados).
  setImmediate(() => {
    prisma.job
      .update({ where: { id: jobId }, data: { actualizadoEn: new Date() } })
      .catch(() => {});
  });
}

// Procesa un job del tipo correspondiente. Devuelve true si terminó bien.
export async function procesarJob(job: Job): Promise<void> {
  const payload = job.payload ? JSON.parse(job.payload) : undefined;

  if (job.tipo === TIPO.ENTENDER_MEDIA) {
    const { entenderMedia } = await import("./media");
    const datos = payload as unknown as PayloadMedia;
    const resultado = await entenderMedia(datos);
    // Guardar transcripción/descripción en el Mensaje para que el panel la
    // muestre sin volver a procesar. Si no hubo resultado (no se encontró el
    // mensaje), se omite sin romper el flujo.
    if (resultado?.texto) {
      await prisma.mensaje
        .update({ where: { id: datos.messageId }, data: { texto: resultado.texto } })
        .catch(() => {});
    }
    // Tanto si se entendió como si no, se encola la respuesta: si falló, el
    // agente pide que se lo escriban. Audio + foto juntos = una sola respuesta.
    const responder: PayloadResponder = {
      contactoId: resultado?.contactoId ?? datos.contactoId,
      mensajeId: resultado?.messageId ?? datos.messageId,
    };
    await encolar(
      TIPO.RESPONDER,
      String(responder.contactoId),
      new Date(Date.now() + DEBOUNCE_SEG * 1000),
      responder
    );
    return;
  }

  if (job.tipo === TIPO.RESPONDER) {
    const { responder } = await import("./agente");
    await responder((payload ?? {}) as unknown as PayloadResponder);
    return;
  }

  throw new Error(`Tipo de job desconocido: ${job.tipo}`);
}

async function arrancarWorker(): Promise<void> {
  let ocupado = false;
  const intervalo = setInterval(async () => {
    if (ocupado) return; // bandera: una vuelta no arranca si la anterior no terminó
    ocupado = true;
    try {
      const jobs = await tomarJobs(3);
      for (const job of jobs) {
        marcarIniciado(job.id);
        try {
          await procesarJob(job);
          await marcarHecho(job.id);
          log("cola", `job ${job.id} (${job.tipo}) hecho`);
        } catch (err) {
          const mensaje = err instanceof Error ? err.message : String(err);
          log("cola", `job ${job.id} (${job.tipo}) error: ${mensaje}`);
          await marcarFallo(job.id, job, mensaje);
        }
      }
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      log("cola", `error en la vuelta del worker: ${mensaje}`);
    } finally {
      ocupado = false;
    }
  }, 10_000);
  intervalo.unref();
  log("cola", "worker arrancado (cada 10 s, hasta 3 jobs)");
}

// Guardia en globalThis: en desarrollo Next llama a register() más de una vez
// con cada recarga en caliente, y sin protección habría dos o tres workers.
const g = globalThis as unknown as { workerArrancado?: boolean };

export function iniciarWorkerSiHaceFalta(): void {
  if (g.workerArrancado) return;
  g.workerArrancado = true;
  arrancarWorker().catch((err) => {
    log("cola", `no se pudo arrancar el worker: ${err}`);
  });
}

// Estado para el pie del rail lateral: jobs encolados y fallidos.
export async function resumenCola(): Promise<{ pendientes: number; fallidos: number }> {
  const [pendientes, fallidos] = await Promise.all([
    prisma.job.count({ where: { estado: ESTADO.PENDIENTE } }),
    prisma.job.count({ where: { estado: ESTADO.FALLIDO } }),
  ]);
  return { pendientes, fallidos };
}