"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const ENLACES = [
  { href: "/", etiqueta: "Agenda" },
  { href: "/calendario", etiqueta: "Calendario" },
  { href: "/conversaciones", etiqueta: "Conversaciones" },
];

export function Nav({ pie }: { pie: ReactNode }) {
  const ruta = usePathname();
  return (
    <aside className="rail">
      <div className="rail-marca">Agente de citas</div>
      {ENLACES.map((enlace) => {
        const activo = enlace.href === "/" ? ruta === "/" : ruta.startsWith(enlace.href);
        return (
          <Link
            key={enlace.href}
            href={enlace.href}
            className={`rail-enlace${activo ? " rail-enlace-activo" : ""}`}
          >
            {enlace.etiqueta}
          </Link>
        );
      })}
      <div className="rail-pie">{pie}</div>
    </aside>
  );
}