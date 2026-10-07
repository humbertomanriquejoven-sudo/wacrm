"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, Loader2, Bell, BellOff, Check, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { FollowUp } from "@/types";

// ------------------------------------------------------------------
// Follow-up banner — CRM visibility for the timed reminders.
//
// The runner itself is service-role; this banner reads and manages the
// queue through /api/whatsapp/follow-ups with normal dashboard auth, so
// the agent can see "a reminder is scheduled in N min", postpone/cancel
// it, queue one on demand, or disable reminders for this chat.
//
// Renders nothing while loading or when the account-wide switch
// (ai_configs.follow_up_enabled) is OFF — same "feature off ⇒ silence"
// convention as AiThreadBanner.
// ------------------------------------------------------------------

type Busy = "cancel" | "reschedule" | "schedule" | "toggle" | null;

interface FollowUpStatus {
  pending: (Pick<FollowUp, "id" | "type" | "execute_at"> & { status: string })[];
  global_enabled: boolean;
  conversation_enabled: boolean | null;
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
    let alive = true;
    void refresh().then((j) => {
      if (!alive && !j) setStatus(null);
    });
    const interval = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
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
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          toast.error(j?.error ?? t("updateError"));
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

  // Loading or account-wide off ⇒ nothing to show.
  if (!status) return null;
  if (!status.global_enabled) return null;

  const pending = status.pending[0] ?? null;
  const disabledHere = status.conversation_enabled === false;

  // Disabled per-chat ⇒ muted banner with a re-activate button.
  if (disabledHere) {
    return (
      <Banner tone="muted">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <BellOff className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <span className="truncate text-muted-foreground">{t("off")}</span>
        </div>
        <BannerButton
          onClick={() => act("set_enabled", { enabled: true }, "toggle")}
          busy={busy === "toggle"}
          icon={Bell}
        >
          {t("enable")}
        </BannerButton>
      </Banner>
    );
  }

  // A reminder is pending ⇒ the badge + postpone/cancel.
  if (pending) {
    const is24h = pending.type === "24h";
    const { hours, minutes, done } = remainingParts(pending.execute_at);
    const eta = done
      ? t("now")
      : is24h
        ? t("etaHours", { hours, minutes })
        : t("etaMinutes", { minutes });
    return (
      <Banner tone="primary">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
          <span className="truncate font-medium text-foreground">
            {is24h ? t("pending24hTitle") : t("pending10mTitle")}
            <span className="ml-1.5 font-normal text-muted-foreground">
              · {eta}
            </span>
          </span>
        </div>
        <BannerButton
          onClick={() =>
            act("reschedule", { delay_minutes: is24h ? 24 * 60 : 10 }, "reschedule")
          }
          busy={busy === "reschedule"}
          icon={Plus}
        >
          {is24h ? t("plus24h") : t("plus10m")}
        </BannerButton>
        <BannerButton
          onClick={() => act("cancel", {}, "cancel")}
          busy={busy === "cancel"}
          icon={Check}
        >
          {t("cancel")}
        </BannerButton>
      </Banner>
    );
  }

  // Enabled but nothing queued ⇒ offer one + a per-chat kill switch.
  return (
    <Banner tone="muted">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Clock className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span className="truncate text-muted-foreground">{t("none")}</span>
      </div>
      <BannerButton
        onClick={() => act("schedule", { type: "10m" }, "schedule")}
        busy={busy === "schedule"}
        icon={Plus}
      >
        {t("schedule10m")}
      </BannerButton>
      <BannerButton
        onClick={() => act("set_enabled", { enabled: false }, "toggle")}
        busy={busy === "toggle"}
        icon={BellOff}
      >
        {t("disable")}
      </BannerButton>
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
        "flex items-center gap-3 border-b px-3 py-2 text-xs sm:px-4",
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