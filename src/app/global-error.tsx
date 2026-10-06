"use client";

import { useEffect, useState } from "react";
import {
  isInfrastructureError,
  isSupabaseConfigError,
} from "@/lib/errors";

/**
 * Root error boundary. Next.js renders this ONLY when an unhandled
 * error escapes the root layout or a page/layout below it — the one
 * case `error.tsx` files can't catch. It ships its own <html>/<body>
 * (the root layout is unreachable at that point) so the visitor still
 * gets a usable, on-brand screen instead of a bare "Internal Server
 * Error" / grey 500.
 *
 * It ALWAYS surfaces the explicit `error.message` (and the `stack`
 * trace when Next forwards it) in a readable monospace block, matching
 * `error.tsx`. When the failure is Supabase infrastructure/config
 * related, the screen auto-redirects to `/login` with a visible
 * countdown plus an immediate link — a broken provider must never
 * strand the visitor on an error card.
 *
 * This is deliberately dependency-free from the shared UI kit/fonts:
 * importing them could itself throw and recurse into this file. Styling
 * uses inline-safe classes plus a tiny <style> block, because global
 * styles are NOT loaded for this document (Next docs: global-error
 * "render their own document and do not include your global styles").
 */
export default function GlobalError({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  unstable_retry: () => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(5);
  const [redirecting, setRedirecting] = useState(false);

  const infra = isInfrastructureError(error);
  const configError = isSupabaseConfigError(error?.message);

  const retry = unstable_retry ?? reset;

  useEffect(() => {
    console.error("[global-error]", error);
  }, [error]);

  // Auto-redirect a broken Supabase deployment to /login (unless we're
  // already on the login/join pages). Kept off the synchronous render
  // path so the SSR markup matches hydration, and started from an async
  // callback so no setState runs synchronously inside the effect body.
  useEffect(() => {
    if (!infra) return;
    if (
      window.location.pathname === "/login" ||
      window.location.pathname.startsWith("/join")
    ) {
      return;
    }
    const start = setTimeout(() => setRedirecting(true), 500);
    return () => clearTimeout(start);
  }, [infra]);

  useEffect(() => {
    if (!redirecting) return;
    if (secondsLeft <= 0) {
      window.location.href = "/login";
      return;
    }
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [redirecting, secondsLeft]);

  const message = error?.message?.trim();
  const stack = error?.stack?.trim();

  return (
    <html lang="en" data-theme="dark" data-mode="dark">
      <style>{`
        html, body { margin: 0; padding: 0; }
        * { box-sizing: border-box; }
        body {
          min-height: 100vh;
          background: #020617;
          color: #f1f5f9;
          font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          -webkit-font-smoothing: antialiased;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
        }
        .card {
          width: 100%;
          max-width: 42rem;
          background: #0f172a;
          border: 1px solid #1e293b;
          border-radius: 0.75rem;
          overflow: hidden;
        }
        .card-head { border-bottom: 1px solid #1e293b; padding: 1.25rem 1.5rem; background: rgba(239,68,68,0.06); }
        .card-head h1 { margin: 0; font-size: 1.25rem; font-weight: 600; color: #f87171; }
        .card-head p { margin: 0.25rem 0 0; font-size: 0.875rem; color: #94a3b8; }
        .card-body { padding: 1.25rem 1.5rem; }
        .notice { margin: 0 0 1rem; padding: 0.75rem 1rem; border: 1px solid rgba(14,165,233,0.3); background: rgba(14,165,233,0.08); border-radius: 0.5rem; font-size: 0.875rem; color: #f1f5f9; }
        .notice b { tabular-nums: normal; }
        .label { margin: 0 0 0.25rem; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; }
        .msgbox { margin: 0 0 1rem; padding: 0.5rem 0.75rem; background: #020617; border: 1px solid #1e293b; border-radius: 0.5rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125rem; line-height: 1.5; overflow-wrap: anywhere; color: #e2e8f0; }
        .stackbox { margin: 0 0 1rem; padding: 0.5rem 0.75rem; background: #020617; border: 1px solid #1e293b; border-radius: 0.5rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; line-height: 1.5; overflow: auto; max-height: 16rem; white-space: pre-wrap; overflow-wrap: anywhere; color: #cbd5e1; }
        .digest { margin: 0 0 1rem; font-size: 0.75rem; color: #94a3b8; }
        .buttons { display: flex; flex-wrap: wrap; gap: 0.5rem; }
        .btn { display: inline-flex; height: 2.5rem; align-items: center; justify-content: center; padding: 0 1rem; border-radius: 0.5rem; border: none; font: inherit; font-size: 0.875rem; font-weight: 500; cursor: pointer; text-decoration: none; }
        .btn-primary { background: #f1f5f9; color: #0f172a; }
        .btn-primary:hover { background: #e2e8f0; }
        .btn-secondary { background: transparent; color: #f1f5f9; border: 1px solid #334155; }
        .btn-secondary:hover { background: #1e293b; }
      `}</style>
      <body>
        <main className="card">
          <div className="card-head">
            <h1>Algo salió mal</h1>
            <p>
              {configError
                ? "La aplicación no está correctamente conectada a Supabase (faltan claves de configuración)."
                : "La aplicación encontró un problema inesperado al mostrar esta página."}
            </p>
          </div>
          <div className="card-body">
            {redirecting && (
              <p className="notice">
                {configError
                  ? "No se puede operar sin la conexión a Supabase."
                  : "Parece que hay un problema de conexión con la base de datos."}{" "}
                Serás redirigido a la página de acceso en{" "}
                <b>{secondsLeft}</b>s.
              </p>
            )}

            {message && (
              <>
                <p className="label">Mensaje</p>
                <div
                  className="msgbox"
                  data-testid="global-error-message"
                >
                  {message}
                </div>
              </>
            )}

            {error?.digest && (
              <p className="digest">
                ID del error: <code>{error.digest}</code> — búscalo en los
                logs del servidor para ver la traza completa.
              </p>
            )}

            {stack && <pre className="stackbox">{stack}</pre>}

            <div className="buttons">
              <button type="button" className="btn btn-primary" onClick={retry}>
                Reintentar
              </button>
              <a className="btn btn-secondary" href="/login">
                Ir a la página de acceso
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}