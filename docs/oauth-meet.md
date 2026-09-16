# OAuth2 de Google Meet — guía de configuración

Este doc explica cómo obtener y registrar las credenciales OAuth2 que el CRM
(`wacrm`) usa para crear **Meet reales** en calendarios Gmail personales, cómo
reparar `.env*` automáticamente y cómo diagnosticar `invalid_client` /
`invalid_grant`.

> **Seguridad:** `.env`, `.env.local` y `.env.local.example` están en
> `.gitignore` (se conservan `.env.example` como plantilla). **Nunca** pongas
> valores reales de secretos en este repo ni los pegues en chats compartidos.
> Rota cualquier secret/refresh que haya sido expuesto por un canal no
> privado.

---

## 1. Por qué OAuth2 (y no service-account JWT)

- Un **service-account** puede escribir en el calendario de una cuenta
  personal solo si se le comparte, pero **no puede crear Meet** en calendarios
  `@gmail.com` personales: Google devuelve `Invalid conference type value.`
  -> el evento queda sin `hangoutLink` (fallo P2 con rollback plano).
- Con **OAuth2 de usuario** (`OAuth2Client` + refresh token) Google **sí**
  crea Meet real -> `hangoutLink meet.google.com/...`.

`src/lib/calendar.ts` decide así:

1. `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN`
   presentes -> **OAuth2** (Meet real). Camino preferido.
2. Si faltan -> service-account JWT (Meet no disponible; evento plano).

---

## 2. Variables necesarias

| Variable | Formato típico | Origen |
|---|---|---|
| `GOOGLE_CLIENT_ID` | `992662581809-...apps.googleusercontent.com` (acaba en `apps.googleusercontent.com`) | Google Cloud Console -> Credentials -> OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | empieza por `GOCSPX-` | mismo OAuth client (al lado del ID) |
| `GOOGLE_REFRESH_TOKEN` | `1//04...` base64url largo | generado con consentimiento OAuth2 (debajo) |
| `GOOGLE_CALENDAR_ID` | `hola@gmail.com` | el propio calendario Gmail |

> El trío ID/secret/refresh debe ser **coherente**: el refresh se emitió para
> UN par ID+secret concreto. Si rotas el secret o cambias de client, regenera
> el refresh (sección 5) o Google responderá `invalid_client`.

---

## 3. Crear el OAuth client en Google Cloud Console

1. Ve a https://console.cloud.google.com/apis/credentials
2. **Create credentials -> OAuth client ID**.
3. Application type: **Web application** (o **Desktop**; lo importante es
   que dev y prod usen el MISMO tipo/client).
4. Copia el **Client ID** y su **Client Secret** (quedan "al lado").
5. Guarda ambos en `.env.local` (y en `.env` de despliegue) XMLcomments sin comillas extra:

```
GOOGLE_CLIENT_ID=9926...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REFRESH_TOKEN=1//04...
```

---

## 4. Configurar el consentimiento + scopes

- OAuth consent screen (External/testing), scopes (`calendar`,
  `calendar.events`), y el usuario Gmail dueño del calendario debe ser test
  user hasta publicar.
- Desde el código solo se usa `https://www.googleapis.com/auth/calendar`
  (con OAuth2Client) y `conferenceDataVersion: 1` con
  `conferenceSolutionKey: hangoutsMeet`.

---

## 5. Generar el GOOGLE_REFRESH_TOKEN

Con un OAuth2Client (client_id+secret) pides `access_type:'offline'` +
`prompt:'consent'`; tras autorizar obtienes un `code`; lo canjeas por tokens
y conservas el `refresh_token`.

```js
// generate-refresh.mjs — ASCII, imprime SOLO el refresh, valores reales van en .env
import { OAuth2Client } from 'google-auth-library'
const client = new OAuth2Client({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: 'http://localhost',
})
const url = client.generateAuthUrl({
  access_type: 'offline', // OBLIGATORIO
  prompt: 'consent',
  scope: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ],
})
console.log(url)
// abre, autoriza, copias el ?code=..., luego:
client.getToken(code).then(({ tokens }) => {
  console.log('REFRESH_TOKEN=' + tokens.refresh_token)
})
```

Regla de oro: el refresh se emite solo en la **primera** autorización de un par
ID/secret; si ya autorizaste antes, revoca el acceso con el usuario y vuelve a
hacer el flujo (siempre con `prompt: 'consent'`).

---

## 6. self-eval y reparación automática

Con las claves puestas:

```
node scripts/calendar-selfeval.mjs .env.local
```

Esperado en el reporte: `P1 AUTH_FREE_BUSY=OK`, `P2 EVENT_CREATE=OK`, link
`meet.google.com/...` (Meet REAL), `EVENT_DELETE=OK` (limpia el evento).

`node scripts/repair-env.mjs .env.local` registra y valida
`GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` (mismo criterio que calendar.ts) y
repara JSON/quotes dañados. Nunca imprime valores: solo presencia, longitud y
formato.

---

## 7. Diagnóstico de errores de Google

- `invalid_client` -> el par ID+secret no es el que emitió el refresh (secret
  rotado/revocado, o copiaste el refresh de otro client/proyecto). Vuelve a 3 y
  regenera el par completo (o el refresh con ese mismo par).
- `invalid_grant` -> refresh_token caducado/revocado. Regenera el refresh (5).
- `Invalid conference type value` (con JWT) -> estás en service-account; pasa
  a OAuth2 (1) para Meet real.
- `MEET=FAIL (sin link)` en selfcheck con JWT -> esperado sin OAuth2.

---

## 8. Seguridad final

- Los `.env*` NO se suben (`.gitignore`).
- Rota secret y refresh si se compartieron por canal no privado.
- Este repo jamás contiene valores reales de secretos.
