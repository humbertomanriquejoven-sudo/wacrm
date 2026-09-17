'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CitaFormDialog } from '@/components/citas/cita-form-dialog';
import { RescheduleDialog } from '@/components/citas/reschedule-dialog';
import { CancelCitaDialog } from '@/components/citas/cancel-cita-dialog';
import {
  CalendarClock,
  CalendarX2,
  Copy,
  ExternalLink,
  Plus,
  Video,
} from 'lucide-react';
import type { CitaWithContact } from '@/types';
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
} from '@/lib/citas/semana';

export interface OcupadoProp {
  start: string;
  end: string;
  /** Google Calendar event id, when the block is a real event. */
  id?: string | null;
  /** Event title, when the block is a real event. */
  summary?: string | null;
  /** Event description, when the block is a real event. */
  description?: string | null;
  /** Invited guests, when the block is a real event. */
  attendees?: Array<{
    email?: string | null;
    displayName?: string | null;
    responseStatus?: string | null;
  }> | null;
  /** Meet hangout link (falling back to the htmlLink), when present. */
  meetLink?: string | null;
}

export interface CalendarioColumnasProps {
  /** Full appointment list for the account (server-fetched). */
  citas: CitaWithContact[];
  /** Busy intervals (ISO UTC) returned by Google (may be empty). */
  ocupados: OcupadoProp[];
  /** Focused ISO week. */
  foco: { anio: number; semana: number };
}

interface EventoSeleccionado {
  tipo: 'cita' | 'ocupado';
  cita?: CitaWithContact;
  ocupado?: OcupadoProp;
}

const fmtHora = new Intl.DateTimeFormat('es-CO', {
  timeZone: CAL_TZ,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const fmtFecha = new Intl.DateTimeFormat('es-CO', {
  timeZone: CAL_TZ,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

/** "6:00 pm" (es-CO "6:00 p. m." normalizado a la forma de Google). */
function horaCorta(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return fmtHora
    .format(d)
    .replace(/p\.\s*m\./i, 'pm')
    .replace(/a\.\s*m\./i, 'am');
}

/** "Viernes, 18 de septiembre · 6:00 – 6:45pm". */
function formatoRango(inicioIso: string, finIso: string): string {
  const d = new Date(inicioIso);
  if (Number.isNaN(d.getTime())) return '-';
  return `${fmtFecha.format(d)} · ${horaCorta(inicioIso)} – ${horaCorta(finIso)}`;
}

/**
 * Interactive overlay of the weekly grid. It is absolutely positioned
 * over the server-rendered hour background and owns every clickable
 * affordance: appointment blocks (opens a Google-Calendar-style popover
 * with the Meet link), busy blocks (same, when details are available),
 * per-day detail, and the create / reschedule / cancel dialogs. Geometry
 * is shared with the page via `@/lib/citas/semana`, so blocks line up
 * with the RSC grid.
 */
export function CalendarioColumnas({
  citas,
  ocupados,
  foco,
}: CalendarioColumnasProps) {
  const router = useRouter();

  const dias = useMemo(() => {
    const lunes = mondayOfIsoWeek(foco.anio, foco.semana);
    return Array.from({ length: 7 }, (_, i) => {
      const clave = sumarFechaKey(lunes, i);
      const fecha = bogotaWallInstant(clave, 720);
      return { clave, numero: bogotaClock(fecha).day };
    });
  }, [foco]);

  const [diaSeleccionado, setDiaSeleccionado] = useState<string | null>(null);
  const [detalleOpen, setDetalleOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [formDefault, setFormDefault] = useState('');
  const [objetivo, setObjetivo] = useState<CitaWithContact | null>(null);
  const [reagendarOpen, setReagendarOpen] = useState(false);
  const [cancelarOpen, setCancelarOpen] = useState(false);
  const [evento, setEvento] = useState<EventoSeleccionado | null>(null);

  const refresh = () => router.refresh();
  const porDia = useMemo(() => {
    const map = new Map<string, CitaWithContact[]>();
    for (const c of citas) {
      const key = bogotaDateKey(new Date(c.fecha_inicio));
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.fecha_inicio.localeCompare(b.fecha_inicio));
    }
    return map;
  }, [citas]);

  const citasDelDia = diaSeleccionado
    ? (porDia.get(diaSeleccionado) ?? [])
    : [];
  const tituloDia = diaSeleccionado
    ? new Intl.DateTimeFormat('es-CO', {
        timeZone: CAL_TZ,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }).format(bogotaWallInstant(diaSeleccionado, 720))
    : '';

  function abrirDia(clave: string) {
    setDiaSeleccionado(clave);
    setDetalleOpen(true);
  }

  function nuevaCitaDelDia() {
    if (!diaSeleccionado) return;
    setFormDefault(
      aLocalInput(bogotaWallInstant(diaSeleccionado, INICIO_LABORAL_MIN))
    );
    setDetalleOpen(false);
    setFormOpen(true);
  }

  function abrirCita(c: CitaWithContact) {
    setEvento({ tipo: 'cita', cita: c });
  }

  function abrirOcupado(o: OcupadoProp) {
    setEvento({ tipo: 'ocupado', ocupado: o });
  }

  function copiarEnlace(link: string) {
    navigator.clipboard
      .writeText(link)
      .then(() => toast.success('Enlace copiado'))
      .catch(() => toast.error('No se pudo copiar el enlace'));
  }

  // Datos derivados del evento seleccionado (cita o bloque ocupado).
  const eventoInicio = evento
    ? ((evento.tipo === 'cita'
        ? evento.cita?.fecha_inicio
        : evento.ocupado?.start) ?? '')
    : '';
  const eventoFin = evento
    ? ((evento.tipo === 'cita'
        ? evento.cita?.fecha_fin
        : evento.ocupado?.end) ?? '')
    : '';
  const eventoTitulo = evento
    ? evento.tipo === 'cita'
      ? evento.cita?.summary ||
        `Cita con Cliente - ${evento.cita?.contact?.name ?? 'Cliente'}`
      : evento.ocupado?.summary || 'Ocupado'
    : '';
  const eventoCliente = evento
    ? evento.tipo === 'cita'
      ? evento.cita?.contact?.name || evento.cita?.contact?.phone || ''
      : evento.ocupado?.attendees?.[0]?.displayName || ''
    : '';
  const eventoCorreo = evento
    ? evento.tipo === 'cita'
      ? evento.cita?.contact?.email || evento.cita?.attendees?.[0]?.email || ''
      : evento.ocupado?.attendees?.[0]?.email || ''
    : '';
  const eventoDescripcion = evento
    ? evento.tipo === 'cita'
      ? evento.cita?.description || evento.cita?.motivo || ''
      : evento.ocupado?.description || ''
    : '';
  const eventoLink = evento
    ? evento.tipo === 'cita'
      ? evento.cita?.meet_link || null
      : evento.ocupado?.meetLink || null
    : null;

  return (
    <>
      <div className="absolute inset-0 grid grid-cols-[64px_repeat(7,minmax(0,1fr))]">
        <div aria-hidden="true" />
        {dias.map((d, i) => (
          <div key={d.clave} className="relative">
            {/* Bloques ocupados (Google): clic abre el popover con detalles. */}
            {ocupados.map((o) => {
              const r = ocupadoRango(d.clave, o.start, o.end);
              if (!r) return null;
              return (
                <button
                  key={o.id ?? `${o.start}_${o.end}`}
                  type="button"
                  onClick={() => abrirOcupado(o)}
                  aria-label={`Ver ${o.summary || 'Ocupado'} (bloque ocupado)`}
                  className="cal-busy cursor-pointer p-0"
                  style={{
                    top: r.inicioMin,
                    height: Math.max(r.finMin - r.inicioMin, 1),
                  }}
                />
              );
            })}

            {/* Capa de clic en todo el día → detalle / agregar cita. */}
            <button
              type="button"
              aria-label={`Ver ${DIAS_CORTOS[i]} ${d.numero}`}
              onClick={() => abrirDia(d.clave)}
              className="absolute inset-0 z-0"
            />

            {/* Citas del agente (verdes / atenuadas si canceladas). */}
            {(porDia.get(d.clave) ?? []).map((c) => {
              const r = citaRango(d.clave, c.fecha_inicio, c.fecha_fin);
              if (!r) return null;
              const cancelada = c.estado === 'cancelada';
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => abrirCita(c)}
                  className={[
                    'cal-cita',
                    cancelada ? 'cal-cita--cancelada' : '',
                  ].join(' ')}
                  style={{
                    top: r.inicioMin,
                    height: Math.max(r.finMin - r.inicioMin, 1),
                  }}
                  aria-label={`${bogotaHora(c.fecha_inicio)} — ${c.contact?.name || c.contact?.phone || '-'}`}
                >
                  <span className="cal-cita__hora">
                    {bogotaHora(c.fecha_inicio)}
                  </span>
                  <span className="truncate">
                    {c.contact?.name || c.contact?.phone || '-'}
                  </span>
                  {c.motivo && (
                    <span className="w-full truncate opacity-80">
                      {c.motivo}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Popover del evento (estilo Google Calendar) */}
      <Dialog
        open={evento !== null}
        onOpenChange={(v) => {
          if (!v) setEvento(null);
        }}
      >
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground capitalize">
              {eventoTitulo}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {formatoRango(eventoInicio, eventoFin)}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 text-sm">
            {eventoCliente && (
              <div className="border-border bg-card flex items-start justify-between gap-2 rounded-lg border px-3 py-2">
                <span className="text-muted-foreground">Cliente</span>
                <span className="text-foreground text-right font-medium">
                  {eventoCliente}
                </span>
              </div>
            )}
            {eventoCorreo && (
              <div className="border-border bg-card flex items-start justify-between gap-2 rounded-lg border px-3 py-2">
                <span className="text-muted-foreground">Correo</span>
                <span className="text-foreground text-right break-all">
                  {eventoCorreo}
                </span>
              </div>
            )}
            {eventoDescripcion && (
              <div className="border-border bg-card text-muted-foreground rounded-lg border px-3 py-2">
                {eventoDescripcion}
              </div>
            )}
            {evento?.tipo === 'cita' && evento.cita && (
              <div className="pt-0.5">
                <Badge
                  variant={
                    evento.cita.estado === 'confirmada' ? 'default' : 'outline'
                  }
                  className={
                    evento.cita.estado === 'cancelada'
                      ? 'border-border bg-muted text-muted-foreground'
                      : undefined
                  }
                >
                  {evento.cita.estado === 'confirmada'
                    ? 'Confirmada'
                    : 'Cancelada'}
                </Badge>
              </div>
            )}
          </div>

          {eventoLink && (
            <div className="flex flex-col gap-2">
              <Button
                render={
                  <a
                    href={eventoLink}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                <Video className="size-4" />
                Unirse con Google Meet
              </Button>
              <Button
                variant="outline"
                className="border-border text-foreground hover:bg-muted"
                onClick={() => copiarEnlace(eventoLink)}
              >
                <Copy className="size-4" />
                Copiar enlace
              </Button>
            </div>
          )}

          {evento?.tipo === 'cita' && evento.cita?.estado === 'confirmada' && (
            <div className="border-border flex justify-end gap-1 border-t pt-3">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  const c = evento.cita!;
                  setEvento(null);
                  setObjetivo(c);
                  setReagendarOpen(true);
                }}
              >
                <CalendarClock className="size-4" />
                Reagendar
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  const c = evento.cita!;
                  setEvento(null);
                  setObjetivo(c);
                  setCancelarOpen(true);
                }}
              >
                <CalendarX2 className="size-4" />
                Cancelar
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Detalle del día */}
      <Dialog open={detalleOpen} onOpenChange={setDetalleOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground capitalize">
              {tituloDia}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {citasDelDia.length > 0
                ? `${citasDelDia.length} ${citasDelDia.length === 1 ? 'cita' : 'citas'} este día`
                : 'Sin citas este día.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {citasDelDia.map((c) => (
              <div
                key={c.id}
                className="border-border bg-card flex items-center justify-between gap-2 rounded-lg border px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="text-foreground text-sm font-medium">
                    {bogotaHora(c.fecha_inicio)} —{' '}
                    {c.contact?.name || c.contact?.phone || '-'}
                  </span>
                  {c.motivo && (
                    <span className="text-muted-foreground truncate text-xs">
                      {c.motivo}
                    </span>
                  )}
                  {c.meet_link && (
                    <a
                      href={c.meet_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary mt-0.5 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
                    >
                      <ExternalLink className="size-3 shrink-0" />
                      Abrir en Google Calendar
                    </a>
                  )}
                </div>
                <Badge
                  variant={c.estado === 'confirmada' ? 'default' : 'outline'}
                  className={
                    c.estado === 'cancelada'
                      ? 'border-border bg-muted text-muted-foreground'
                      : undefined
                  }
                >
                  {c.estado === 'confirmada' ? 'Confirmada' : 'Cancelada'}
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
              .filter((c) => c.estado === 'confirmada')
              .map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="text-muted-foreground truncate text-xs">
                    {bogotaHora(c.fecha_inicio)} —{' '}
                    {c.contact?.name || c.contact?.phone || '-'}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Reagendar"
                      onClick={() => {
                        setDetalleOpen(false);
                        setObjetivo(c);
                        setReagendarOpen(true);
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
                        setDetalleOpen(false);
                        setObjetivo(c);
                        setCancelarOpen(true);
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
  );
}
