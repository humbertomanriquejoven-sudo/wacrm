import { createSign } from "crypto";
import { aRFC3339Local, entorno, ZONA } from "./config";
import { log } from "./whatsapp";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function parsearServiceAccount(): ServiceAccount {
  const crudo = entorno.serviceAccountJson;
  const datos = JSON.parse(crudo) as ServiceAccount;
  if (!datos.client_email || !datos.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON no tiene client_email o private_key");
  }
  return datos;
}

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

function firmarJwt(scope: string): string {
  const cuenta = parsearServiceAccount();
  const ahora = Math.floor(Date.now() / 1000);
  const encabezado = { alg: "RS256", typ: "JWT" };
  const carga = {
    iss: cuenta.client_email,
    scope: scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: ahora,
    exp: ahora + 3600,
  };
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const datos = `${encode(encabezado)}.${encode(carga)}`;
  const firma = createSign("RSA-SHA256")
    .update(datos)
    .sign(cuenta.private_key, "base64url");
  return `${datos}.${firma}`;
}

let tokenCache: { token: string; expira: number } | null = null;

async function obtenerToken(): Promise<string> {
  if (tokenCache && tokenCache.expira > Date.now() + 60_000) {
    return tokenCache.token;
  }
  const cuerpo = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: firmarJwt(SCOPES.join(" ")),
  });
  const respuesta = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: cuerpo.toString(),
  });
  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`No se pudo obtener token de Google: ${respuesta.status} ${detalle}`);
  }
  const datos = (await respuesta.json()) as { access_token: string; expires_in?: number };
  tokenCache = {
    token: datos.access_token,
    expira: Date.now() + (datos.expires_in ?? 3600) * 1000,
  };
  return datos.access_token;
}

async function llamarGoogle(
  ruta: string,
  opciones: { metodo?: string; cuerpo?: unknown } = {}
): Promise<unknown> {
  const token = await obtenerToken();
  const respuesta = await fetch(`https://www.googleapis.com${ruta}`, {
    method: opciones.metodo ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: opciones.cuerpo ? JSON.stringify(opciones.cuerpo) : undefined,
  });
  const texto = await respuesta.text();
  let datos: unknown = null;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch {
    datos = texto;
  }
  if (!respuesta.ok) {
    throw new Error(`Google Calendar (${respuesta.status}) ${ruta}: ${texto}`);
  }
  return datos;
}

export interface BloqueOcupado {
  inicio: Date;
  fin: Date;
}

export interface EventoGoogle {
  id: string;
  inicio: Date;
  fin: Date;
}

function parsearFecha(valor: string): Date {
  // Puede venir RFC3339 con offset o fecha sola. Nunca debe quedar sin zona.
  return new Date(valor);
}

// freeBusy devuelve solo los bloques ocupados, nunca el detalle de los eventos.
export async function bloquesOcupados(desde: Date, hasta: Date): Promise<BloqueOcupado[]> {
  const datos = (await llamarGoogle("/calendar/v3/freeBusy", {
    metodo: "POST",
    cuerpo: {
      timeMin: desde.toISOString(),
      timeMax: hasta.toISOString(),
      timeZone: ZONA,
      items: [{ id: entorno.googleCalendarId }],
    },
  })) as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> };

  const busy = datos.calendars?.[entorno.googleCalendarId]?.busy ?? [];
  return busy.map((b) => ({
    inicio: parsearFecha(b.start),
    fin: parsearFecha(b.end),
  }));
}

export async function obtenerEvento(idEvento: string): Promise<EventoGoogle> {
  const datos = (await llamarGoogle(
    `/calendar/v3/calendars/${encodeURIComponent(entorno.googleCalendarId)}/events/${encodeURIComponent(idEvento)}`
  )) as { id: string; start?: { dateTime?: string }; end?: { dateTime?: string } };
  if (!datos.start?.dateTime || !datos.end?.dateTime) {
    throw new Error(`El evento ${idEvento} no tiene dateTime (todo el día)`);
  }
  return {
    id: datos.id,
    inicio: parsearFecha(datos.start.dateTime),
    fin: parsearFecha(datos.end.dateTime),
  };
}

export async function crearEvento(
  inicio: Date,
  fin: Date,
  resumen: string,
  notas?: string
): Promise<string> {
  const datos = (await llamarGoogle(
    `/calendar/v3/calendars/${encodeURIComponent(entorno.googleCalendarId)}/events`,
    {
      metodo: "POST",
      cuerpo: {
        summary: resumen,
        description: notas,
        start: { dateTime: aRFC3339Local(inicio), timeZone: ZONA },
        end: { dateTime: aRFC3339Local(fin), timeZone: ZONA },
      },
    }
  )) as { id?: string };
  if (!datos.id) throw new Error("Google no devolvió id del evento creado");
  return datos.id;
}

export async function moverEvento(idEvento: string, inicio: Date, fin: Date): Promise<void> {
  await llamarGoogle(
    `/calendar/v3/calendars/${encodeURIComponent(entorno.googleCalendarId)}/events/${encodeURIComponent(idEvento)}`,
    {
      metodo: "PATCH",
      cuerpo: {
        start: { dateTime: aRFC3339Local(inicio), timeZone: ZONA },
        end: { dateTime: aRFC3339Local(fin), timeZone: ZONA },
      },
    }
  );
}

export async function borrarEvento(idEvento: string): Promise<void> {
  await llamarGoogle(
    `/calendar/v3/calendars/${encodeURIComponent(entorno.googleCalendarId)}/events/${encodeURIComponent(idEvento)}`,
    { metodo: "DELETE" }
  );
  log("calendario", `borrado el evento de Google ${idEvento}`);
}