import type { ReactNode } from "react";
import type { Metadata } from "next";
import "./globals.css";
import { inter, jetbrainsMono } from "./fuentes";
import { Nav } from "./nav";
import { resumenCola } from "@/lib/cola";
import { variablesFaltantes } from "@/lib/config";

export const metadata: Metadata = {
  title: "Agente de citas por WhatsApp",
  description: "Panel del agente de citas por WhatsApp",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cola = await resumenCola().catch(() => ({ pendientes: 0, fallidos: 0 }));
  const faltan = variablesFaltantes();

  return (
    <html lang="es" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <div className="panel">
          <Nav
            pie={
              <>
                <span>
                  <span className="punto-estado punto-verde" /> {cola.pendientes} en cola
                </span>
                <span>
                  <span
                    className={`punto-estado ${cola.fallidos > 0 ? "punto-rojo" : "punto-verde"}`}
                  />{" "}
                  {cola.fallidos} fallidos
                </span>
              </>
            }
          />
          <main className="contenido">
            {faltan.length > 0 && (
              <div className="aviso">
                <strong>Faltan variables de entorno:</strong> {faltan.join(", ")}. El
                agente no responderá hasta configurarlas en Easypanel.
              </div>
            )}
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}