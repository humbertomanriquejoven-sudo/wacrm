"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BellOff,
  Check,
  Clock,
  Loader2,
  Plus,
  RotateCcw,
  Timer as TimerIcon,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Switch } from "@/components/ui/switch";
import type { FollowUp, ResponseWaitTimer } from "@/types";

// ------------------------------------------------------------------
// Per-conversation timer banner — TWO fully independent, persistent
// timers per chat:
//
//   ROW 1 — Follow-up (Timer 1, the classic programmed reminder).
//     [ N ] min  [Schedule]  [ ON/OFF switch ]
//     `follow_ups.pending` (execute_at) drives the live countdown.
//     OFF cancels the queued row and the worker refuses to dispatch.
//
//   ROW 2 — Wait Reply (Timer 2, response-wait, auto-cancelable).
//     [ N ] min  [Start]  [Reset]  [Cancel]
//     `response_wait_timers.active` (started_at + expires_at) drives the
//     live countdown. The FIRST inbound message from the customer
//     cancels it server-side (webhook), so no follow-up is ever sent to
//     someone who answered. On expiry the worker sends a contextual AI
//     nudge. Reset cancels the current countdown and re-arms it from the
//     exact minutes currently typed.
//
// ISOLATION / CORRECTNESS GUARANTEES:
//   * NO shared/global React timer state. Every value is loaded from the
//     server for THIS `conversation_id` and re-read on every refresh.
//     The parent keys the banner by conversation (`key={conversation.id}`)
//     so switching chats unmounts/remounts it — local inputs can never
//     leak from Chat A into Chat B.
//   * Dynamic remainder: the UI ALWAYS computes `expires_at − NOW()` from
//     a 1-second clock. Switch away for 2 minutes and come back: a 5-minute
//     timer honestly shows 3:00, never resets, never borrows Chat B's values.
//   * The send itself is triggered by the backend (cron or the in-process
//     worker in `src/instrumentation.ts`), never by this component — the
//     countdown is display-only, so closing the tab never loses a timer.
// ------------------------------------------------------------------

type Busy = "cancel" | "schedule" | "toggle" | null;
type WaitBusy = "wait_set" | "wait_reset" | "wait_cancel" | null;

interface FollowUpStatus {
  pending: (Pick<FollowUp, "id" | "type" | "execute_at"> & { status: string })[];
  response_wait: Pick<
    ResponseWaitTimer,
    "id" | "status" | "delay_minutes" | "started_at" | "expires_at"
  > | null;
  global_enabled: boolean;
  conversation_enabled: boolean | null;
}

/** Minutes cap: 7 days, matching the API's own clamp. */
const MAX_MINUTES = 10080;

/**
 * Parse the EXACT integer the agent typed. Returns null for an empty or
 * out-of-range box so the caller can refuse rather than silently
 * substituting a default — see the spec: no cached/fallback values.
 */
function parseMinutes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Math.floor(Number(trimmed));
  if (!Number.isFinite(value) || value < 1 || value > MAX_MINUTES) return null;
  return value;
}

/**
 * Live remainder: `expires_at − now`. Seconds-granular (`3:00` style);
 * hours spill over to `1h 20m 05s`. `00:00` means the moment arrived (the
 * backend worker delivers and a refresh then clears the row).
 */
function formatRemaining(expiresAt: string, nowTs: number): string {
  const diff = new Date(expiresAt).getTime() - nowTs;
  if (diff <= 0) return "00:00";
  const totalSec = Math.floor(diff / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s.toString().padStart(2, "0")}s`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const INPUT_CLASS =
  "h-6 w-14 rounded-md border border-border bg-card px-1.5 text-center text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-60";

export function FollowUpBanner({ conversationId }: { conversationId: string }) {
  const t = useTranslations("Inbox.followUp");
  const [status, setStatus] = useState<FollowUpStatus | null>(null);
  const [busyFollow, setBusyFollow] = useState<Busy>(null);
  const [busyWait, setBusyWait] = useState<WaitBusy>(null);
  // Per-conversation inputs, kept as raw strings so each action reads back
  // EXACTLY what was typed. Fresh for every chat (the banner remounts).
  const [followUpMinutes, setFollowUpMinutes] = useState("10");
  const [waitMinutes, setWaitMinutes] = useState("10");
  // 1-second clock → the countdown is always `expires_at − NOW()`.
  const [nowTs, setNowTs] = useState(() => Date.now());
  const mounted = useRef(true);

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

  useEffect(() => {
    void refresh();
    // 1s tick keeps BOTH countdowns honest (`expires_at − now`).
    const clock = setInterval(() => setNowTs(Date.now()), 1000);
    // Re-read the queue so a delivered timer (flipped to completed/
    // cancelled by the worker or the inbound webhook) disappears locally.
    const serverRefresh = setInterval(() => void refresh(), 30_000);
    return () => {
      clearInterval(clock);
      clearInterval(serverRefresh);
    };
  }, [refresh]);

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

  // ---- Timer 1 (follow-up) handlers ---------------------------------
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
          // Backend refused (chat switched OFF mid-flight, or a DB error).
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

  const cancelFollowUp = useCallback(async () => {
    setBusyFollow("cancel");
    try {
      if (await post("cancel", {})) toast.success(t("cancelSuccess"));
      await refresh();
    } finally {
      setBusyFollow(null);
    }
  }, [post, refresh, t]);

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

  // ---- Timer 2 (wait reply) handlers --------------------------------
  const startWait = useCallback(async () => {
    const value = parseMinutes(waitMinutes);
    if (value === null) {
      toast.error(t("invalidMinutes"));
      return;
    }
    setBusyWait("wait_set");
    try {
      const json = await post("wait_schedule", { delay_minutes: value });
      if (json) {
        if (json.scheduled === false) toast.error(t("waitFailed"));
        else toast.success(t("waitScheduledSuccess"));
      }
      await refresh();
    } finally {
      setBusyWait(null);
    }
  }, [waitMinutes, post, refresh, t]);

  const resetWait = useCallback(async () => {
    const value = parseMinutes(waitMinutes);
    if (value === null) {
      toast.error(t("invalidMinutes"));
      return;
    }
    setBusyWait("wait_reset");
    try {
      // Reset = cancel the current countdown, then re-arm from the box's
      // exact value. One UPSERT on the server — no duplicates.
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

  const cancelWait = useCallback(async () => {
    setBusyWait("wait_cancel");
    try {
      if (await post("wait_cancel", {})) toast.success(t("waitCancelledSuccess"));
      await refresh();
    } finally {
      setBusyWait(null);
    }
  }, [post, refresh, t]);

  if (!status) return null;

  const pending = status.pending[0] ?? null;
  const enabled = status.conversation_enabled !== false;
  const wait = status.response_wait ?? null;

  const followEta = pending ? formatRemaining(pending.execute_at, nowTs) : null;
  const waitEta = wait ? formatRemaining(wait.expires_at, nowTs) : null;

  return (
    <div
      className={cn(
        "border-b px-3 py-2 text-xs sm:px-4",
        pending || wait
          ? "border-primary/20 bg-primary/5"
          : "border-border bg-muted/40",
      )}
    >
      {/* Row 1 — Follow-up (Timer 1) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          {enabled ? (
            <Clock
              className={cn(
                "h-3.5 w-3.5 flex-shrink-0",
                pending ? "text-primary" : "text-muted-foreground",
              )}
            />
          ) : (
            <BellOff className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          )}
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
          icon={pending ? Check : Plus}
        >
          {t("scheduleTimer")}
        </BannerButton>
        {pending && (
          <BannerButton
            onClick={() => void cancelFollowUp()}
            busy={busyFollow === "cancel"}
            icon={X}
          >
            {t("cancel")}
          </BannerButton>
        )}

        <span className="ml-auto flex items-center gap-1.5">
          <span
            className={cn(
              "font-semibold",
              enabled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
            )}
          >
            {enabled ? t("active") : t("paused")}
          </span>
          <Switch
            checked={enabled}
            onCheckedChange={(checked: boolean) => void toggleEnabled(checked)}
            disabled={busyFollow === "toggle"}
          />
        </span>

        <span className="truncate text-muted-foreground">
          {!enabled ? (
            t("off")
          ) : pending ? (
            <>
              {pending.type === "24h" ? t("pending24hTitle") : t("pending10mTitle")}
              <span className="ml-1.5 font-mono tabular-nums">· {followEta}</span>
            </>
          ) : (
            t("none")
          )}
        </span>
      </div>

      {/* Row 2 — Wait Reply (Timer 2) */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <TimerIcon
            className={cn(
              "h-3.5 w-3.5 flex-shrink-0",
              wait ? "text-primary" : "text-muted-foreground",
            )}
          />
          <span>{t("waitRowLabel")}</span>
        </span>

        <input
          type="number"
          min={1}
          max={MAX_MINUTES}
          inputMode="numeric"
          value={waitMinutes}
          onChange={(e) => setWaitMinutes(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void startWait();
          }}
          disabled={busyWait !== null}
          aria-label={t("customMinutes")}
          className={INPUT_CLASS}
        />
        <span className="text-muted-foreground">{t("minutesUnit")}</span>
        <BannerButton
          onClick={() => void startWait()}
          busy={busyWait === "wait_set"}
          icon={Plus}
        >
          {t("waitStart")}
        </BannerButton>
        <BannerButton
          onClick={() => void resetWait()}
          busy={busyWait === "wait_reset"}
          icon={RotateCcw}
        >
          {t("waitReset")}
        </BannerButton>
        {wait && (
          <BannerButton
            onClick={() => void cancelWait()}
            busy={busyWait === "wait_cancel"}
            icon={X}
          >
            {t("waitCancel")}
          </BannerButton>
        )}

        <span className="truncate text-muted-foreground">
          {wait ? (
            <>
              {t("waitScheduled")}
              <span className="ml-1.5 font-mono tabular-nums">· {waitEta}</span>
            </>
          ) : (
            t("waitNone")
          )}
        </span>
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