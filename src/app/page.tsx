import { prisma } from "@/lib/prisma";
import { desdeLocal, fechaLegible, horaLegible, partesLocales } from "@/lib/config";
import { Vivo } from "./vivo";

export const dynamic = "force-dynamic";

function inicioDeHoy(): Date {
  const p = partesLocales(new Date());
  return desdeLocal(p.anio, p.mes, p.dia, 0, 0);
}

function finDeHoy(): Date {
  const p = partesLocales(new Date());
  return desdeLocal(p.anio, p.mes, p.dia, 23, 59, 59);
}

export default async function AgendaPage() {
  const ahora = new Date();
  const inicioHoy = inicioDeHoy();
  const finHoy = finDeHoy();
  const finSemana = new Date(inicioHoy.getTime() + 7 * 24 * 3600_000);

  const [citass, citasHoy, citasSemana, mensajesHoy] = await Promise.all([
    prisma.cita.findMany({
      where: { fin: { gte: inicioHoy } },
      orderBy: { inicio: "asc" },
      include: { contacto: true },
    }),
    prisma.cita.count({
      where: { cancelada: false, inicio: { gte: inicioHoy, lte: finHoy } },
    }),
    prisma.cita.count({
      where: { cancelada: false, inicio: { gte: inicioHoy, lt: finSemana } },
    }),
    prisma.mensaje.count({
      where: { direccion: "entrante", creadoEn: { gte: inicioHoy } },
    }),
  ]);

  const proximas = citass.filter(
    (c) => !c.cancelada && c.fin.getTime() > ahora.getTime()
  ).length;

  // Agrupar por día local manteniendo el orden.
  const grupos = new Map<string, typeof citass>();
  for (const cita of citass) {
    const clave = `${cita.inicio.getFullYear()}-${cita.inicio.getMonth()}-${cita.inicio.getDate()}`;
    const grupo = grupos.get(clave) ?? [];
    grupo.push(cita);
    grupos.set(clave, grupo);
  }

  return (
    <>
      <div className="cabecera-pagina">
        <h1>Agenda</h1>
        <Vivo />
      </div>

      <div className="grid-metricas">
        <div className="metrica">
          <div className="metrica-valor">{proximas}</div>
          <div className="metrica-titulo">Próximas citas</div>
        </div>
        <div className="metrica">
          <div className="metrica-valor">{citasHoy}</div>
          <div className="metrica-titulo">Citas hoy</div>
        </div>
        <div className="metrica">
          <div className="metrica-valor">{citasSemana}</div>
          <div className="metrica-titulo">Citas esta semana</div>
        </div>
        <div className="metrica">
          <div className="metrica-valor">{mensajesHoy}</div>
          <div className="metrica-titulo">Mensajes entrantes hoy</div>
        </div>
      </div>

      {grupos.size === 0 ? (
        <div className="vacio">Todavía no hay citas.</div>
      ) : (
        [...grupos.entries()].map(([clave, citas]) => {
          const primera = citas[0];
          return (
            <section key={clave} className="grupo-dia">
              <details open>
                <summary className="grupo-dia-titulo">
                  {fechaLegible(primera.inicio)} · {citas.length}{" "}
                  {citas.length === 1 ? "cita" : "citas"}
                </summary>
                <div className="lista-citas">
                  {citas.map((cita) => (
                    <div
                      key={cita.id}
                      className={`fila-cita${cita.cancelada ? " fila-cita-cancelada" : ""}`}
                    >
                      <div className="fila-cita-hora">{horaLegible(cita.inicio)}</div>
                      <div className="fila-cita-info">
                        <div className="fila-cita-nombre">
                          {cita.contacto.nombre || cita.contacto.waId}
                        </div>
                        {cita.notas ? (
                          <div className="fila-cita-nota">{cita.notas}</div>
                        ) : null}
                      </div>
                      {cita.cancelada ? (
                        <span className="etiqueta-cancelada">Cancelada</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              </details>
            </section>
          );
        })
      )}
    </>
  );
}