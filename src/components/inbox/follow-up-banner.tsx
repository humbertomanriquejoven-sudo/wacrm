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
// timers per chat:
//
//   BLOCK 1 — "Seguimiento automático" (Timer 1, the programmed reminder).
//     [ N ] min  [Programar]  [ ON/OFF switch ]
//     `follow_ups.pending` (execute_at) → ⏱️ Próximo seguimiento en: MM:SS.
//     OFF cancels the queued row and the worker refuses to dispatch.
//
//   BLOCK 2 — "Esperar respuesta" (Timer 2, response-wait, ONE-SHOT).
//     [ N ] min  [↻ Reiniciar]
//     `response_wait_timers.active` (started_at + expires_at) → live
//     countdown "MM:SS" rendered INLINE on the same row, right after the
//     controls — it always ticks every second and never hides.
//
//     AUTO (never needs a button):
//       · ANY outbound (agent or bot) with the client silent → auto-arm:
//         `expires_at = NOW() + N` (N = the chat's configured minutes,
//         default 10). An active countdown simply continues.
//       · Client replies → webhook cancels (cancelled_reason='inbound');
//         the row closes as `cancelled` and nothing is sent.
//       · Zero with no reply → the worker sends ONE contextual AI nudge
//         and closes the row as `completed` (single execution). It never
//         re-arms by itself.
//       · After a reply, the next outbound (bot or agent) hands the timer
//         a fresh start automatically.
//     ↻ Reiniciar = cancel the current countdown (same row) and rearm it
//     from the EXACT minutes of the field, without duplicates.
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
type WaitBusy = "wait_reset" | null;

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
}

/** Minutes cap: 7 days, matching the API's own clamp. */
const MAX_MINUTES = 10080;

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
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          toast.error((json?.error as string) ?? t("updateError"));
          return null;
        }
        return json;
      } catch {
        toast.error(t("networkError"));
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
            json.reason === "disabled" ? t("scheduleDisabled") : t("scheduleFailed"),
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
        if (await post("set_enabled", { enabled: checked })) toast.success(t("toggleSuccess"));
        await refresh();
      } finally {
        setBusyFollow(null);
      }
    },
    [post, refresh, t],
  );

  // ---- Timer 2 (esperar respuesta, ONE-SHOT) ------------------------
  // There is NO "▶ Iniciar" button — the timer starts automatically the
  // moment the agent (or bot) sends an outbound message. ↻ Reiniciar is the
  // only control here.
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
        if (json.scheduled === false) toast.error(t("waitFailed"));
        else toast.success(t("waitResetSuccess"));
      }
      await refresh();
    } finally {
      setBusyWait(null);
    }
  }, [waitMinutes, post, refresh, t]);

  if (!status) return null;

  const pending = status.pending[0] ?? null;
  const enabled = status.conversation_enabled !== false;
  const wait = status.response_wait ?? null;
  const waitLast = status.response_wait_last ?? null;

  const followEta = pending ? formatRemaining(pending.execute_at, followNowTs) : null;
  const waitEta = wait ? formatRemaining(wait.expires_at, waitNowTs) : null;

  // One-shot outcome for the wait timer (Escenario A / Escenario B).
  const waitOutcome: "active" | "executed" | "replied" | null = wait
    ? "active"
    : waitLast?.status === "completed"
      ? "executed"
      : waitLast?.status === "cancelled" && waitLast?.cancelled_reason !== "manual"
        ? "replied"
        : null;

  return (
    <div
      className={cn(
        "border-b text-xs",
        pending || wait
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
              pending ? "text-foreground" : "text-transparent",
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

          {waitOutcome === "active" && (
            <span
              className="min-w-[3.5rem] font-mono text-sm tabular-nums text-foreground"
              aria-live="off"
            >
              {waitEta ?? "00:00"}
            </span>
          )}
          {waitOutcome === "executed" && (
            <span className="text-muted-foreground">{t("waitExecuted")}</span>
          )}
          {waitOutcome === "replied" && (
            <span className="text-muted-foreground">{t("waitCancelledByReply")}</span>
          )}
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