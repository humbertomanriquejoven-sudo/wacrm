"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { useCitas } from "@/hooks/use-citas";
import { useCan } from "@/hooks/use-can";
import { GatedButton } from "@/components/ui/gated-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CitaFormDialog,
} from "@/components/citas/cita-form-dialog";
import { RescheduleDialog } from "@/components/citas/reschedule-dialog";
import { CancelCitaDialog } from "@/components/citas/cancel-cita-dialog";
import {
  CalendarDays,
  CalendarClock,
  CalendarX2,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
} from "lucide-react";
import type { CitaWithContact } from "@/types";
import { formatCitaDateTime } from "@/lib/citas/format";

type EstadoFilter = "todas" | "confirmada" | "cancelada";
type VentanaFilter = "proximas" | "hoy" | "todas";

export default function AgendaPage() {
  const t = useTranslations("Agenda.page");
  const supabase = createClient();
  const { citas, loading, refresh } = useCitas();
  const canEdit = useCan("send-messages");

  const [search, setSearch] = useState("");
  const [estado, setEstado] = useState<EstadoFilter>("todas");
  const [ventana, setVentana] = useState<VentanaFilter>("proximas");

  // Dialogs
  const [formOpen, setFormOpen] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [target, setTarget] = useState<CitaWithContact | null>(null);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const now = new Date();
    const todayKey = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const nowKey = todayKey(now);

    return citas.filter((c) => {
      if (term) {
        const name = (c.contact?.name ?? "").toLowerCase();
        const phone = (c.contact?.phone ?? "").toLowerCase();
        if (!name.includes(term) && !phone.includes(term)) return false;
      }
      if (estado !== "todas" && c.estado !== estado) return false;
      if (ventana === "proximas" && new Date(c.fecha_inicio) < now) return false;
      if (ventana === "hoy" && todayKey(new Date(c.fecha_inicio)) !== nowKey) return false;
      return true;
    });
  }, [citas, search, estado, ventana]);

  // Cancel / reschedule only make sense for active appointments.
  const actionable = (c: CitaWithContact) => c.estado === "confirmada";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {filtered.length > 0 ? t("subtitle", { count: filtered.length }) : t("subtitleZero")}
          </p>
        </div>
        <GatedButton
          canAct={canEdit}
          gateReason="book appointments"
          onClick={() => setFormOpen(true)}
          className="bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          <Plus className="size-4" />
          {t("newAppointmentBtn")}
        </GatedButton>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground"
          />
        </div>

        <Select value={ventana} onValueChange={(v) => setVentana(v as VentanaFilter)}>
          <SelectTrigger className="border-border text-muted-foreground bg-card w-full sm:w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-popover text-popover-foreground ring-border">
            <SelectItem value="proximas">{t("ventanaProximas")}</SelectItem>
            <SelectItem value="hoy">{t("ventanaHoy")}</SelectItem>
            <SelectItem value="todas">{t("ventanaTodas")}</SelectItem>
          </SelectContent>
        </Select>

        <Select value={estado} onValueChange={(v) => setEstado(v as EstadoFilter)}>
          <SelectTrigger className="border-border text-muted-foreground bg-card w-full sm:w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-popover text-popover-foreground ring-border">
            <SelectItem value="todas">{t("estadoTodas")}</SelectItem>
            <SelectItem value="confirmada">{t("estadoConfirmada")}</SelectItem>
            <SelectItem value="cancelada">{t("estadoCancelada")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted-foreground">{t("colFecha")}</TableHead>
              <TableHead className="text-muted-foreground">{t("colContacto")}</TableHead>
              <TableHead className="text-muted-foreground hidden md:table-cell">{t("colMotivo")}</TableHead>
              <TableHead className="text-muted-foreground">{t("colEstado")}</TableHead>
              <TableHead className="text-muted-foreground w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={5} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t("loading")}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={5} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <CalendarDays className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {search || estado !== "todas" || ventana !== "todas"
                        ? t("noAppointmentsMatch")
                        : t("noAppointmentsYet")}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((cita) => (
                <TableRow
                  key={cita.id}
                  className="border-border hover:bg-muted/50"
                >
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-sm text-foreground font-medium">
                        {formatCitaDateTime(cita.fecha_inicio)}
                      </span>
                      {cita.fecha_fin && cita.fecha_fin !== cita.fecha_inicio && (
                        <span className="text-xs text-muted-foreground">
                          → {formatCitaDateTime(cita.fecha_fin)}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-sm text-foreground">
                        {cita.contact?.name || (
                          <span className="text-muted-foreground italic">-</span>
                        )}
                      </span>
                      {cita.contact?.phone && (
                        <span className="text-xs text-muted-foreground font-mono">
                          {cita.contact.phone}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell text-sm">
                    {cita.motivo || <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={cita.estado === "confirmada" ? "default" : "outline"}
                      className={
                        cita.estado === "cancelada"
                          ? "border-border bg-muted text-muted-foreground"
                          : undefined
                      }
                    >
                      {cita.estado === "confirmada"
                        ? t("estadoConfirmada")
                        : t("estadoCancelada")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {canEdit && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:text-foreground"
                            />
                          }
                        >
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="bg-popover border-border"
                        >
                          {actionable(cita) ? (
                            <>
                              <DropdownMenuItem
                                onClick={() => {
                                  setTarget(cita);
                                  setRescheduleOpen(true);
                                }}
                                className="text-popover-foreground focus:bg-muted focus:text-foreground"
                              >
                                <CalendarClock className="size-4" />
                                {t("reagendar")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => {
                                  setTarget(cita);
                                  setCancelOpen(true);
                                }}
                              >
                                <CalendarX2 className="size-4" />
                                {t("cancelar")}
                              </DropdownMenuItem>
                            </>
                          ) : (
                            <DropdownMenuItem disabled className="text-muted-foreground">
                              {t("noActions")}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Dialogs */}
      <CitaFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        onSaved={refresh}
      />
      <RescheduleDialog
        cita={target}
        open={rescheduleOpen}
        onOpenChange={setRescheduleOpen}
        onSaved={refresh}
      />
      <CancelCitaDialog
        cita={target}
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        onSaved={refresh}
      />
    </div>
  );
}