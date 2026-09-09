"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Refresco en vivo: llama a router.refresh() con intervalo fijo y se detiene
// cuando la pestaña no es visible. Un solo componente por página.
export function Vivo({ intervaloMs = 4000 }: { intervaloMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const intervalo = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      router.refresh();
    }, intervaloMs);
    return () => clearInterval(intervalo);
  }, [router, intervaloMs]);

  return <span className="pill-vivo">En vivo</span>;
}