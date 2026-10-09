## REPORTE FINAL - Arquitectura de destinatarios WhatsApp (7 puntos)

### 1. Causa raíz
Se normalizaba un handle @username a un valor con letras y se enviaba a Meta, provocando (#100) Invalid parameter o intentos a números inventados. ESCENARIO C: Meta no acepta @username en 	o aun con contexto; se añadió rechazo preventivo local (InvalidRecipientError).

### 2. Archivos y funciones modificadas
- src/lib/whatsapp/meta-api.ts: cleanRecipientAddress, nuevo ssertDeliverableDestination, ecipientAddressField, canonicalToField, sendTextMessage (guard ESCENARIO C).
- src/lib/whatsapp/send-message.ts: HOW_TO_FIX_BSUID_WINDOW, mensaje suid_window_closed actualizado a exigir Plantilla.
- Tests: meta-api.recipient.test.ts, meta-api.media.test.ts, meta-api.context-reply.test.ts, send-message.test.ts, pp/api/whatsapp/send/route.test.ts.

### 3. Cambios de lógica
- ecipientAddressField: acepta solo numéricos puros o namespaced con payload numérico; rechaza handles/letras vía ssertDeliverableDestination.
- canonicalToField: 	o nunca contiene letras (refuse handles); valida destino entregable.
- sendTextMessage: 	argetId validado por ESCENARIO C.

### 4. Migraciones/esquemas
Sin cambios. Bypass RLS ya aplicado (webhook y contacts/[id]/phone usan supabaseAdmin).

### 5. Resultados
- typecheck: 0 errores. vitest: 1629/1629 passed. eslint: 0 errors, 1 warning preexistente.

### 6. Limitaciones Meta
- @username no direccionable en 	o (#100) incluso con contexto ? rechazo local.
- IDs opacos requieren contexto para envío frío (guard #131009); plantillas/media usan forma 	o según diseño.
- Namespaced con payload numérico aceptados según ruta.

### 7. Verificación
- Cobertura: E.164, BSUID numérico (ventana 24h), handle prohibido, namespaced válidos. No se envía a Meta para handles.
