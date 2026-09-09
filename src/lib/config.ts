export const ZONA = "America/Lima";

export const DURACION_CITA_MIN = 60;
export const ANTICIPACION_MINIMA_MIN = 120;
export const DEBOUNCE_SEG = 8;
export const VENTANA_HORAS = 24;
export const META_GRAPH_VERSION = "v21.0";

export const ATENCION = {
  // lunes (1) a viernes (5)
  semana: { apertura: 9, cierre: 18 },
  // sábado (6)
  sabado: { apertura: 9, cierre: 13 },
  // domingo (0) cerrado
} as const;

export function diaDeAtencion(fecha: Date): { apertura: number; cierre: number } | null {
  const p = partesLocales(fecha);
  if (p.diaSemana === 0) return null;
  if (p.diaSemana === 6) return ATENCION.sabado;
  return ATENCION.semana;
}

export interface PartesLocales {
  anio: number;
  mes: number; // 1-12
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
  diaSemana: number; // 0 domingo, 6 sábado
}

const NOMBRES_DIA = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
];
export const NOMBRES_MES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

export function partesLocales(fecha: Date): PartesLocales {
  const fmt = new Intl.DateTimeFormat("es-PE", {
    timeZone: ZONA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const trozos: Record<string, string> = {};
  for (const t of fmt.formatToParts(fecha)) {
    if (t.type !== "literal") trozos[t.type] = t.value;
  }
  const diaSemana = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"].indexOf(
    trozos.weekday!.toLowerCase()
  );
  return {
    anio: Number(trozos.year),
    mes: Number(trozos.month),
    dia: Number(trozos.day),
    hora: Number(trozos.hour),
    minuto: Number(trozos.minute),
    segundo: Number(trozos.second),
    diaSemana,
  };
}

// La inversa de partesLocales: construye un Date a partir de hora local.
// Hace dos pasadas porque el offset puede cambiar entre la suposición y el resultado.
export function desdeLocal(
  anio: number,
  mes: number,
  dia: number,
  hora: number,
  minuto: number,
  segundo = 0
): Date {
  const suposicion = new Date(Date.UTC(anio, mes - 1, dia, hora, minuto, segundo));
  const p1 = partesLocales(suposicion);
  const desvio1 =
    Date.UTC(p1.anio, p1.mes - 1, p1.dia, p1.hora, p1.minuto, p1.segundo) -
    suposicion.getTime();
  const paso2 = new Date(suposicion.getTime() - desvio1);
  const p2 = partesLocales(paso2);
  const desvio2 =
    Date.UTC(p2.anio, p2.mes - 1, p2.dia, p2.hora, p2.minuto, p2.segundo) -
    paso2.getTime();
  return new Date(paso2.getTime() - desvio2);
}

// 2026-08-18T15:00:00-05:00, con el offset explícito. Es lo que espera Google.
export function aRFC3339Local(fecha: Date): string {
  const p = partesLocales(fecha);
  const comoUTC = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  const desvioMin = Math.round((comoUTC - fecha.getTime()) / 60000);
  const signo = desvioMin < 0 ? "-" : "+";
  const abs = Math.abs(desvioMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const s = `${String(p.anio).padStart(4, "0")}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
  const t = `${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")}:${String(p.segundo).padStart(2, "0")}`;
  return `${s}T${t}${signo}${hh}:${mm}`;
}

export function ahora(): Date {
  return new Date();
}

// "martes 18 de agosto de 2026, 15:30" — lo que ve el modelo, sin segundos.
export function fechaHoraLegible(fecha: Date): string {
  const p = partesLocales(fecha);
  const hora = String(p.hora).padStart(2, "0");
  const minuto = String(p.minuto).padStart(2, "0");
  return `${NOMBRES_DIA[p.diaSemana]} ${p.dia} de ${NOMBRES_MES[p.mes - 1]} de ${p.anio}, ${hora}:${minuto}`;
}

export function fechaLegible(fecha: Date): string {
  const p = partesLocales(fecha);
  return `${NOMBRES_DIA[p.diaSemana]} ${p.dia} de ${NOMBRES_MES[p.mes - 1]} de ${p.anio}`;
}

export function horaLegible(fecha: Date): string {
  const p = partesLocales(fecha);
  const hora = String(p.hora).padStart(2, "0");
  const minuto = String(p.minuto).padStart(2, "0");
  return `${hora}:${minuto}`;
}

function exigir(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) {
    throw new Error(`Falta la variable de entorno ${nombre}`);
  }
  return valor;
}

export const entorno = {
  get waToken() {
    return exigir("WA_TOKEN");
  },
  get waPhoneNumberId() {
    return exigir("WA_PHONE_NUMBER_ID");
  },
  get waVerifyToken() {
    return exigir("WA_VERIFY_TOKEN");
  },
  get waAppSecret() {
    return exigir("WA_APP_SECRET");
  },
  get openrouterApiKey() {
    return exigir("OPENROUTER_API_KEY");
  },
  get modelo() {
    return exigir("OPENROUTER_MODEL");
  },
  get modeloMedia() {
    return exigir("OPENROUTER_MODEL_MEDIA");
  },
  get serviceAccountJson() {
    const crudo = exigir("GOOGLE_SERVICE_ACCOUNT_JSON");
    // Si empieza por "{" es JSON tal cual; si no, base64.
    if (crudo.trimStart().startsWith("{")) return crudo;
    return Buffer.from(crudo, "base64").toString("utf8");
  },
  get googleCalendarId() {
    return exigir("GOOGLE_CALENDAR_ID");
  },
  get databaseUrl() {
    return exigir("DATABASE_URL");
  },
};

// Devuelve las variables que faltan. No lanza: la comprobación que mata el
// proceso está en instrumentation.ts, no en este módulo.
export function variablesFaltantes(): string[] {
  const obligatorias = [
    "WA_TOKEN",
    "WA_PHONE_NUMBER_ID",
    "WA_VERIFY_TOKEN",
    "WA_APP_SECRET",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
    "OPENROUTER_MODEL_MEDIA",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "GOOGLE_CALENDAR_ID",
    "DATABASE_URL",
  ] as const;
  return obligatorias.filter((nombre) => !process.env[nombre]);
}