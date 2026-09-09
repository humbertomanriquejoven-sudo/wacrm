import { Fragment } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { bloquesOcupados } from "@/lib/calendario";
import { diaDeAtencion, partesLocales, desdeLocal } from "@/lib/config";
import { Vivo } from "../vivo";

export const dynamic = "force-dynamic";

const ALTURA_HORA = 54;
const HORA_INICIO = 8;
const HORA_FIN = 19;

const DIAS_CORTOS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

function lunesDeEstaSemana(hoy: Date): Date {
  const p = partesLocales(hoy);
  const ref = desdeLocal(p.anio, p.mes, p.dia, 12, 0);
  const dow = ref.getDay(); // 0=dom,1=lun..6=sab
  const desvio = (dow + 6) % 7;
  return new Date(ref.getTime() - desvio * 24 * 3600_000);
}

function hoyLocal(): Date {
  const p = partesLocales(new Date());
  return desdeLocal(p.anio, p.mes, p.dia, 0, 0);
}

function estaFuera(dia: Date, hora: number): boolean {
  const atencion = diaDeAtencion(dia);
  if (!atencion) return true;
  return hora < atencion.apertura || hora >= atencion.cierre;
}

function minutosEntre(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000;
}

export default async function CalendarioPage({
  searchParams,
}: {
  searchParams: Promise<{ semana?: string }>;
}) {
  const params = await searchParams;
  const semanaStr = params.semana;
  const semanaOffset = semanaStr ? Number(semanaStr) : 0;
  if (semanaStr && Number.isNaN(semanaOffset)) return notFound();

  const lunes = lunesDeEstaSemana(new Date());
  const semanaInicio = new Date(lunes.getTime() + semanaOffset * 7 * 24 * 3600_000);
  const semanaFin = new Date(semanaInicio.getTime() + 7 * 24 * 3600_000);

  const semanaAnterior = semanaOffset - 1;
  const semanaSiguiente = semanaOffset + 1;

  const hoy = hoyLocal();
  const manana = new Date(hoy.getTime() + 24 * 3600_000);

  const [citasDb, eventosGoogleRaw] = await Promise.all([
    prisma.cita.findMany({
      where: {
        cancelada: false,
        fin: { gte: semanaInicio },
        inicio: { lt: semanaFin },
      },
      orderBy: { inicio: "asc" },
    }),
    bloquesOcupados(semanaInicio, semanaFin).catch(() => null),
  ]);

  const googleFallo = eventosGoogleRaw === null;
  const eventosGoogle = eventosGoogleRaw ?? [];

  // Mapear eventos a posiciones por día local.
  const eventosPorDia = new Map<
    string,
    Array<{
      topPx: number;
      alturaPx: number;
      clase: string;
      etiqueta: string;
    }>
  >();

  function agregarEvento(
    inicio: Date,
    fin: Date,
    clase: string,
    etiqueta: string
  ) {
    const pInicio = partesLocales(inicio);
    const pFin = partesLocales(fin);
    const clave = `${pInicio.anio}-${pInicio.mes}-${pInicio.dia}`;
    const horas = pInicio.hora + pInicio.minuto / 60;
    const horasFin = pFin.hora + pFin.minuto / 60;
    const topPx = Math.max(0, (horas - HORA_INICIO) * ALTURA_HORA);
    const alturaPx = Math.max((horasFin - horas) * ALTURA_HORA, ALTURA_HORA * 0.5);
    const eventos = eventosPorDia.get(clave) ?? [];
    eventos.push({ topPx, alturaPx, clase, etiqueta });
    eventosPorDia.set(clave, eventos);
  }

  for (const cita of citasDb) {
    agregarEvento(cita.inicio, cita.fin, "evento-agente", "Cita");
  }
  for (const bloque of eventosGoogle) {
    agregarEvento(bloque.inicio, bloque.fin, "evento-google", "Ocupado");
  }

  return (
    <>
      <div className="cabecera-pagina">
        <h1>Calendario</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Vivo intervaloMs={15_000} />
          <div className="nav-semana">
            <Link href={`?semana=${semanaAnterior}`} className="btn">
              Anterior
            </Link>
            <Link href={`?semana=0`} className="btn">
              Hoy
            </Link>
            <Link href={`?semana=${semanaSiguiente}`} className="btn">
              Siguiente
            </Link>
          </div>
        </div>
      </div>

      {googleFallo ? (
        <div className="aviso">
          No se pudieron leer los eventos de Google Calendar. Se muestran solo las
          citas registradas en la base de datos.
        </div>
      ) : null}

      <div className="calendario">
        <div className="cal-esquina"></div>
        {Array.from({ length: 7 }, (_, i) => {
          const dia = new Date(semanaInicio.getTime() + i * 24 * 3600_000);
          const p = partesLocales(dia);
          const esHoy =
            p.anio === hoy.getFullYear() &&
            p.mes === hoy.getMonth() + 1 &&
            p.dia === hoy.getDate();
          return (
            <div
              key={i}
              className={`cal-cabecera${esHoy ? " cal-cabecera-hoy" : ""}`}
            >
              {DIAS_CORTOS[i]} {p.dia}/{p.mes}
            </div>
          );
        })}

        {Array.from(
          { length: HORA_FIN - HORA_INICIO },
          (_, idx) => HORA_INICIO + idx
        ).map((hora) => (
          <Fragment key={hora}>
            <div className="cal-hora">
              {String(hora).padStart(2, "0")}:00
            </div>
            {Array.from({ length: 7 }, (_, i) => {
              const dia = new Date(semanaInicio.getTime() + i * 24 * 3600_000);
              const p = partesLocales(dia);
              const clave = `${p.anio}-${p.mes}-${p.dia}`;
              const fuera = estaFuera(dia, hora);
              const eventos = eventosPorDia.get(clave) ?? [];
              const esHoy =
                p.anio === hoy.getFullYear() &&
                p.mes === hoy.getMonth() + 1 &&
                p.dia === hoy.getDate();
              const lineaAhora =
                esHoy &&
                new Date().getHours() === hora;
              return (
                <div
                  key={`c${hora}-${i}`}
                  className={`cal-dia${fuera ? " cal-dia-fuera" : ""}`}
                  style={{ position: "relative" }}
                >
                  {eventos.map((ev, j) => (
                    <div
                      key={j}
                      className={`evento-cal ${ev.clase}`}
                      style={{
                        top: ev.topPx,
                        height: ev.alturaPx,
                      }}
                    >
                      {ev.etiqueta}
                    </div>
                  ))}
                  {lineaAhora ? <div className="ahora-linea" /> : null}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </>
  );
}