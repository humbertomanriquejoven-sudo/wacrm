import { variablesFaltantes } from "./lib/config";
import { iniciarWorkerSiHaceFalta } from "./lib/cola";
import { log } from "./lib/whatsapp";

// La comprobación de entorno va aquí, en el arranque de verdad. Solo las
// variables imprescindibles para que el panel funcione matan el proceso;
// el resto (WhatsApp, OpenRouter, Google) se deja como aviso para que la
// interfaz siga siendo accesible y muestre qué falta configurar.
export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const faltan = variablesFaltantes();
  if (faltan.length > 0) {
    // DATABASE_URL es imprescindible para todo (webhook, cola, panel).
    if (faltan.includes("DATABASE_URL")) {
      throw new Error("Falta DATABASE_URL: la app no puede funcionar sin base de datos");
    }
    log(
      "arranque",
      `Variables de entorno sin configurar (el agente no funcionará hasta completarlas): ${faltan.join(", ")}`
    );
  }

  iniciarWorkerSiHaceFalta();
}