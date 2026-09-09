# Agente de citas por WhatsApp

Agente conversacional que agenda, reagenda y cancela citas en Google Calendar a través de WhatsApp. Incluye panel de visualización con agenda, calendario y conversaciones.

## Variables de entorno

Todas son obligatorias (la app no arranca si falta alguna):

| Variable | Descripción |
|---|---|
| `WA_TOKEN` | Token de acceso de la API de WhatsApp Business |
| `WA_PHONE_NUMBER_ID` | ID del número de teléfono de WhatsApp Business |
| `WA_VERIFY_TOKEN` | Token que usas en la configuración del webhook de Meta |
| `WA_APP_SECRET` | Secreto de la app de Meta (para validar firmas HMAC) |
| `OPENROUTER_API_KEY` | API key de OpenRouter |
| `OPENROUTER_MODEL` | Modelo principal (ej: `anthropic/claude-sonnet-4-20250514`) |
| `OPENROUTER_MODEL_MEDIA` | Modelo para entender imágenes y audio (ej: `openai/gpt-4o-mini`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | JSON de la service account de Google o Base64 del mismo |
| `GOOGLE_CALENDAR_ID` | ID del calendario donde agendar |
| `DATABASE_URL` | `file:/app/data/agente.db` (ya configurada en Dockerfile) |

## Despliegue en Easypanel

1. Crear un nuevo servicio **App** y seleccionar **Dockerfile** como método.
2. Configurar el **Puerto** del contenedor en `3000`.
3. **Antes del primer despliegue**, montar un volumen en `/app/data` para que la base de datos no se pierda al reiniciar. Si ya desplegaste sin el volumen, borra el servicio y vuelve a crearlo con el volumen antes de desplegar.
4. Configurar las variables de entorno en el paso **Environment Variables**.
5. Desplegar. Usa **1 réplica** (el worker de la cola está embebido en el proceso y no está pensado para múltiples instancias).
6. **Después** de desplegar, ve al **panel de Meta** → tu app → WhatsApp → Configuración → Webhook y marca el campo **messages** como paso propio (este paso se hace aparte porque se configura después del despliegue).

> **Aviso**: el log de build de Easypanel imprime todas las variables de entorno en claro, porque las pasa como `--build-arg`. Si tu despliegue es público, borra ese log después de verificar que el build funciona.

> **Sin login**: el panel no tiene autenticación. Si necesitas acceso restringido, ponlo detrás de un proxy con auth.

## Google Calendar

La app usa una **service account** de Google para operar el calendario. Hay dos caminos:

**Opción A (recomendada): Compartir un calendario existente con la service account**
1. Abre Google Calendar en el navegador.
2. En la configuración del calendario, busca "Compartir calendario".
3. Añade el email de la service account (el campo `client_email` del JSON).
4. Dale permiso de **"Hacer cambios en los eventos"**.
5. Usa ese calendario como `GOOGLE_CALENDAR_ID`.

**Opción B: Crear un calendario nuevo vía API**
1. La app puede crear un calendario automáticamente y asignar permisos vía ACL.
2. Usa el email de la service account como propietario.

**Limitaciones de la service account**:
- **No puede** crear reuniones de Google Meet.
- **No puede** enviar invitaciones por correo electrónico.
- Si el cliente pide Meet o link de videoconferencia, sugiere otra vía de contacto.

## Verificación post-despliegue

1. **Webhook**: En el panel de Meta, haz clic en "Verificar" con la URL `https://tu-dominio/api/webhook/whatsapp`. Debería devolver un 200.
2. **Mensaje de texto**: Envía un mensaje de texto a tu número. Debería responder en segundos.
3. **Agente**: Pregunta "¿Cuáles son tus horarios?" y verifica que devuelve horarios reales del calendario.
4. **Agendar**: Pide una cita con nombre y horario. Debería crear el evento en Google Calendar.
5. **Reagendar**: Pide mover la cita a otro horario. Verifica que el evento se mueve.
6. **Cancelar**: Pide cancelar la cita. Verifica que el evento se borra.
7. **Bot off**: En el panel, pausa el bot para una conversación. Envía un mensaje y verifica que no responde.
8. **Ventana de 24 h**: Espera 24 h sin que el cliente escriba. Verifica que el agente no responde hasta que el cliente vuelva a escribir.
9. **Nota de voz**: Envía una nota de voz. Verifica que la transcribe y responde.
10. **Imagen**: Envía una imagen. Verifica que la describe.
11. **Panel**: Abre `https://tu-dominio/` y verifica que se ven las métricas y las citas agrupadas por día.
12. **Calendario**: Abre `https://tu-dominio/calendario` y verifica la vista semanal con eventos verdes (agente) y ámbar (Google).
13. **Conversaciones**: Abre `https://tu-dominio/conversaciones`, busca por nombre/número, filtra por "Ventana abierta" y "Con cita".
14. **Enviar manual**: En el hilo de una conversación con ventana abierta, envía un mensaje manual y verifica que se envía.
15. **Borrar conversación**: Borra una conversación y verifica que se redirige a la bandeja.
16. **Fuentes**: Verifica que los textos se ven con Inter y las horas con JetBrains Mono (fuentes locales, sin carga externa).

## Desarrollo local

```bash
cp .env.example .env
# Rellena las variables en .env
npm install
npx prisma migrate dev
npm run dev
```

## Estructura

- `src/lib/` — lógica del agente, cola, calendario, WhatsApp, configuración
- `src/app/` — panel (App Router) y webhook
- `prisma/` — esquema de la base de datos SQLite
- `src/app/fuentes/` — fuentes Inter y JetBrains Mono (woff2, SIL Open Font License)

## Licencia de fuentes

Inter y JetBrains Mono están bajo la **SIL Open Font License**. Los archivos woff2 están incluidos en `src/app/fuentes/`.