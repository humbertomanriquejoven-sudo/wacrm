"use client";

import { useEffect } from "react";

/**
 * Root error boundary. Next.js renders this ONLY when an unhandled
 * error escapes the root layout or a page/layout below it — the one
 * case `error.tsx` files can't catch. It ships its own <html>/<body>
 * (the root layout is unreachable at that point) so the visitor still
 * gets a usable, on-brand screen instead of a bare "Internal Server
 * Error" / grey 500.
 *
 * This is deliberately dependency-free: importing the shared UI kit
 * or fonts here could itself throw and recurse into this file. The
 * buttons below are plain buttons with inline-safe classes.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global-error]", error);
  }, [error]);

  return (
    <html lang="en" data-theme="dark" data-mode="dark">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        <div className="flex min-h-screen items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-8 text-center">
            <h1 className="text-2xl font-semibold text-slate-50">
              Algo salió mal
            </h1>
            <p className="mt-3 text-sm text-slate-400">
              La aplicación encontró un problema inesperado. Puedes volver a
              intentarlo — si persiste, revisa la configuración del servidor
              (variables de entorno de Supabase) o contacta al administrador.
            </p>
            {process.env.NODE_ENV !== "production" && error?.message ? (
              <p className="mt-4 rounded-lg bg-slate-950 p-3 text-left font-mono text-xs text-rose-400">
                {error.message}
              </p>
            ) : null}
            <div className="mt-6 flex flex-col gap-2">
              <button
                type="button"
                onClick={reset}
                className="h-10 w-full rounded-lg bg-slate-100 px-4 text-sm font-medium text-slate-900 hover:bg-slate-200"
              >
                Reintentar
              </button>
              <a
                href="/login"
                className="text-sm text-slate-400 underline-offset-4 hover:text-slate-200 hover:underline"
              >
                Ir a la página de acceso
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}