## REPORTE FINAL: Resolución inteligente de BSUID numérico

### a) Causa raíz exacta
La cascada validaba valores crudos: cuando conversations.wa_id/contacts.wa_id contenían @username o sufijos @user/@lid, los dígitos extraídos no siempre producían un BSUID numérico puro reconocible. Además, no se inspeccionaba a profundidad contacts.metadata.bsuid/channel_id/wa_id, conversations.channel_id, ni se extraía BSUID numérico desde messages.raw_meta_payload (campos rom/rom_user_id/wa_id), por lo que "1008477715690681" podía pasar desapercibido.

### b) Archivos y funciones modificadas
- src/lib/whatsapp/recipient-cascade.ts
  - extractNumericBsuid(value): limpia sufijos @user/@lid/@c.us, quita prefijo @, extrae dígitos; retorna dígitos >=8 si son numéricos puros.
  - sanitizeCascadeSource: intenta extraer BSUID numérico primero.
  - Fuente 4: inspección profunda de candidatos (convo.channel_id, contact.wa_id/wa_user_id/recipient_id, contact.metadata.bsuid/channel_id/wa_id); si encuentra BSUID numérico >=8 lo marca VALIDO.
  - Fuente 5: promueve a VALIDO si metaIdFromRawPayload contiene BSUID numérico extraíble.

### c) Confirmación
- 
pm run typecheck: 0 errores.
- 
pm run test: 1629/1629 passed.
- 
pm run lint: 0 errors, 1 warning preexistente (contact-sidebar.tsx:82).

### d) Validación en vivo tras Trigger Deploy (Easypanel)
1. Identificar conversación con wa_id @username pero con BSUID numérico (ej. 1008477715690681) en contacts.metadata.bsuid o conversations.channel_id.
2. Enviar mensaje libre desde esa conversación.
3. Logs: [INFORME_DIAGNOSTICO_DESTINATARIO] debe mostrar DESTINATARIO FINAL SELECCIONADO: "1008477715690681" (Fuente 4) y channel_bsuid VALIDO.
4. Payload a Meta: {messaging_product:'whatsapp', recipient_type:'individual', to:'1008477715690681', type:'text', text:{body:...}, context:{message_id:<wamid>}} si existe wamid entrante; sin context si no existe. Sin 422 por "falta teléfono".
