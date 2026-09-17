"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Plus } from "lucide-react"
import { GatedButton } from "@/components/ui/gated-button"
import { CitaFormDialog } from "@/components/citas/cita-form-dialog"
import { useCan } from "@/hooks/use-can"

/**
 * Header actions for the weekly calendar: the "Nueva cita" button plus
 * the create dialog. Kept as a tiny client island so the rest of the
 * page stays a Server Component; after a save we router.refresh() to
 * re-render the server grid with the new row.
 */
export function CalendarioAcciones() {
  const router = useRouter()
  const canEdit = useCan("send-messages")
  const [open, setOpen] = useState(false)

  return (
    <>
      <GatedButton
        canAct={canEdit}
        gateReason="book appointments"
        onClick={() => setOpen(true)}
        className="bg-primary hover:bg-primary/90 text-primary-foreground"
      >
        <Plus className="size-4" />
        Nueva cita
      </GatedButton>
      <CitaFormDialog
        open={open}
        onOpenChange={setOpen}
        onSaved={() => router.refresh()}
      />
    </>
  )
}