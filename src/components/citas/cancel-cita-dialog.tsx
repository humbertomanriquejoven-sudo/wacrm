"use client"

import { useState } from "react"
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
import { Loader2 } from "lucide-react"
import type { CitaWithContact } from "@/types"

export interface CancelCitaDialogProps {
  cita: CitaWithContact | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

/** Cancelar — delete the remote Google event and mark the row cancelada. */
export function CancelCitaDialog({
  cita,
  open,
  onOpenChange,
  onSaved,
}: CancelCitaDialogProps) {
  const t = useTranslations("Citas.form")
  const [saving, setSaving] = useState(false)

  async function handleDelete() {
    if (!cita) return
    setSaving(true)

    const res = await fetch(`/api/calendar/citas/${cita.id}`, {
      method: "DELETE",
    })
    const json = await res.json().catch(() => null)

    if (!res.ok) {
      toast.error(json?.error ?? t("cancelToastError"))
      setSaving(false)
      return
    }

    toast.success(t("cancelToastSuccess"))
    setSaving(false)
    onSaved()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("cancelTitle")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("cancelDesc", {
              name: cita?.contact?.name ?? cita?.contact?.phone ?? "",
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={saving}
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t("cancelConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}