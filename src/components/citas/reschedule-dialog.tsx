"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2 } from "lucide-react"
import type { CitaWithContact } from "@/types"

export interface RescheduleDialogProps {
  cita: CitaWithContact | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Reagendar — pick a new start for an existing appointment. */
export function RescheduleDialog({
  cita,
  open,
  onOpenChange,
  onSaved,
}: RescheduleDialogProps) {
  const t = useTranslations("Citas.form")
  const [inicio, setInicio] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open && cita) setInicio(toLocalInput(cita.fecha_inicio))
  }, [open, cita])

  async function handleSubmit() {
    if (!cita || !inicio) return
    setSaving(true)

    const res = await fetch(`/api/calendar/citas/${cita.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nuevoInicio: new Date(inicio).toISOString() }),
    })
    const json = await res.json().catch(() => null)

    if (!res.ok) {
      toast.error(json?.error ?? t("rescheduleToastError"))
      setSaving(false)
      return
    }

    toast.success(t("rescheduleToastSuccess"))
    setSaving(false)
    onSaved()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("rescheduleTitle")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("rescheduleDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label className="text-popover-foreground">{t("dateTimeLabel")}</Label>
          <Input
            type="datetime-local"
            value={inicio}
            onChange={(e) => setInicio(e.target.value)}
            className="bg-card border-border text-foreground"
          />
          <p className="text-xs text-muted-foreground">{t("dateTimeHint")}</p>
        </div>

        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!inicio || saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t("rescheduleSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}