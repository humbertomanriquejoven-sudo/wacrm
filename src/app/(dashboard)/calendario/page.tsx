import Link from "next/link"
import { ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase/server"
import {
  BUSINESS_HOURS,
  calendarConfigured,
  consultarOcupados,
  type ConsultaOcupados,
} from "@/lib/calendar"
import {
  CAL_TZ,
  DIAS_CORTOS,
  DURACION_LABORAL_MIN,
  FIN_LABORAL_MIN,
  INICIO_LABORAL_MIN,
  bogotaClock,
  bogotaMinuteOfDay,
  bogotaWallInstant,
  clampSemana,
  hoyBogota,
  mondayOfIsoWeek,
  semanaActualBogota,
  sumarFechaKey,
  sumarSemana,
} from "@/lib/citas/semana"
import { CalendarioAcciones } from "@/components/calendario/calendario-acciones"
import { CalendarioColumnas } from "@/components/calendario/calendario-columnas"
import type { CitaWithContact } from "@/types"

// The grid reflects live Google Calendar availability + the CRM rows, so
// it must never be cached. `force-dynamic` is valid here because
// `cacheComponents` is not enabled in next.config.
export const dynamic = "force-dynamic"

// Hour labels aligned with the business window (08:00..22:00 → 15 labels
// × 60px = 900px, matching DURACION_LABORAL_MIN).
const HOURS = Array.from(
  { length: (FIN_LABORAL_MIN - INICIO_LABORAL_MIN) / 60 },
  (_, i) => INICIO_LABORAL_MIN / 60 + i,
)

const fmtDia = new Intl.DateTimeFormat("es-CO", {
  timeZone: CAL_TZ,
  day: "numeric",
  month: "long",
})
const fmtDiaAnio = new Intl.DateTimeFormat("es-CO", {
  timeZone: CAL_TZ,
  day: "numeric",
  month: "long",
  year: "numeric",
})

function hrefSemana(anio: number, semana: number): string {
  return `/calendario?anio=${anio}&semana=${semana}`
}

interface CalendarioPageProps {
  searchParams: Promise<{ anio?: string; semana?: string }>
}

export default async function CalendarioPage({ searchParams }: CalendarioPageProps) {
  const params = await searchParams

  const actual = semanaActualBogota()
  const anioParam = Number(params.anio)
  const anio =
    params.anio !== undefined && Number.isFinite(anioParam)
      ? Math.trunc(anioParam)
      : actual.anio
  const semanaParam = Number(params.semana)
  const foco =
    params.semana !== undefined && Number.isFinite(semanaParam)
      ? clampSemana(anio, semanaParam)
      : { anio: actual.anio, semana: actual.semana }

  const lunes = mondayOfIsoWeek(foco.anio, foco.semana)
  const dias = Array.from({ length: 7 }, (_, i) => {
    const clave = sumarFechaKey(lunes, i)
    const c = bogotaClock(bogotaWallInstant(clave, 12 * 60))
    return { clave, numero: c.day, weekday: c.weekday }
  })

  const hoyKey = hoyBogota()
  const ahoraMin = bogotaMinuteOfDay(new Date())
  const lineaTop = ahoraMin - INICIO_LABORAL_MIN

  const inicioSemana = bogotaWallInstant(lunes, 0)
  const inicioProxSemana = bogotaWallInstant(sumarFechaKey(lunes, 7), 0)

  const supabase = await createClient()
  const { data: citas } = await supabase
    .from("citas")
    .select("*, contact:contacts(id, name, phone, email)")
    .order("fecha_inicio", { ascending: true })
  const citasList = (citas ?? []) as CitaWithContact[]

  let ocupadosInfo: ConsultaOcupados = { ok: false, ocupados: [] }
  if (calendarConfigured()) {
    ocupadosInfo = await consultarOcupados(
      inicioSemana.toISOString(),
      inicioProxSemana.toISOString(),
    )
  }

  const rangoLabel = `${fmtDia.format(inicioSemana)} – ${fmtDiaAnio.format(
    bogotaWallInstant(sumarFechaKey(lunes, 6), 12 * 60),
  )}`
  const semanaActualLabel = `Semana ${foco.semana} de ${foco.anio}`

  const prev = sumarSemana(foco.anio, foco.semana, -1)
  const next = sumarSemana(foco.anio, foco.semana, 1)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Calendario</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Vista semanal de citas y disponibilidad · América/Bogotá
          </p>
        </div>
        <CalendarioAcciones />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button
            render={<Link href={hrefSemana(prev.anio, prev.semana)} />}
            variant="outline"
            size="icon-sm"
            aria-label="Semana anterior"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button render={<Link href="/calendario" />} variant="outline" size="sm">
            Hoy
          </Button>
          <Button
            render={<Link href={hrefSemana(next.anio, next.semana)} />}
            variant="outline"
            size="icon-sm"
            aria-label="Semana siguiente"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <h2 className="text-base font-semibold capitalize text-foreground">
          {rangoLabel}
        </h2>
        <span className="text-xs text-muted-foreground">{semanaActualLabel}</span>
      </div>

      {!ocupadosInfo.ok && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <AlertTriangle className="size-3.5 shrink-0" />
          No se pudo consultar Google Calendar; se muestran solo las citas
          guardadas en el CRM.
        </div>
      )}

      {/* Grid */}
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <div className="min-w-[760px]">
          {/* Day headers */}
          <div className="grid grid-cols-[64px_repeat(7,minmax(0,1fr))] border-b border-border">
            <div className="px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Hora
            </div>
            {dias.map((d, i) => (
              <div
                key={d.clave}
                className="flex items-center justify-center gap-2 border-l border-border py-2"
              >
                <span className="text-[11px] font-bold tracking-wider text-muted-foreground">
                  {DIAS_CORTOS[i]}
                </span>
                <span
                  className={
                    d.clave === hoyKey
                      ? "flex size-6 items-center justify-center rounded-full bg-emerald-500 text-[13px] font-bold text-emerald-950"
                      : "text-sm font-semibold text-foreground"
                  }
                >
                  {d.numero}
                </span>
              </div>
            ))}
          </div>

          {/* Body: hour background + client overlay */}
          <div className="relative grid grid-cols-[64px_repeat(7,minmax(0,1fr))]">
            <div className="flex flex-col">
              {HOURS.map((h) => (
                <div
                  key={h}
                  className="h-[60px] pr-2 pt-1 text-right text-[10px] tabular-nums text-muted-foreground"
                >
                  {String(h).padStart(2, "0")}:00
                </div>
              ))}
            </div>

            {dias.map((d) => {
              const hs = BUSINESS_HOURS[d.weekday]
              const abierto = Boolean(hs)
              const shadeTop = hs
                ? Math.min(
                    Math.max(hs.openMin - INICIO_LABORAL_MIN, 0),
                    DURACION_LABORAL_MIN,
                  )
                : 0
              const shadeBottom = hs
                ? Math.min(
                    Math.max(hs.closeMin - INICIO_LABORAL_MIN, 0),
                    DURACION_LABORAL_MIN,
                  )
                : DURACION_LABORAL_MIN
              return (
                <div
                  key={d.clave}
                  className="cal-horas relative border-l border-border"
                  style={{ height: DURACION_LABORAL_MIN }}
                >
                  {!abierto && <div className="cal-stripes absolute inset-0" />}
                  {abierto && shadeTop > 0 && (
                    <div
                      className="cal-stripes absolute inset-x-0 top-0"
                      style={{ height: shadeTop }}
                    />
                  )}
                  {abierto && shadeBottom < FIN_LABORAL_MIN - INICIO_LABORAL_MIN && (
                    <div
                      className="cal-stripes absolute inset-x-0 bottom-0"
                      style={{ top: shadeBottom }}
                    />
                  )}
                  {d.clave === hoyKey && lineaTop >= 0 && lineaTop <= DURACION_LABORAL_MIN && (
                    <div className="cal-linea-ahora" style={{ top: lineaTop }} />
                  )}
                </div>
              )
            })}

            <CalendarioColumnas
              citas={citasList}
              ocupados={ocupadosInfo.ocupados}
              foco={foco}
            />
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-[oklch(0.42_0.12_162)]" />
          Citas del agente
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm border border-dashed border-[oklch(0.82_0.14_70/0.55)] bg-[oklch(0.78_0.16_70/0.28)]" />
          Ocupado (Google Calendar)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm border border-border bg-card" />
          Disponible
        </span>
      </div>
    </div>
  )
}