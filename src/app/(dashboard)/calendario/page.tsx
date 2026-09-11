"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useCitas } from "@/hooks/use-citas";
import { useCan } from "@/hooks/use-can";
import { GatedButton } from "@/components/ui/gated-button";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CitaFormDialog,
} from "@/components/citas/cita-form-dialog";
import { RescheduleDialog } from "@/components/citas/reschedule-dialog";
import { CancelCitaDialog } from "@/components/citas/cancel-cita-dialog";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  CalendarClock,
  CalendarX2,
} from "lucide-react";
import type { CitaWithContact } from "@/types";
import { citaDayKey, formatCitaTime } from "@/lib/citas/format";

const DAY_LABELS = [1, 2, 3, 4, 5, 6, 0]; // Monday..Sunday
const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CalendarioPage() {
  const t = useTranslations("Calendario.page");
  const { citas, loading, refresh } = useCitas();
  const canEdit = useCan("send-messages");

  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  // Selected-day detail
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [targetCita, setTargetCita] = useState<CitaWithContact | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [formDefault, setFormDefault] = useState("");
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const byDay = useMemo(() => {
    const map = new Map<string, CitaWithContact[]>();
    for (const c of citas) {
      const key = citaDayKey(c.fecha_inicio);
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }
    // Sort each day by start time
    for (const list of map.values()) {
      list.sort((a, b) => a.fecha_inicio.localeCompare(b.fecha_inicio));
    }
    return map;
  }, [citas]);

  // Build a 6-week grid of day objects starting on Monday.
  const grid = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const mondayIndex = (first.getDay() + 6) % 7; // Mon=0
    const start = new Date(year, month, 1 - mondayIndex);
    const days: { date: Date; inMonth: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      days.push({ date, inMonth: date.getMonth() === month });
    }
    return days;
  }, [cursor]);

  const todayKey = citaDayKey(today.toISOString());
  const cursorLabel = t(`month.${MONTH_NAMES[cursor.getMonth()]}`) + " " + cursor.getFullYear();

  function moveMonth(delta: number) {
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));
  }

  function goToday() {
    setCursor(new Date(today.getFullYear(), today.getMonth(), 1));
  }

  function openNewFor(datetimeLocal: string) {
    setFormDefault(datetimeLocal);
    setFormOpen(true);
  }

  function openDay(dayKey: string) {
    setSelectedDay(dayKey);
    setDetailOpen(true);
  }

  const dayCitas = selectedDay ? (byDay.get(selectedDay) ?? []) : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("subtitle")}</p>
        </div>
        <GatedButton
          canAct={canEdit}
          gateReason="book appointments"
          onClick={() => openNewFor("")}
          className="bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          <Plus className="size-4" />
          {t("newAppointmentBtn")}
        </GatedButton>
      </div>

      {/* Month toolbar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" onClick={() => moveMonth(-1)} aria-label={t("prevMonth")}>
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => moveMonth(1)} aria-label={t("nextMonth")}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <h2 className="text-base font-semibold text-foreground">{cursorLabel}</h2>
        <Button variant="outline" size="sm" onClick={goToday}>
          {t("todayBtn")}
        </Button>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="rounded-lg border border-border p-16 text-center">
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border">
          {/* Day name headers */}
          {DAY_LABELS.map((dow) => (
            <div
              key={dow}
              className="bg-card px-2 py-2 text-center text-xs font-semibold text-muted-foreground uppercase"
            >
              {t(`day.${dow}`)}
            </div>
          ))}

          {grid.map(({ date, inMonth }, i) => {
            const key = citaDayKey(date.toISOString());
            const list = byDay.get(key) ?? [];
            const isToday = key === todayKey;
            return (
              <div
                key={i}
                className={[
                  "flex min-h-24 flex-col gap-1 bg-card p-1.5 transition-colors hover:bg-muted/50",
                  inMonth ? "" : "opacity-40",
                ].join(" ")}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={[
                      "flex size-6 items-center justify-center rounded-full text-xs font-medium",
                      isToday
                        ? "bg-primary text-primary-foreground"
                        : "text-foreground",
                    ].join(" ")}
                  >
                    {date.getDate()}
                  </span>
                  {list.length > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {list.length}
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-0.5 overflow-hidden">
                  {list.slice(0, 2).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => openDay(key)}
                      className={[
                        "flex items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] font-medium leading-tight transition-colors",
                        c.estado === "confirmada"
                          ? "bg-primary/15 text-primary hover:bg-primary/25"
                          : "bg-muted text-muted-foreground line-through hover:bg-muted/80",
                      ].join(" ")}
                    >
                      <CalendarDays className="size-3 shrink-0" />
                      <span className="truncate">
                        {formatCitaTime(c.fecha_inicio)}
                        {" "}
                        {c.contact?.name || c.contact?.phone || "-"}
                      </span>
                    </button>
                  ))}
                  {list.length > 2 && (
                    <button
                      type="button"
                      onClick={() => openDay(key)}
                      className="rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-muted"
                    >
                      +{list.length - 2} {t("more")}
                    </button>
                  )}
                  {list.length === 0 && canEdit && (
                    <button
                      type="button"
                      onClick={() => openNewFor(`${key}T09:00`)}
                      className="mt-0.5 rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-muted"
                    >
                      {t("addOnDay")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-primary/15" />
          {t("legendConfirmed")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-muted" />
          {t("legendCancelled")}
        </span>
      </div>

      {/* Day detail dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {selectedDay
                ? new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date(`${selectedDay}T00:00:00`))
                : ""}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {dayCitas.length > 0
                ? t("dayAppointmentsCount", { count: dayCitas.length })
                : t("dayAppointmentsNone")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {dayCitas.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-foreground">
                    {formatCitaTime(c.fecha_inicio)} —{" "}
                    {c.contact?.name || c.contact?.phone || "-"}
                  </span>
                  {c.motivo && (
                    <span className="truncate text-xs text-muted-foreground">
                      {c.motivo}
                    </span>
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
                  {c.estado === "confirmada" ? t("estadoConfirmada") : t("estadoCancelada")}
                </Badge>
              </div>
            ))}
          </div>

          {canEdit && (
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                className="border-border text-muted-foreground hover:bg-muted"
                onClick={() => {
                  setDetailOpen(false);
                  openNewFor(selectedDay ? `${selectedDay}T09:00` : "");
                }}
              >
                <Plus className="size-4" />
                {t("addAppointmentOnDay")}
              </Button>
              {dayCitas.some((c) => c.estado === "confirmada") && (
                <div className="flex flex-col gap-2">
                  {dayCitas
                    .filter((c) => c.estado === "confirmada")
                    .map((c) => (
                      <div key={c.id} className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs text-muted-foreground">
                          {formatCitaTime(c.fecha_inicio)} — {c.contact?.name || c.contact?.phone || "-"}
                        </span>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={t("reagendar")}
                            onClick={() => {
                              setDetailOpen(false);
                              setTargetCita(c);
                              setRescheduleOpen(true);
                            }}
                          >
                            <CalendarClock className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive hover:text-destructive"
                            aria-label={t("cancelar")}
                            onClick={() => {
                              setDetailOpen(false);
                              setTargetCita(c);
                              setCancelOpen(true);
                            }}
                          >
                            <CalendarX2 className="size-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Action dialogs */}
      <CitaFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        defaultInicio={formDefault}
        onSaved={refresh}
      />
      <RescheduleDialog
        cita={targetCita}
        open={rescheduleOpen}
        onOpenChange={setRescheduleOpen}
        onSaved={refresh}
      />
      <CancelCitaDialog
        cita={targetCita}
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        onSaved={refresh}
      />
    </div>
  );
}