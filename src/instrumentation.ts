import { variablesFaltantes } from "./lib/config";
import { iniciarWorkerSiHaceFalta } from "./lib/cola";

// La comprobación que mata el proceso va aquí, en el arranque de verdad.
// Léelas con getters: si config.ts revienta al importarse, revienta el build.
export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const faltan = variablesFaltantes();
  if (faltan.length > 0) {
    throw new Error(
      `Faltan variables de entorno: ${faltan.join(", ")}. Revisa tu .env`
    );
  }

  iniciarWorkerSiHaceFalta();
}