"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createClient } from "@/lib/supabase/client"
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
import { Textarea } from "@/components/ui/textarea"
import { Loader2, Search, UserRound } from "lucide-react"
import type { Contact } from "@/types"

export interface CitaFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** First-load focus: use for a "new on this date" flow from the calendar. */
  defaultInicio?: string
  onSaved: () => void
}

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function CitaFormDialog({
  open,
  onOpenChange,
  defaultInicio,
  onSaved,
}: CitaFormDialogProps) {
  const t = useTranslations("Citas.form")
  const supabase = createClient()

  const [search, setSearch] = useState("")
  const [results, setResults] = useState<Contact[]>([])
  const [selected, setSelected] = useState<Contact | null>(null)
  const [inicio, setInicio] = useState("")
  const [motivo, setMotivo] = useState("")
  const [saving, setSaving] = useState(false)
  const [searching, setSearching] = useState(false)
  const searchSeq = useRef(0)

  useEffect(() => {
    if (open) {
      setInicio(defaultInicio ?? "")
      setMotivo("")
      setSelected(null)
      setSearch("")
      setResults([])
    }
  }, [open, defaultInicio])

  // Search live as the user types: name or phone substring, top 8.
  const runSearch = useCallback(
    async (term: string) => {
      const seq = ++searchSeq.current
      setSearching(true)
      const like = `%${term}%`
      let query = supabase
        .from("contacts")
        .select("id, name, phone, email")
        .order("created_at", { ascending: false })
        .limit(8)
      if (term.trim()) {
        query = query.or(`name.ilike.${like},phone.ilike.${like}`)
      }
      const { data } = await query
      if (seq !== searchSeq.current) return // superseded
      setResults((data ?? []) as Contact[])
      setSearching(false)
    },
    [supabase],
  )

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    runSearch(search)
  }, [open, search, runSearch])

  async function handleSubmit() {
    if (!selected || !inicio) return
    setSaving(true)

    const res = await fetch("/api/calendar/citas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contactId: selected.id,
        inicio: new Date(inicio).toISOString(),
        motivo: motivo.trim() || undefined,
      }),
    })
    const json = await res.json().catch(() => null)

    if (!res.ok) {
      toast.error(json?.error ?? t("toastError"))
      setSaving(false)
      return
    }

    toast.success(t("toastSuccess"))
    setSaving(false)
    onSaved()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("newTitle")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("newDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Contact picker */}
          <div className="space-y-1.5">
            <Label className="text-popover-foreground">{t("contactLabel")}</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("contactPlaceholder")}
                className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            {searching ? (
              <div className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t("searching")}
              </div>
            ) : results.length === 0 ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">{t("noContactsFound")}</p>
            ) : (
              <ul className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-border bg-card p-1">
                {results.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(c)
                        setSearch(c.name ?? c.phone)
                        setResults([])
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                        selected?.id === c.id
                          ? "bg-primary/10 text-primary"
                          : "text-popover-foreground hover:bg-muted"
                      }`}
                    >
                      <UserRound className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate font-medium">
                        {c.name || <span className="text-muted-foreground italic">-</span>}
                      </span>
                      {c.phone && (
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {c.phone}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {selected && !searching && results.length === 0 && (
              <p className="text-xs text-muted-foreground px-1">
                {t("phoneOfSelected", { phone: selected.phone ?? "-" })}
              </p>
            )}
          </div>

          {/* Date + time */}
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

          {/* Motivo */}
          <div className="space-y-1.5">
            <Label className="text-popover-foreground">{t("motivoLabel")}</Label>
            <Textarea
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder={t("motivoPlaceholder")}
              className="bg-card border-border text-foreground placeholder:text-muted-foreground"
              rows={2}
            />
          </div>
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
            disabled={!selected || !inicio || saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}