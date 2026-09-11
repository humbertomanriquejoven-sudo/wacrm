// DateTime formatting helpers shared by the Agenda / Calendario views.
// All appointments are stored as timestamptz (UTC); the UI always
// renders them in the browser's local timezone.

/** e.g. "Sep 11, 2026, 9:00 AM" */
export function formatCitaDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "-"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d)
}

/** Short time-of-day only, e.g. "9:00 AM". */
export function formatCitaTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "-"
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(d)
}

/** Local YYYY-MM-DD key for grouping appointments by calendar day. */
export function citaDayKey(iso: string): string {
  const d = new Date(iso)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  return `${y}-${m}-${String(d.getDate()).padStart(2, "0")}`
}