"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CitaFormDialog } from "@/components/citas/cita-form-dialog"
import { RescheduleDialog } from "@/components/citas/reschedule-dialog"
import { CancelCitaDialog } from "@/components/citas/cancel-cita-dialog"
import {
  CalendarClock,
  CalendarX2,
  ExternalLink,
  Plus,
} from "lucide-react"
import type { CitaWithContact } from "@/types"
import {
  CAL_TZ,
  DIAS_CORTOS,
  INICIO_LABORAL_MIN,
  aLocalInput,
  bogotaClock,
  bogotaDateKey,
  bogotaHora,
  bogotaWallInstant,
  citaRango,
  mondayOfIsoWeek,
  ocupadoRango,
  sumarFechaKey,
} from "@/lib/citas/semana"

export interface OcupadoProp {
  start: string
  end: string
}

export interface CalendarioColumnasProps {
  /** Full appointment list for the account (server-fetched). */
  citas: CitaWithContact[]
  /** Busy intervals (ISO UTC) returned by Google freebusy (may be empty). */
  ocupados: OcupadoProp[]
  /** Focused ISO week. */
  foco: { anio: number; semana: number }
}

/**
 * Interactive overlay of the weekly grid. It is absolutely positioned
 * over the server-rendered hour background and owns every clickable
 * affordance: appointment blocks, per-day detail, and the create /
 * reschedule / cancel dialogs. Geometry is shared with the page via
 * `@/lib/citas/semana`, so blocks line up with the RSC grid.
 */
export function CalendarioColumnas({
  citas,
  ocupados,
  foco,
}: CalendarioColumnasProps) {
  const router = useRouter()

  const dias = useMemo(() => {
    const lunes = mondayOfIsoWeek(foco.anio, foco.semana)
    return Array.from({ length: 7 }, (_, i) => {
      const clave = sumarFechaKey(lunes, i)
      const fecha = bogotaWallInstant(clave, 720)
      return { clave, numero: bogotaClock(fecha).day }
    })
  }, [foco])

  const [diaSeleccionado, setDiaSeleccionado] = useState<string | null>(null)
  const [detalleOpen, setDetalleOpen] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [formDefault, setFormDefault] = useState("")
  const [objetivo, setObjetivo] = useState<CitaWithContact | null>(null)
  const [reagendarOpen, setReagendarOpen] = useState(false)
  const [cancelarOpen, setCancelarOpen] = useState(false)

  const refresh = () => router.refresh()
  const porDia = useMemo(() => {
    const map = new Map<string, CitaWithContact[]>()
    for (const c of citas) {
      const key = bogotaDateKey(new Date(c.fecha_inicio))
      const list = map.get(key) ?? []
      list.push(c)
      map.set(key, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.fecha_inicio.localeCompare(b.fecha_inicio))
    }
    return map
  }, [citas])

  const citasDelDia = diaSeleccionado ? (porDia.get(diaSeleccionado) ?? []) : []
  const tituloDia = diaSeleccionado
    ? new Intl.DateTimeFormat("es-CO", {
        timeZone: CAL_TZ,
        weekday: "long",
        day: "numeric",
        month: "long",
      }).format(bogotaWallInstant(diaSeleccionado, 720))
    : ""

  function abrirDia(clave: string) {
    setDiaSeleccionado(clave)
    setDetalleOpen(true)
  }

  function nuevaCitaDelDia() {
    if (!diaSeleccionado) return
    setFormDefault(aLocalInput(bogotaWallInstant(diaSeleccionado, INICIO_LABORAL_MIN)))
    setDetalleOpen(false)
    setFormOpen(true)
  }

  return (
    <>
      <div className="absolute inset-0 grid grid-cols-[64px_repeat(7,minmax(0,1fr))]">
        <div aria-hidden="true" />
        {dias.map((d, i) => (
          <div key={d.clave} className="relative">
            {/* Bloque ocupado (solo informativo; el clic pasa al día). */}
            {ocupados
              .map((o) => ocupadoRango(d.clave, o.start, o.end))
              .filter((r): r is { inicioMin: number; finMin: number } => r !== null)
              .map((r, idx) => (
                <div
                  key={idx}
                  className="cal-busy pointer-events-none"
                  style={{
                    top: r.inicioMin,
                    height: Math.max(r.finMin - r.inicioMin, 1),
                  }}
                />
              ))}

            {/* Capa de clic en todo el día → detalle / agregar cita. */}
            <button
              type="button"
              aria-label={`Ver ${DIAS_CORTOS[i]} ${d.numero}`}
              onClick={() => abrirDia(d.clave)}
              className="absolute inset-0 z-0"
            />

            {/* Citas del agente (verdes / atenuadas si canceladas). */}
            {(porDia.get(d.clave) ?? []).map((c) => {
              const r = citaRango(d.clave, c.fecha_inicio, c.fecha_fin)
              if (!r) return null
              const cancelada = c.estado === "cancelada"
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => abrirDia(d.clave)}
                  className={[
                    "cal-cita",
                    cancelada ? "cal-cita--cancelada" : "",
                  ].join(" ")}
                  style={{
                    top: r.inicioMin,
                    height: Math.max(r.finMin - r.inicioMin, 1),
                  }}
                  aria-label={`${bogotaHora(c.fecha_inicio)} — ${c.contact?.name || c.contact?.phone || "-"}`}
                >
                  <span className="cal-cita__hora">
                    {bogotaHora(c.fecha_inicio)}
                  </span>
                  <span className="truncate">
                    {c.contact?.name || c.contact?.phone || "-"}
                  </span>
                  {c.motivo && (
                    <span className="w-full truncate opacity-80">{c.motivo}</span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* Detalle del día */}
      <Dialog open={detalleOpen} onOpenChange={setDetalleOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground capitalize">
              {tituloDia}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {citasDelDia.length > 0
                ? `${citasDelDia.length} ${citasDelDia.length === 1 ? "cita" : "citas"} este día`
                : "Sin citas este día."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {citasDelDia.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-foreground">
                    {bogotaHora(c.fecha_inicio)} —{" "}
                    {c.contact?.name || c.contact?.phone || "-"}
                  </span>
                  {c.motivo && (
                    <span className="truncate text-xs text-muted-foreground">
                      {c.motivo}
                    </span>
                  )}
                  {c.meet_link && (
                    <a
                      href={c.meet_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-0.5 inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                    >
                      <ExternalLink className="size-3 shrink-0" />
                      Abrir en Google Calendar
                    </a>
                  )}
                </div>
                <Badge
                  variant={c.estado === "confirmada" ? "default" : "outline"}
                  className={
                    c.estado === "cancelada"
                      ? "border-border bg-muted text-muted-foreground"
                      : undefined
                  }
                >
                  {c.estado === "confirmada" ? "Confirmada" : "Cancelada"}
                </Badge>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              className="border-border text-foreground hover:bg-muted"
              onClick={nuevaCitaDelDia}
            >
              <Plus className="size-4" />
              Nueva cita este día
            </Button>
            {citasDelDia
              .filter((c) => c.estado === "confirmada")
              .map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-muted-foreground">
                    {bogotaHora(c.fecha_inicio)} —{" "}
                    {c.contact?.name || c.contact?.phone || "-"}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Reagendar"
                      onClick={() => {
                        setDetalleOpen(false)
                        setObjetivo(c)
                        setReagendarOpen(true)
                      }}
                    >
                      <CalendarClock className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive hover:text-destructive"
                      aria-label="Cancelar"
                      onClick={() => {
                        setDetalleOpen(false)
                        setObjetivo(c)
                        setCancelarOpen(true)
                      }}
                    >
                      <CalendarX2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        </DialogContent>
      </Dialog>

      <CitaFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        defaultInicio={formDefault}
        onSaved={refresh}
      />
      <RescheduleDialog
        cita={objetivo}
        open={reagendarOpen}
        onOpenChange={setReagendarOpen}
        onSaved={refresh}
      />
      <CancelCitaDialog
        cita={objetivo}
        open={cancelarOpen}
        onOpenChange={setCancelarOpen}
        onSaved={refresh}
      />
    </>
  )
}