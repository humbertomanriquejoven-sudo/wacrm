"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import type { CitaWithContact } from "@/types"

/**
 * Load every appointment for the caller's account (RLS-scoped), with the
 * related contact hydrated. Rows are sorted by start time ascending.
 *
 * The dashboard doesn't paginate — appointment volumes are small — but the
 * stale-fetch guard from the contacts page is kept so rapid refreshes can't
 * render out-of-order data.
 */
export function useCitas() {
  const supabase = createClient()
  const [citas, setCitas] = useState<CitaWithContact[]>([])
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    const s = ++seq.current
    setLoading(true)
    const { data, error } = await supabase
      .from("citas")
      .select("*, contact:contacts(id, name, phone, email)")
      .order("fecha_inicio", { ascending: true })
    if (s !== seq.current) return // superseded by a newer fetch
    if (!error) setCitas((data ?? []) as CitaWithContact[])
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
  }, [refresh])

  return { citas, loading, refresh }
}