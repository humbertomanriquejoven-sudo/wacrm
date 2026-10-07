"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Switch } from "@/components/ui/switch";
import type { FollowUp, ResponseWaitTimer } from "@/types";

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
//     SELF-HEAL / NEVER STUCK AT 00:00 — Switch 2 says ACTIVO but the row
//     is missing (never armed, just toggled ON, worker closed it, a stale
//     row whose expiry already passed…), so there is no `expires_at` to
//     count down from. The banner then:
//       1. starts a CLIENT-SIDE countdown of `NOW() + N` immediately, so
//          the slot counts `N:00 → N-1:00 …` instead of sitting on 00:00;
//       2. asks the server (`wait_autoinit`) to turn it into a REAL row.
//          The route only writes when firing it would be correct: switch
//          ON, no cycle in flight, and the thread actually waiting on the
//          customer. Otherwise (`not_awaiting`, `processing`, `disabled`)
//          the local countdown keeps ticking display-only — a timer must
//          never nudge a customer who already replied, and must never
//          stack behind the worker's one-shot dispatch. One attempt per
//          countdown cycle (never a tight retry loop), no error toasts.
//
// ISOLATION / CORRECTNESS GUARANTEES:
//   * NO shared/global React timer state. Every value is loaded from the
//     server for THIS `conversation_id`; the parent keys the banner by
//     conversation (`key={conversation.id}`) so switching chats cannot
//     leak inputs or counters between conversations.
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
  response_wait_last: WaitLast | null;
  global_enabled: boolean;
  conversation_enabled: boolean | null;
  /** Timer 2 ON/OFF switch (Switch 2). Worker flips OFF after a 1-shot run. */
  response_wait_enabled: boolean;
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
 * Grace period before an ACTIVE row whose `expires_at` already passed is
 * considered STALE for display. The worker closes a due row within seconds
 * (claim → dispatch → close), so a row lingering past this window means the
 * cycle is mid-flight or the sweep is down — either way it must stop
 * pinning the countdown at 00:00 while Switch 2 says ACTIVO.
 */
const STALE_MS = 10_000;

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

/**
 * Expiry of a BD countdown that is still worth rendering, or `NaN`.
 *
 * A row is live while `expires_at` is in the future; one that just expired
 * stays live for `STALE_MS` (the worker is claiming/closing it — showing
 * `00:00` for those seconds is honest), and beyond that it is STALE: the
 * caller must stop rendering it so a dead row cannot pin the slot at 00:00
 * while the switch says ACTIVO. A missing/invalid timestamp is never live.
 */
function liveWaitExpiry(
  wait: { expires_at?: string | null } | null | undefined,
  nowTs: number,
): number {
  const expiry = wait?.expires_at ? Date.parse(wait.expires_at) : NaN;
  if (!Number.isFinite(expiry)) return NaN;
  return expiry > nowTs - STALE_MS ? expiry : NaN;
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
  // CLIENT-SIDE fallback countdown for Timer 2 (the self-heal above): what
  // the slot shows while Switch 2 is ACTIVO but there is no usable ACTIVE
  // row in BD. Created/renewed by the keeper effect below, never rendered
  // while a real row is live (BD wins), and dropped when the switch goes
  // OFF. It is display-only state: the real timer is the server row.
  const [localWait, setLocalWait] = useState<{
    expires_at: string;
    delay_minutes: number;
  } | null>(null);
  // `expires_at` of the countdown cycle we already asked the server to
  // persist — one `wait_autoinit` per cycle, so a refusal (or a network
  // error) degrades to "keep counting locally" instead of hammering the API.
  const autoInitFor = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/whatsapp/follow-ups?conversation_id=${encodeURIComponent(conversationId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return null;
      const j = (await res.json()) as FollowUpStatus;
      if (mounted.current) setStatus(j);
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
      10;
    setWaitMinutes(String(assigned));
  }, [status]);

  const post = useCallback(
    async (
      action: string,
      extra: Record<string, unknown>,
      // Background calls (the auto-init self-heal) stay silent: a refused
      // arm is an expected outcome there — the local countdown keeps
      // ticking — and must not pop an error toast at the agent.
      opts?: { silent?: boolean },
    ) => {
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
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          if (!opts?.silent) {
            toast.error((json?.error as string) ?? t("updateError"));
          }
          return null;
        }
        return json;
      } catch {
        if (!opts?.silent) toast.error(t("networkError"));
        return null;
      }
    },
    [conversationId, t],
  );

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
              : json.reason === "not_handle"
                ? t("noHandle")
                : t("scheduleFailed"),
          );
        } else {
          toast.success(t("scheduleSuccess"));
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
          toast.error(t("waitFailed"));
        } else {
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
          // The real row owns the countdown again — drop the local
          // fallback so the keeper below re-evaluates from BD truth.
          setLocalWait(null);
          autoInitFor.current = null;
        }
      }
      await refresh();
    } finally {
      setBusyWait(null);
    }
  }, [waitMinutes, post, refresh, t]);

  // ── Timer 2 keeper: ACTIVO must never sit on 00:00 ──────────────
  // Runs on the 1-second clock (`waitNowTs`) so a countdown that runs out
  // restarts (or gets replaced by a real BD row) without any user action.
  useEffect(() => {
    if (!status) return;

    // Switch 2 OFF → no countdown at all (and no stale local leftover).
    if (status.response_wait_enabled === false) {
      setLocalWait(null);
      autoInitFor.current = null;
      return;
    }

    // A real, unexpired BD row owns the slot: it is the one that fires.
    if (Number.isFinite(liveWaitExpiry(status.response_wait, waitNowTs))) {
      return;
    }

    // Minutes for this cycle: EXACTLY what the box shows — the agent's
    // typed value once they touched it, otherwise the chat's assigned
    // duration (the value the box is prefilled with), else the default.
    const assigned =
      status.response_wait?.delay_minutes ??
      status.response_wait_last?.delay_minutes ??
      DEFAULT_WAIT_MINUTES;
    const minutes = waitTouched.current
      ? (parseMinutes(waitMinutes) ?? assigned)
      : assigned;

    let cycle: string;
    if (localWait && Date.parse(localWait.expires_at) > waitNowTs) {
      // Still counting — never restart a running countdown on a refresh.
      cycle = localWait.expires_at;
    } else {
      // (Re)start from NOW + N; the render turns it into `max(0, expires −
      // now)` → MM:SS, ticked every second by clock 2.
      cycle = new Date(waitNowTs + minutes * 60_000).toISOString();
      setLocalWait({ expires_at: cycle, delay_minutes: minutes });
    }

    // Turn it into a REAL timer — one attempt per countdown cycle, and
    // never while an explicit ↻ Reiniciar / toggle round-trip is in
    // flight (those paths arm the row themselves; the refresh() below
    // reconciles). A refused arm (`not_awaiting` / `processing` /
    // `disabled`) simply stays display-only until the next cycle.
    //
    // A nudge that already FAILED to dispatch is terminal for the worker
    // (`no_response` — it never retries a failed send): queueing a fresh
    // row from here would turn that terminal state into an every-cycle
    // retry loop. ↻ Reiniciar stays the explicit way to try again.
    const failedSend = status.response_wait_last?.status === "no_response";
    if (failedSend || busyWait !== null || autoInitFor.current === cycle) return;
    autoInitFor.current = cycle;
    void (async () => {
      await post("wait_autoinit", { delay_minutes: minutes }, { silent: true });
      await refresh();
    })();
  }, [
    status,
    localWait,
    waitNowTs,
    waitMinutes,
    busyWait,
    post,
    refresh,
  ]);

  if (!status) return null;

  const pending = status.pending[0] ?? null;
  const enabled = status.conversation_enabled !== false;
  const waitEnabled = status.response_wait_enabled !== false;
  const wait = status.response_wait ?? null;

  // BD row wins while it is live. A row whose expiry is already STALE (the
  // worker is mid-dispatch or the sweep is down) or a missing row falls
  // back to the client-side countdown while the switch is ACTIVO, so the
  // slot counts down instead of freezing on 00:00. Switch OFF → only a
  // real BD row renders (dimmed), as before.
  const waitLive = Number.isFinite(liveWaitExpiry(wait, waitNowTs));
  const waitTimer = wait && waitLive ? wait : waitEnabled ? localWait : null;

  const followEta = pending ? formatRemaining(pending.execute_at, followNowTs) : null;
  const waitEta = waitTimer ? formatRemaining(waitTimer.expires_at, waitNowTs) : null;

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
            {followEta ?? "00:00"}
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
              disabled={busyFollow === "toggle"}
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
            disabled={busyWait !== null}
            aria-label={t("customMinutes")}
            className={INPUT_CLASS}
          />
          <span className="text-muted-foreground">{t("minutesUnit")}</span>
          <BannerButton
            onClick={() => void resetWait()}
            busy={busyWait === "wait_reset"}
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
            {waitEta ?? "00:00"}
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
              disabled={busyWait === "wait_toggle"}
            />
          </span>
        </div>
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