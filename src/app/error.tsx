"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  isInfrastructureError,
  isSupabaseConfigError,
} from "@/lib/errors";

/**
 * Root error boundary (`app/error.tsx`).
 *
 * Catches any unhandled error thrown while rendering a page / layout
 * below the root layout (SSR render errors, client render errors) and
 * shows a visual, readable screen INSTEAD of the generic "Internal
 * Server Error" / grey 500.
 *
 * Unlike `global-error.tsx` this renders INSIDE the root layout, so the
 * app's Tailwind styles, fonts and theme are available.
 *
 * It always surfaces the explicit `error.message` and `error.stack`
 * (whenever Next forwards them — see the digest note below) in a
 * readable monospace block, plus two escape hatches:
 *   - "Reintentar": `unstable_retry()` re-fetches and re-renders the
 *     failed segment.
 *   - When the failure is Supabase infrastructure/config related, the
 *     page auto-redirects to `/login` (so a broken provider never
 *     strands the visitor on an error card) with a visible countdown
 *     and an immediate "Ir a la página de acceso" button.
 *
 * Note on production: Next.js sanitizes the `error` object forwarded
 * from SERVER components in production — `error.message` becomes a
 * generic string and only `error.digest` is preserved, so it can be
 * matched to the real server-side stack in the logs. Errors forwarded
 * from client components keep their original `message` and `stack`.
 * We always render whatever survives the round-trip.
 */
export default function RootErrorPage({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  unstable_retry: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [countdown, setCountdown] = useState(5);

  const infra = isInfrastructureError(error);
  const configError = isSupabaseConfigError(error?.message);
  // Never redirect-to-login loops off /login itself.
  const shouldRedirect =
    infra && pathname !== "/login" && !pathname.startsWith("/join");

  const retry = unstable_retry ?? reset;

  useEffect(() => {
    console.error("[app/error]", error);
  }, [error]);

  useEffect(() => {
    if (!shouldRedirect) return;
    if (countdown <= 0) {
      router.replace("/login");
      return;
    }
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [shouldRedirect, countdown, router]);

  // Keep a stable scroll target without depending on refs re-running.
  const detailRef = useRef<HTMLDetailsElement>(null);

  const message = error?.message?.trim();
  const stack = error?.stack?.trim();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border bg-destructive/5 px-6 py-5">
          <h1 className="text-xl font-semibold text-destructive">
            Algo salió mal
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {configError
              ? "La aplicación no está correctamente conectada a Supabase (faltan claves de configuración)."
              : "La aplicación encontró un problema inesperado al mostrar esta página."}
          </p>
        </div>

        <div className="px-6 py-5">
          {shouldRedirect && (
            <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-foreground">
              {configError
                ? "No se puede operar sin la conexión a Supabase."
                : "Parece que hay un problema de conexión con la base de datos."}{" "}
              Serás redirigido a la página de acceso en{" "}
              <span className="font-semibold tabular-nums">{countdown}</span>s.
            </div>
          )}

          {message && (
            <div className="mb-3">
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Mensaje
              </h2>
              <p
                className="rounded-lg border border-border bg-muted px-3 py-2 font-mono text-sm break-words text-foreground"
                data-testid="error-message"
              >
                {message}
              </p>
            </div>
          )}

          {error?.digest && (
            <p className="mb-3 text-xs text-muted-foreground">
              ID del error: <code className="font-mono">{error.digest}</code> — búscalo en los logs del servidor
              para ver la traza completa (Next.js oculta el stack de errores de servidor en producción).
            </p>
          )}

          {stack && (
            <details ref={detailRef} className="mb-4 rounded-lg border border-border bg-muted/40">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Detalle técnico (stack trace)
              </summary>
              <pre className="max-h-64 overflow-auto border-t border-border px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground">
                {stack}
              </pre>
            </details>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={retry}
              className="inline-flex h-10 items-center justify-center rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-colors hover:opacity-90"
            >
              Reintentar
            </button>
            <button
              type="button"
              onClick={() => router.replace("/login")}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              Ir a la página de acceso
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}