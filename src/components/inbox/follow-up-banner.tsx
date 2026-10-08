"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Switch } from "@/components/ui/switch";
import type { FollowUp, ResponseWaitTimer } from "@/types";

// ------------------------------------------------------------------
// Safe response parsing for `/api/whatsapp/follow-ups`. When the backend is
// down (or a proxy like Easypanel answers instead), the response body is an
// HTML error page — `res.json()` would throw. We always read the raw text,
// verify the `Content-Type`, and surface the HTML separately instead of
// letting it render or bubble up as an uncaught parse error.
type SafeFollowUpsBody = { ok: boolean; json: Record<string, unknown>; text: string };

async function parseFollowUpsResponse(res: Response): Promise<SafeFollowUpsBody> {
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  const isJson = ct.includes("application/json") || res.status === 204;
  if (!isJson) {
    console.error(
      "[HTML PROXY ERROR DETECTED]:",
      text || `HTTP ${res.status} with a non-JSON body`,
    );
    return { ok: false, json: {}, text };
  }
  try {
    return {
      ok: true,
      json: ((JSON.parse(text) as Record<string, unknown>) ?? {}) as Record<string, unknown>,
      text,
    };
  } catch {
    console.error(
      "[HTML PROXY ERROR DETECTED]:",
      text || "Empty or invalid JSON body",
    );
    return { ok: false, json: {}, text };
  }
}

// Multi-field error extraction: the backend may answer with `error`,
// `message`, `details` or `err` — ANY of them is shown, so the toast never
// falls back to a generic "Fallo desconocido". A string body wins directly
// (a proxy page while it IS the message), and the HTTP status is the last
// resort.
function extractError(
  data: Record<string, unknown> | null | undefined | string,
  status: number,
): string {
  if (typeof data === "string" && data.trim()) return data;
  const d = (data ?? {}) as Record<string, unknown>;
  return (
    (d.error as string) ||
    (d.message as string) ||
    (d.details as string) ||
    (d.err as string) ||
    `Error HTTP ${status}`
  );
}

// ------------------------------------------------------------------
// Per-conversation timer banner — TWO fully independent, persistent
// timers per chat, each with its OWN ON/OFF switch:
//
//   BLOCK 1 — "Seguimiento automático" (Timer 1, the programmed reminder).
//     [ N ] min  [Programar]  [ ON/OFF switch ]   MM:SS
//     `follow_ups.pending` (execute_at) → inline live countdown.
//     Switch OFF cancels the queued row and the worker refuses to dispatch.
//
//   BLOCK 2 — "Esperar respuesta" (Timer 2, response-wait, ONE-SHOT).
//     [ N ] min  [↻ Reiniciar]  [ ON/OFF switch ]   MM:SS
//     `response_wait_timers.active` (started_at + expires_at) → inline
//     live countdown, ALWAYS visible in its slot (dims when idle); it ticks
//     every second and never hides.
//
//     AUTO (never needs a button):
//       · ONLY while Switch 2 is ON: any outbound (agent or bot) with the
//         client silent → auto-arm: `expires_at = NOW() + N` (N = the
//         chat's configured minutes, default 10). An active countdown
//         simply continues. Turning the switch OFF cancels the countdown
//         and blocks future auto-arms.
//       · Client replies → webhook cancels (cancelled_reason='inbound');
//         the row closes as `cancelled` and nothing is sent. The switch
//         STAYS ON so the next outbound auto-arms a fresh countdown.
//       · Zero with no reply → the worker sends ONE contextual AI nudge,
//         closes the row as `completed` AND flips the switch OFF (single
//         execution — it strictly never re-enters a loop).
//     ↻ Reiniciar = re-enable the switch, cancel any current countdown
//     (same row) and rearm it from the EXACT minutes of the field,
//     without duplicates.
//
//     PERSISTENCE / PER-CHAT ISOLATION — recover, never restart:
//       · Mount / chat switch / tab return / F5 re-READ this chat's state
//         from BD (`GET?conversation_id=…`). Nothing is invented locally:
//         a countdown armed 15 s ago resumes as `N − 15s`, never as a
//         fresh `N:00`.
//       · READS NEVER WRITE — no effect here may create or reset a
//         timestamp in BD. A new `expires_at` only enters BD through an
//         explicit agent action (↻ Reiniciar, [Programar]) or through the
//         send-triggered auto-arm.
//       · No ACTIVE row (the auto-arm never ran for this chat) → the
//         server derives a READ-ONLY anchor (`response_wait_derived` = the
//         last OUTBOUND message + the chat's assigned delay — the same
//         inputs the auto-arm uses), so the slot still shows the TRUE
//         persisted remainder instead of a client-side cycle that would
//         restart on every mount. Thread not waiting (customer already
//         replied / empty chat) or the anchor already elapsed → no anchor
//         → the slot idles at 00:00; a real countdown starts again only
//         on the next outbound or an explicit ↻ Reiniciar.
//       · SERVER CLOCK — remainders are evaluated as
//         `max(0, expires_at − server_now)` (skew captured from each
//         poll), so a drifted laptop clock cannot distort or jump them.
//
// ISOLATION / CORRECTNESS GUARANTEES:
//   * NO shared/global React timer state. Every value is loaded from the
//     server for THIS `conversation_id`. The PARENT does NOT key this
//     component, so switching chats never remounts it — the shell stays
//     fixed in the same DOM slot. Isolation is guaranteed HERE instead:
//     on every `conversationId` change local inputs/counters/busy flags
//     are reset and a guard ensures no stale status from the previous chat
//     is rendered (even for a single frame) while the new chat re-fetches.
//   * Dynamic remainder: the UI ALWAYS computes `expires_at − NOW()` on a
//     per-timer 1-second clock. Switch away for 2 minutes and come back: a
//     5-minute timer honestly shows 3:00, never resets, never borrows
//     another chat's values, and survives an F5 (the row lives in the DB).
//   * The send is triggered by the backend (cron / in-process worker),
//     never by this component — the countdown is display-only.
// ------------------------------------------------------------------

type Busy = "schedule" | "toggle" | null;
type WaitBusy = "wait_toggle" | "wait_reset" | null;

interface WaitLast {
  id?: string;
  conversation_id?: string;
  status?: string;
  cancelled_reason?: string | null;
  /** The chat's last-used duration — the value this conversation is "assigned". */
  delay_minutes?: number;
  updated_at?: string;
}

interface FollowUpStatus {
  pending: (Pick<FollowUp, "id" | "type" | "execute_at"> & { status: string })[];
  response_wait: Pick<
    ResponseWaitTimer,
    "id" | "status" | "delay_minutes" | "started_at" | "expires_at"
  > | null;
  /**
   * READ-ONLY recovery anchor from the server: the remainder this chat
   * WOULD be showing had the auto-arm run (last OUTBOUND message + the
   * chat's assigned delay), but only while it is still in the future and
   * no ACTIVE row exists. Persisted inputs (a message row + the assigned
   * duration) — mounting this component cannot create or move it.
   */
  response_wait_derived: {
    expires_at: string;
    delay_minutes: number;
  } | null;
  response_wait_last: WaitLast | null;
  global_enabled: boolean;
  conversation_enabled: boolean | null;
  /** Timer 2 ON/OFF switch (Switch 2). Worker flips OFF after a 1-shot run. */
  response_wait_enabled: boolean;
  /** Server wall clock of this read — the reference for every remainder. */
  server_now?: string;
}

/** Minutes cap: 7 days, matching the API's own clamp. */
const MAX_MINUTES = 10080;

/**
 * Fallback duration for Timer 2 when neither the box nor the chat's
 * assigned value yields a usable number — the same default the auto-arm
 * uses server-side (`ARM_DEFAULT_MINUTES`).
 */
const DEFAULT_WAIT_MINUTES = 10;

/**
 * Parse the EXACT integer the agent typed. Returns null for an empty or
 * out-of-range box so the caller can refuse rather than silently
 * substituting a default.
 */
function parseMinutes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Math.floor(Number(trimmed));
  if (!Number.isFinite(value) || value < 1 || value > MAX_MINUTES) return null;
  return value;
}

/**
 * Live remainder: `expires_at − now`. Seconds-granular (`09:42` style);
 * hours spill over to `1h 20m 05s`. `00:00` means the moment arrived (the
 * backend delivers/executes and a refresh then clears the active row).
 */
function formatRemaining(expiresAt: string, nowTs: number): string {
  const diff = new Date(expiresAt).getTime() - nowTs;
  if (diff <= 0) return "00:00";
  const totalSec = Math.floor(diff / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s.toString().padStart(2, "0")}s`;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

const INPUT_CLASS =
  "h-6 w-14 rounded-md border border-border bg-card px-1.5 text-center text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-60";

const LABEL_CLASS =
  "inline-flex items-center gap-1.5 font-medium text-foreground";

export function FollowUpBanner({ conversationId }: { conversationId: string }) {
  const t = useTranslations("Inbox.followUp");
  const [status, setStatus] = useState<FollowUpStatus | null>(null);
  const [busyFollow, setBusyFollow] = useState<Busy>(null);
  const [busyWait, setBusyWait] = useState<WaitBusy>(null);
  // Per-conversation inputs, kept as raw strings so each action reads back
  // EXACTLY what was typed. Fresh for every chat (the banner remounts).
  const [followUpMinutes, setFollowUpMinutes] = useState("10");
  const [waitMinutes, setWaitMinutes] = useState("10");
  // The two timers are 100% independent: each gets its OWN 1-second clock,
  // so their ticks, state, and countdown values never share an interval.
  const [followNowTs, setFollowNowTs] = useState(() => Date.now());
  const [waitNowTs, setWaitNowTs] = useState(() => Date.now());
  const mounted = useRef(true);
  // Once the agent types in the box, the server's assigned value stops
  // overriding it (the box is the single source of what they type).
  const waitTouched = useRef(false);
  // One-shot guard per ACTIVE timer id: the moment a countdown hits 00:00,
  // this component POSTs a `process_now` sweep exactly ONCE for that id, so
  // delivery never depends solely on an external cron / in-process tick.
  const firedExpiryRef = useRef<{ follow: string | null; wait: string | null }>({
    follow: null,
    wait: null,
  });
  // Server − client clock offset, captured from each poll's `server_now`.
  // Every remainder below is evaluated against the SERVER's wall clock
  // (`expires_at − (Date.now() + skew)`), so a drifted laptop clock can
  // never distort — or visibly jump — a countdown recovered from BD.
  const [serverSkew, setServerSkew] = useState(0);
  // Last failure of an "Esperar respuesta" action (Timer 2), shown inline on
  // its row. Cleared on any successful reset OR on any healthy server poll —
  // ↻ Reiniciar always wipes a previous error state.
  const [waitError, setWaitError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // When the agent switches conversations the PARENT no longer remounts
  // this banner (no `key` remount), so per-chat isolation is enforced
  // here: reset every local input/counter/busy flag the moment the id
  // changes and re-anchor `lastConvRef` so nothing from the previous chat
  // can be rendered while the new chat's status is being fetched. The
  // re-fetch itself fires from the poll effect below (its `refresh`
  // callback re-creates on `conversationId` change).
  const lastConvRef = useRef(conversationId);
  useEffect(() => {
    lastConvRef.current = conversationId;
    setStatus(null);
    setFollowUpMinutes("10");
    setWaitMinutes("10");
    waitTouched.current = false;
    setWaitError(null);
    setServerSkew(0);
    setBusyFollow(null);
    setBusyWait(null);
  }, [conversationId]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/whatsapp/follow-ups?conversation_id=${encodeURIComponent(conversationId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return null;
      const parsed = await parseFollowUpsResponse(res);
      if (!parsed.ok) return null;
      const j = parsed.json as unknown as FollowUpStatus;
      if (mounted.current) {
        // Re-anchor the countdowns to the SERVER clock (see `server_now`).
        const serverTs =
          typeof j.server_now === "string" ? Date.parse(j.server_now) : NaN;
        if (Number.isFinite(serverTs)) setServerSkew(serverTs - Date.now());
        setStatus(j);
        // A healthy poll means the last failure is stale — drop it so the
        // row returns to the normal countdown/switch UI.
        setWaitError(null);
      }
      return j;
    } catch {
      return null;
    }
  }, [conversationId]);

  // Clock 1 (Timer 1 — Seguimiento automático). Independent interval.
  useEffect(() => {
    const clock = setInterval(() => setFollowNowTs(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);

  // Clock 2 (Timer 2 — Esperar respuesta). Independent interval.
  useEffect(() => {
    const clock = setInterval(() => setWaitNowTs(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);

  // Re-sync BOTH clocks the moment the tab regains focus / user comes back,
  // so a throttled background interval never leaves the countdown looking
  // stale — it recomputes `expires_at − now` from the real wall clock.
  useEffect(() => {
    const resync = () => {
      setFollowNowTs(Date.now());
      setWaitNowTs(Date.now());
    };
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("focus", resync);
    return () => {
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("focus", resync);
    };
  }, []);

  // Re-read the queue so a delivered/executed/cancelled timer (flipped to
  // `completed`/`cancelled` by the worker or the inbound webhook) updates
  // the UI on its own. This is the only cross-timer poll — it only REFRESHES
  // the server state, it never drives a countdown.
  useEffect(() => {
    void refresh();
    const serverRefresh = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(serverRefresh);
  }, [refresh]);

  // Refresh IMMEDIATELY after any send in this thread so an auto-armed
  // "Esperar respuesta" countdown appears without waiting for the poll.
  useEffect(() => {
    const onMessageSent = (e: Event) => {
      const detail = (e as CustomEvent<{ conversationId?: string }>).detail;
      if (detail?.conversationId === conversationId) void refresh();
    };
    window.addEventListener("inbox:message-sent", onMessageSent);
    return () => window.removeEventListener("inbox:message-sent", onMessageSent);
  }, [conversationId, refresh]);

  // Prefill Timer 2's box with the chat's ASSIGNED value (the last-used
  // `delay_minutes` for this conversation) so auto-armed countdowns and the
  // box always agree. Stops as soon as the agent types a custom value.
  useEffect(() => {
    if (!status || waitTouched.current) return;
    const assigned =
      status.response_wait?.delay_minutes ??
      status.response_wait_last?.delay_minutes ??
      DEFAULT_WAIT_MINUTES;
    setWaitMinutes(String(assigned));
  }, [status]);

  const post = useCallback(
    async (action: string, extra: Record<string, unknown>) => {
      try {
        const res = await fetch("/api/whatsapp/follow-ups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversationId,
            action,
            ...extra,
          }),
        });
        const parsed = await parseFollowUpsResponse(res);
        const data = parsed.json as Record<string, unknown>;
        // A JSON error reveals the server's own message; an HTML/non-JSON
        // body is the proxy's "service down" page — never render it as
        // content, always log what actually came back and toast the detail.
        if (!res.ok || !parsed.ok || data.success === false) {
          console.log("[FOLLOW-UP RAW RESPONSE]:", res.status, data);
          console.error("[FOLLOW-UP DETAILED ERROR]:", data);
          toast.error(
            `Error de seguimiento: ${extractError(data, res.status)}`,
          );
          return null;
        }
        return parsed.json;
      } catch {
        toast.error(t("networkError"));
        return null;
      }
    },
    [conversationId, t],
  );

  // 00:00 DISPATCH — a dedicated fetch so any server rejection surfaces
  // VERBATIM in the browser console (the generic `post` swallows the body
  // into a toast). The route is session-authorized (no cron token), so a
  // non-200 here is a real backend failure worth logging with `res.text()`.
  const fireProcessNow = useCallback(async () => {
    // 00:00 VALIDATION — never POST an empty/invalid id: a missing banner id
    // is a mount/state bug, not something the server can fix. Fail visibly.
    if (typeof conversationId !== "string" || !conversationId.trim()) {
      console.error("[FOLLOW-UP TRIGGER] Missing conversation_id — aborting 00:00 dispatch", {
        conversationId,
      });
      toast.error("Error: ID de conversación no encontrado en el banner");
      return;
    }
    try {
      const res = await fetch("/api/whatsapp/follow-ups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          action: "process_now",
        }),
        cache: "no-store",
      });
      const parsed = await parseFollowUpsResponse(res);
      const json = parsed.json as {
        success?: boolean;
        message_id?: string | null;
        sent?: { follow_ups?: number; response_wait?: number };
        error?: string;
      };
      if (!res.ok || !parsed.ok || json.success === false) {
        console.log("[FOLLOW-UP RAW RESPONSE]:", res.status, json);
        console.error("[TRIGGER 00:00 ERROR]:", res.status, parsed.text || "");
        console.error("[FOLLOW-UP DETAILED ERROR]:", json);
        toast.error(
          `Error de seguimiento: ${extractError(json, res.status)}`,
        );
        return;
      }
      if (json.message_id) {
        console.log(
          `[TIMER FIRE] Follow-up dispatched — message_id: ${json.message_id}`,
        );
      } else if (
        json.sent &&
        (json.sent.follow_ups ?? 0) + (json.sent.response_wait ?? 0) === 0
      ) {
        console.warn(
          "[TIMER FIRE] Sweep executed but nothing was delivered to this conversation.",
        );
      }
    } catch (err) {
      console.error("[TRIGGER 00:00 ERROR]:", err);
    }
  }, [conversationId, t]);

  // CLIENT-TRIGGERED DISPATCH: every 1-second clock tick, an ACTIVE timer
  // whose server-derived remainder has reached 00:00 asks the backend to
  // drain the queues (`process_now` — the same idempotent worker the cron
  // runs). Guarded by `firedExpiryRef` so a given row fires only once; once
  // the worker completes/cancels it, the poll refresh removes it from
  // `status` and the effect no-ops. A chat-level or account-level OFF is
  // respected by the runner itself (it cancels instead of sending).
  useEffect(() => {
    if (!status) return;
    const nowMs = Date.now() + serverSkew;
    const pendingRow = status.pending[0] ?? null;
    const waitRow = status.response_wait;
    if (
      pendingRow &&
      Date.parse(pendingRow.execute_at) <= nowMs &&
      firedExpiryRef.current.follow !== pendingRow.id
    ) {
      firedExpiryRef.current.follow = pendingRow.id;
      // The POST carries `{ action: "process_now", conversation_id, … }`
      // (the shared `post` envelope always includes the conversation id) —
      // the backend processes THIS conversation specifically.
      console.log(
        `[FOLLOW-UP TRIGGER] Triggered for conversation ${conversationId} — follow-up ${pendingRow.id} reached 00:00.`,
      );
      void fireProcessNow();
    }
    if (
      waitRow &&
      Date.parse(waitRow.expires_at) <= nowMs &&
      firedExpiryRef.current.wait !== waitRow.id
    ) {
      firedExpiryRef.current.wait = waitRow.id;
      console.log(
        `[FOLLOW-UP TRIGGER] Triggered for conversation ${conversationId} — "Esperar respuesta" timer ${waitRow.id} reached 00:00.`,
      );
      void fireProcessNow();
    }
  }, [status, serverSkew, followNowTs, waitNowTs, fireProcessNow]);

  // ---- Timer 1 (seguimiento automático) -----------------------------
  const scheduleFollowUp = useCallback(async () => {
    const value = parseMinutes(followUpMinutes);
    if (value === null) {
      toast.error(t("invalidMinutes"));
      return;
    }
    setBusyFollow("schedule");
    try {
      const json = await post("schedule", { delay_minutes: value });
      if (json) {
        if (json.scheduled === false) {
          toast.error(
            json.reason === "disabled"
              ? t("scheduleDisabled")
              : t("scheduleFailed"),
          );
        } else {
          toast.success(t("scheduleSuccess"));
          // The work ran through the central dispatcher and shaped the
          // follow_ups row; a FRESH 00:00 must be able to trigger again, so
          // drop the once-per-row guard (a reschedule may reuse the SAME row
          // id, which previously blocked the second fire).
          firedExpiryRef.current.follow = null;
        }
      }
      await refresh();
    } finally {
      setBusyFollow(null);
    }
  }, [followUpMinutes, post, refresh, t]);

  const toggleEnabled = useCallback(
    async (checked: boolean) => {
      setBusyFollow("toggle");
      try {
        // OPTIMISTIC: flip the switch and the ACTIVO/INACTIVO label
        // immediately, so a click never leaves the banner looking "stuck"
        // on the old state while the POST round-trips (or waits out a
        // refresh). `refresh()` below reconciles with the server truth.
        setStatus((s) => (s ? { ...s, conversation_enabled: checked } : s));
        if (await post("set_enabled", { enabled: checked }))
          toast.success(t("toggleSuccess"));
        await refresh();
      } finally {
        setBusyFollow(null);
      }
    },
    [post, refresh, t],
  );

  // ---- Timer 2 (esperar respuesta, ONE-SHOT) ------------------------
  // There is NO "▶ Iniciar" button — the timer starts automatically the
  // moment the agent (or bot) sends an outbound message WHILE Switch 2 is
  // ON. Switch 2 is the master ON/OFF for this feature; ↻ Reiniciar is the
  // manual re-arm control (and re-enables the switch).
  const toggleWaitEnabled = useCallback(
    async (checked: boolean) => {
      setBusyWait("wait_toggle");
      try {
        // OPTIMISTIC, mirroring the server's side effects: OFF also cancels
        // the running countdown (the route cancels ACTIVE timers).
        setStatus((s) =>
          s
            ? {
                ...s,
                response_wait_enabled: checked,
                response_wait: checked ? s.response_wait : null,
              }
            : s,
        );
        if (await post("wait_enabled", { enabled: checked })) {
          if (checked) toast.success(t("waitEnabledSuccess"));
          else toast.success(t("waitDisabledSuccess"));
        }
        await refresh();
      } finally {
        setBusyWait(null);
      }
    },
    [post, refresh, t],
  );

  const resetWait = useCallback(async () => {
    const value = parseMinutes(waitMinutes);
    if (value === null) {
      toast.error(t("invalidMinutes"));
      return;
    }
    setBusyWait("wait_reset");
    try {
      // Reiniciar = cancelar cualquier cuenta regresiva en curso y rearmar
      // desde los minutos EXACTOS del campo. El servidor hace un único
      // UPSERT (una sola fila ACTIVE por conversación), así que no puede
      // generar duplicados ni ejecuciones dobles.
      const json = await post("wait_reset", { delay_minutes: value });
      if (json) {
        if (json.scheduled === false) {
          console.error(
            "[RESET BUTTON ERROR]: could not reset the timer for conversation",
            conversationId,
            JSON.stringify(json),
          );
          setWaitError((json.error as string) ?? t("waitFailed"));
          toast.error((json.error as string) ?? t("waitFailed"));
        } else {
          setWaitError(null);
          toast.success(t("waitResetSuccess"));
          // OPTIMISTIC: show the fresh full-minutes countdown NOW (from the
          // server's own `expires_at` + `delay_minutes`) and flip Switch 2
          // to ACTIVO immediately, so the reset is visible on the very
          // click instead of after a round-trip. `refresh()` reconciles.
          const expiresAt =
            typeof json.expires_at === "string"
              ? json.expires_at
              : new Date(Date.now() + value * 60_000).toISOString();
          setStatus((s) =>
            s
              ? {
                  ...s,
                  response_wait_enabled: true,
                  response_wait: {
                    id: typeof json.id === "string" ? json.id : "wait-pending",
                    status: "active",
                    delay_minutes: value,
                    started_at: new Date().toISOString(),
                    expires_at: expiresAt,
                  },
                }
              : s,
          );
          // ↻ Reiniciar = a brand-new cycle: the once-per-row trigger guard
          // must not survive it, or the next 00:00 would be swallowed by
          // the previous (fired) row's id.
          firedExpiryRef.current.wait = null;
        }
      }
      await refresh();
    } finally {
      setBusyWait(null);
    }
  }, [waitMinutes, post, refresh, t]);

  // The shell NEVER leaves the DOM — no `return null` while loading, so the
  // banner stays fixed in the layout. Isolation across chats: only render a
  // conversation's status once `lastConvRef` has caught up to the id this
  // render is for, so a stale status can't flash for a frame. While loading
  // the shell renders with every control disabled and the switches safely
  // OFF (never falsely implying an active timer).
  const loading = lastConvRef.current !== conversationId || !status;
  const pending = loading ? null : (status.pending[0] ?? null);
  const enabled = loading ? false : status.conversation_enabled !== false;
  const waitEnabled = loading ? false : status.response_wait_enabled !== false;
  const wait = loading ? null : (status.response_wait ?? null);

  // The ACTIVE BD row is always the source of truth (it is the row the
  // worker fires). Without one, the server-derived anchor keeps the slot
  // counting the TRUE persisted remainder while Switch 2 is ON — it comes
  // from data that did NOT change by merely mounting this component, so
  // leaving the chat and coming back resumes the same value. Switch OFF →
  // nothing to show. Remainders run on the SERVER clock (`serverSkew`).
  const waitTimer = wait ?? (waitEnabled ? (status?.response_wait_derived ?? null) : null);

  const followEta = pending
    ? formatRemaining(pending.execute_at, followNowTs + serverSkew)
    : null;
  const waitEta = waitTimer
    ? formatRemaining(waitTimer.expires_at, waitNowTs + serverSkew)
    : null;

  return (
    <div
      className={cn(
        "border-b text-xs",
        pending || wait || waitTimer
          ? "border-primary/20 bg-primary/5"
          : "border-border bg-muted/40",
      )}
    >
      <div className="space-y-1.5 px-3 py-2 sm:px-4">
        {/* ─── Fila 1: Seguimiento automático ─────────────────────── */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className={LABEL_CLASS}>
            <span>{t("followRowLabel")}</span>
          </span>

          <input
            type="number"
            min={1}
            max={MAX_MINUTES}
            inputMode="numeric"
            value={followUpMinutes}
            onChange={(e) => setFollowUpMinutes(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void scheduleFollowUp();
            }}
            disabled={!enabled || busyFollow === "schedule"}
            aria-label={t("customMinutes")}
            className={INPUT_CLASS}
          />
          <span className="text-muted-foreground">{t("minutesUnit")}</span>
          <BannerButton
            onClick={() => void scheduleFollowUp()}
            busy={busyFollow === "schedule"}
            disabled={!enabled}
            icon={Plus}
          >
            {t("scheduleTimer")}
          </BannerButton>

          <span
            className={cn(
              "min-w-[3.5rem] font-mono text-sm tabular-nums",
              pending ? "text-foreground" : "text-muted-foreground",
            )}
            aria-live="off"
          >
            {loading ? "…" : (followEta ?? "00:00")}
          </span>

          <span className="ml-auto flex items-center gap-1.5">
            <span
              className={cn(
                "font-semibold",
                enabled
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground",
              )}
            >
              {enabled ? t("active") : t("inactive")}
            </span>
            <Switch
              checked={enabled}
              onCheckedChange={(checked: boolean) => void toggleEnabled(checked)}
              disabled={loading || busyFollow === "toggle"}
            />
          </span>
        </div>

        {/* ─── Fila 2: Esperar respuesta (ONE-SHOT) ────────────────── */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className={LABEL_CLASS}>
            <span>{t("waitRowLabel")}</span>
          </span>

          <input
            type="number"
            min={1}
            max={MAX_MINUTES}
            inputMode="numeric"
            value={waitMinutes}
            onChange={(e) => {
              waitTouched.current = true;
              setWaitMinutes(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void resetWait();
            }}
            disabled={loading || busyWait !== null}
            aria-label={t("customMinutes")}
            className={INPUT_CLASS}
          />
          <span className="text-muted-foreground">{t("minutesUnit")}</span>
          <BannerButton
            onClick={() => void resetWait()}
            busy={busyWait === "wait_reset"}
            disabled={loading}
            icon={RotateCcw}
          >
            {t("waitReset")}
          </BannerButton>

          <span
            className={cn(
              "min-w-[3.5rem] font-mono text-sm tabular-nums",
              waitTimer && waitEnabled ? "text-foreground" : "text-muted-foreground",
            )}
            aria-live="off"
          >
            {loading ? "…" : (waitEta ?? "00:00")}
          </span>

          <span className="ml-auto flex items-center gap-1.5">
            <span
              className={cn(
                "font-semibold",
                waitEnabled
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground",
              )}
            >
              {waitEnabled ? t("active") : t("inactive")}
            </span>
            <Switch
              checked={waitEnabled}
              onCheckedChange={(checked: boolean) => void toggleWaitEnabled(checked)}
              disabled={loading || busyWait === "wait_toggle"}
            />
          </span>
        </div>

        {/* Last "Esperar respuesta" failure (e.g. the timer could not be
            started). ↻ Reiniciar / a healthy poll clears it immediately. */}
        {waitError ? (
          <p
            className="text-[11px] font-medium text-red-600 dark:text-red-400"
            role="alert"
          >
            {waitError}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function BannerButton({
  onClick,
  busy,
  disabled = false,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  disabled?: boolean;
  icon: typeof Plus;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
      {children}
    </button>
  );
}