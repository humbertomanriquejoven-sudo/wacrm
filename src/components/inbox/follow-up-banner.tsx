"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, Loader2, BellOff, Check, X, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Switch } from "@/components/ui/switch";
import type { FollowUp } from "@/types";

// ------------------------------------------------------------------
// Follow-up banner — CRM visibility AND manual control for the timed
// reminders.
//
// The runner itself is service-role; this banner reads and manages the
// queue through /api/whatsapp/follow-ups with normal dashboard auth. The
// agent can:
//   * see the pending reminder and its live countdown,
//   * type ANY number of minutes (1, 3, 7, 12, …) and press "Set", which
//     writes `execute_at = now + N min` for this thread,
//   * cancel the pending reminder,
//   * flip the per-chat automatic switch inline.
//
// The send itself is triggered by the backend (cron or the in-process
// worker in `src/instrumentation.ts`), never by this component: the
// countdown is display-only, so closing the tab never loses a reminder.
//
// The timer is deliberately independent of the account-wide
// (`ai_configs.follow_up_enabled`) switch: manual scheduling works even
// when automatic follow-ups are off.
// ------------------------------------------------------------------

type Busy = "cancel" | "reschedule" | "schedule" | "toggle" | null;

interface FollowUpStatus {
  pending: (Pick<FollowUp, "id" | "type" | "execute_at"> & { status: string })[];
  global_enabled: boolean;
  conversation_enabled: boolean | null;
}

/** Minutes cap: 7 days, matching the API's own clamp. */
const MAX_MINUTES = 10080;

function clampMinutes(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.min(MAX_MINUTES, Math.max(1, Math.floor(value)));
}

function remainingParts(executeAt: string): {
  hours: number;
  minutes: number;
  done: boolean;
} {
  const diff = new Date(executeAt).getTime() - Date.now();
  if (diff <= 0) return { hours: 0, minutes: 0, done: true };
  const totalMin = Math.max(1, Math.ceil(diff / 60_000));
  return { hours: Math.floor(totalMin / 60), minutes: totalMin % 60, done: false };
}

export function FollowUpBanner({ conversationId }: { conversationId: string }) {
  const t = useTranslations("Inbox.followUp");
  const [status, setStatus] = useState<FollowUpStatus | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [minutes, setMinutes] = useState(10);
  // Tick every 30s so the "reminder in N min" label stays live.
  const [, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/whatsapp/follow-ups?conversation_id=${encodeURIComponent(conversationId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return null;
      const j = (await res.json()) as FollowUpStatus;
      setStatus(j);
      return j;
    } catch {
      return null;
    }
  }, [conversationId]);

  useEffect(() => {
    void refresh();
    // Re-render the countdown AND re-read the queue: once the backend
    // delivers a due reminder it flips the row to `completed`, so the
    // banner must refresh to drop the "pending" state on its own.
    const interval = setInterval(() => {
      setTick((n) => n + 1);
      void refresh();
    }, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const act = useCallback(
    async (action: string, extra: Record<string, unknown>, busyKey: Busy) => {
      setBusy(busyKey);
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
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
          scheduled?: boolean;
        };
        if (!res.ok) {
          toast.error(json?.error ?? t("updateError"));
          return;
        }
        // A manual schedule can be declined (the contact already had this
        // stage) — surface it instead of a false "scheduled" toast.
        if (action === "schedule" && json?.scheduled === false) {
          toast.error(t("scheduleFailed"));
          await refresh();
          return;
        }
        await refresh();
        let msg = t("updateSuccess");
        if (action === "cancel") msg = t("cancelSuccess");
        if (action === "reschedule") msg = t("rescheduleSuccess");
        if (action === "schedule") msg = t("scheduleSuccess");
        if (action === "set_enabled") msg = t("toggleSuccess");
        toast.success(msg);
      } catch {
        toast.error(t("networkError"));
      } finally {
        setBusy(null);
      }
    },
    [conversationId, refresh, t],
  );

  // Set the timer to NOW() + minutes: reschedule the pending one, or queue
  // a fresh one when the thread has none.
  const setTimer = useCallback(
    (rawMinutes: number) => {
      const value = clampMinutes(rawMinutes);
      setMinutes(value);
      if (status?.pending.length) {
        void act("reschedule", { delay_minutes: value }, "reschedule");
      } else {
        void act("schedule", { delay_minutes: value }, "schedule");
      }
    },
    [act, status?.pending.length],
  );

  // Loading ⇒ nothing yet.
  if (!status) return null;

  const pending = status.pending[0] ?? null;
  const enabled = status.conversation_enabled !== false;

  let eta = "";
  if (pending) {
    const parts = remainingParts(pending.execute_at);
    eta = parts.done
      ? t("now")
      : pending.type === "24h"
        ? t("etaHours", { hours: parts.hours, minutes: parts.minutes })
        : t("etaMinutes", { minutes: parts.minutes });
  }

  return (
    <Banner tone={pending ? "primary" : "muted"}>
      {/* Status line */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
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
        <span className="truncate">
          {!enabled ? (
            <span className="text-muted-foreground">{t("off")}</span>
          ) : pending ? (
            <span className="font-medium text-foreground">
              {pending.type === "24h" ? t("pending24hTitle") : t("pending10mTitle")}
              <span className="ml-1.5 font-normal text-muted-foreground">
                · {eta}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">{t("none")}</span>
          )}
        </span>
      </div>

      {/* Custom minutes + apply */}
      <div className="flex flex-shrink-0 items-center gap-1">
        <input
          type="number"
          min={1}
          max={MAX_MINUTES}
          inputMode="numeric"
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
          onBlur={() => setMinutes((m) => clampMinutes(m))}
          onKeyDown={(e) => {
            if (e.key === "Enter") setTimer(minutes);
          }}
          aria-label={t("customMinutes")}
          className="h-6 w-14 rounded-md border border-border bg-card px-1.5 text-center text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary"
        />
        <span className="text-muted-foreground">{t("minutesUnit")}</span>
        <BannerButton
          onClick={() => setTimer(minutes)}
          busy={busy === "reschedule" || busy === "schedule"}
          icon={pending ? Check : Plus}
        >
          {pending ? t("setTimer") : t("scheduleTimer")}
        </BannerButton>
      </div>

      {/* Cancel the pending reminder */}
      {pending && (
        <BannerButton
          onClick={() => act("cancel", {}, "cancel")}
          busy={busy === "cancel"}
          icon={X}
        >
          {t("cancel")}
        </BannerButton>
      )}

      {/* Inline per-chat switch, independent of the account-wide setting */}
      <div className="flex flex-shrink-0 items-center gap-1.5">
        <span className="text-muted-foreground">
          {enabled ? t("active") : t("paused")}
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={(checked: boolean) =>
            act("set_enabled", { enabled: checked }, "toggle")
          }
          disabled={busy === "toggle"}
        />
      </div>
    </Banner>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "primary" | "muted";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2 text-xs sm:px-4",
        tone === "primary"
          ? "border-primary/20 bg-primary/5"
          : "border-border bg-muted/40",
      )}
    >
      {children}
    </div>
  );
}

function BannerButton({
  onClick,
  busy,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  icon: typeof Plus;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
      {children}
    </button>
  );
}
