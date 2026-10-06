#!/usr/bin/env node
/**
 * DIAGNÓSTICO AI KEY — Paso A (BD) → Paso B (desencriptado) → Paso C (OpenRouter).
 *
 *   node scripts/diagnose-ai-key.mjs
 *
 * Lee la última fila de `ai_configs`, intenta desencriptar `api_key` con la
 * ENCRYPTION_KEY del entorno ACTIVO y llama a OpenRouter con la clave real.
 * Imprime en qué paso exacto falla:
 *   Paso A: registro no encontrado / deshabilitado / RLS
 *   Paso B: ENCRYPTION_KEY ausente o mismatch (clave corrupta)
 *   Paso C: HTTP 401 / 402 / 400 / 404 del proveedor
 *
 * Env vars consumedidas (en orden de precedencia):
 *   SUPABASE_URL | NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (recomendado; sin él, RLS puede ocultar filas)
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   ENCRYPTION_KEY  (64 hex)
 *   OPENROUTER_API_KEY (solo como fallback del Paso C si el Paso B falla)
 *
 * Corre igual en local (.env / .env.local) y en EasyPanel (variables del
 * contenedor). NUNCA imprime la clave — sólo huella SHA-256 y longitud.
 */
import { createDecipheriv } from 'node:crypto'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------- env (process.env manda; luego .env.local, luego .env) ----------
for (const file of ['.env.local', '.env']) {
  const path = resolve(process.cwd(), file)
  if (!existsSync(path)) continue
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const [, name, value] = m
    if (process.env[name] !== undefined) continue
    process.env[name] = value.replace(/^['"]|['"]$/g, '')
  }
}

const SUPABASE_URL = (
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
).replace(/\/$/, '')
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const DB_KEY = SERVICE_ROLE || ANON_KEY
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || ''
const ENV_OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || ''

const TEST_MODEL = 'google/gemini-2.5-flash-lite'
const verdict = { A: null, B: null, C: null } // 'PASS' | 'FAIL' | 'SKIP'
const say = (...a) => console.log(...a)
const step = (n, msg) => say(`\n===== PASO ${n} — ${msg} =====`)
const pass = (n, msg) => { verdict[n] = 'PASS'; say(`  [Paso ${n} PASS] ${msg}`) }
const fail = (n, msg) => { verdict[n] = 'FAIL'; say(`  [Paso ${n} FAIL] ${msg}`) }
const skip = (n, msg) => { verdict[n] = 'SKIP'; say(`  [Paso ${n} SKIP] ${msg}`) }

const fingerprint = (plain) =>
  createHash('sha256').update(plain, 'utf8').digest('hex').slice(0, 8)

function decryptCipher(stored, hexKey) {
  const parts = String(stored).split(':')
  const iv = Buffer.from(parts[0], 'base64')
  const ct = Buffer.from(parts[1], 'base64')
  if (parts.length === 3) {
    // AES-256-GCM: iv:ct:authTag
    const d = createDecipheriv('aes-256-gcm', hexKey, iv)
    d.setAuthTag(Buffer.from(parts[2], 'base64'))
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
  }
  // AES-256-CBC legacy: iv:ct
  const d = createDecipheriv('aes-256-cbc', hexKey, iv)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

async function main() {
  say('=== DIAGNÓSTICO AI KEY (A: BD → B: desencriptado → C: OpenRouter) ===')
  say(`supabase_url=${SUPABASE_URL || '<FALTA>'}`)
  say(
    `db_auth=${SERVICE_ROLE ? 'SERVICE_ROLE' : ANON_KEY ? 'ANON (RLS puede ocultar filas)' : '<FALTA>'}`,
  )
  say(
    `ENCRYPTION_KEY=${ENCRYPTION_KEY ? (/^[0-9a-fA-F]{64}$/.test(ENCRYPTION_KEY) ? 'presente (64 hex OK)' : 'presente pero INVÁLIDA (no tiene 64 caracteres hex)') : 'NO DEFINIDA en este entorno'}`,
  )

  // ---------------- PASO A: lectura de la BD ----------------
  step('A', 'Lectura de ai_configs')
  let row = null
  if (!SUPABASE_URL || !DB_KEY) {
    fail('A', `faltan ${!SUPABASE_URL ? 'SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL' : 'una clave de acceso a BD (SUPABASE_SERVICE_ROLE_KEY o NEXT_PUBLIC_SUPABASE_ANON_KEY)'}`)
  } else {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/ai_configs?select=account_id,provider,model,api_key,is_active,auto_reply_enabled,created_at&order=created_at.desc&limit=3`,
        {
          headers: {
            apikey: DB_KEY,
            Authorization: `Bearer ${DB_KEY}`,
          },
        },
      )
      if (!res.ok) {
        fail('A', `HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`)
      } else {
        const rows = await res.json()
        if (!rows.length) {
          fail(
            'A',
            SERVICE_ROLE
              ? 'la tabla ai_configs no tiene filas — nunca se guardó una clave desde este entorno.'
              : '0 filas: puede ser RLS (sin service role) o tabla vacía. Repite en el servidor con SUPABASE_SERVICE_ROLE_KEY para un veredicto definitivo.',
          )
        } else {
          row = rows.find((r) => r.api_key) || rows[0]
          pass('A', `${rows.length} fila(s); usada account_id=${row.account_id} created_at=${row.created_at}`)
          say(`        provider=${row.provider} model=${row.model || '<vacío>'} is_active=${row.is_active} auto_reply_enabled=${row.auto_reply_enabled}`)
          if (!row.is_active || !row.auto_reply_enabled) {
            fail(
              'A',
              `la fila existe pero está DESHABILITADA (is_active=${row.is_active}, auto_reply_enabled=${row.auto_reply_enabled}) — el bot guarda silencio por decisión del operador (eso NO es un fallo de clave).`,
            )
          }
          if (!row.api_key) fail('A', 'la fila no tiene api_key almacenada.')
        }
      }
    } catch (err) {
      fail('A', `error de red/lectura: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ---------------- PASO B: desencriptado ----------------
  step('B', 'Desencriptado de api_key con la ENCRYPTION_KEY activa')
  let plainKey = ''
  if (verdict.A === 'FAIL') {
    skip('B', 'no hay fila utilizable (Paso A falló).')
  } else if (!ENCRYPTION_KEY) {
    fail(
      'B',
      'ENCRYPTION_KEY no está definida en este entorno — decrypt() lanzaría aquí. Añade la variable (EasyPanel → Variables) y vuelve a ejecutar.',
    )
  } else if (!/^[0-9a-fA-F]{64}$/.test(ENCRYPTION_KEY)) {
    fail('B', 'ENCRYPTION_KEY no es una cadena de 64 caracteres hex — inválida.')
  } else {
    try {
      plainKey = decryptCipher(row.api_key, ENCRYPTION_KEY)
      if (!plainKey) {
        fail('B', 'la clave se desencriptó a una cadena VACÍA — re-guarda la clave desde Settings → AI Assistant.')
      } else {
        pass(
          'B',
          `desencriptación OK — fingerprint=${fingerprint(plainKey)} longitud=${plainKey.length} empiezaPor(sk-)=${plainKey.startsWith('sk-')}`,
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const mismatch = /unable to authenticate|bad decrypt|state mismatch|unsupported state|error:1E/i.test(msg)
      fail(
        'B',
        `decrypt() falló (${msg}). ` +
          (mismatch
            ? 'Esto es UN MISMATCH de ENCRYPTION_KEY: la clave con la que se guardó la API key NO es la de este entorno. Sincroniza ENCRYPTION_KEY entre EasyPanel/local y vuelve a guardar la clave desde el UI (el Save re-encripta con la clave activa).'
            : 'Revisa el formato del ciphertext en la BD.'),
      )
      say('        [CRITICAL_AI_KEY_ERROR]: No se pudo desencriptar la API Key. Verifica ENCRYPTION_KEY en las variables de entorno')
    }
  }

  // ---------------- PASO C: llamada real a OpenRouter ----------------
  const configuredModel = row?.model?.trim() || ''
  const models = [TEST_MODEL]
  if (configuredModel && configuredModel !== TEST_MODEL && !configuredModel.includes('/')) {
    // modelos tipo "gpt-4o" no son de OpenRouter: sólo probamos el modelo de prueba
  } else if (configuredModel && configuredModel !== TEST_MODEL) {
    models.push(configuredModel)
  }

  for (const model of models) {
    step('C', `POST /api/v1/chat/completions model=${model}`)
    const usingEnvFallback = !plainKey
    const key = plainKey || ENV_OPENROUTER_KEY
    if (!key) {
      skip(
        'C',
        'sin clave disponible (Paso B falló y no hay OPENROUTER_API_KEY en el entorno para el fallback).',
      )
      continue
    }
    if (usingEnvFallback) {
      say('        AVISO: usando OPENROUTER_API_KEY del entorno como fallback (esto NO valida la clave guardada en BD).')
    }
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://wacrm.tech',
          'X-Title': 'WACRM AI Assistant',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Responde exactamente con: OK' }],
          max_tokens: 20,
        }),
        signal: AbortSignal.timeout(30000),
      })
      const bodyText = await res.text()
      if (res.status === 200) {
        const body = JSON.parse(bodyText)
        const text = body?.choices?.[0]?.message?.content ?? ''
        pass('C', `HTTP 200 — respuesta del modelo: "${text.trim().slice(0, 120)}"`)
      } else {
        const map = {
          400: 'Bad Request — cuerpo o modelo no válido',
          401: 'Unauthorized — la clave NO es válida para OpenRouter',
          402: 'Payment Required — la clave no tiene créditos',
          404: 'Not Found — el modelo no existe en OpenRouter',
          429: 'rate limited',
        }
        fail('C', `HTTP ${res.status} — ${map[res.status] || 'error del proveedor'}: ${bodyText.slice(0, 300)}`)
      }
    } catch (err) {
      fail('C', `error de red: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ---------------- veredicto ----------------
  say('\n===== RESUMEN =====')
  for (const k of ['A', 'B', 'C']) say(`  Paso ${k}: ${verdict[k] ?? 'SKIP'}`)
  const anyFail = ['A', 'B', 'C'].some((k) => verdict[k] === 'FAIL')
  if (anyFail) {
    const first = ['A', 'B', 'C'].find((k) => verdict[k] === 'FAIL')
    say(`\nDIAGNÓSTICO: el primer fallo está en el Paso ${first}.`)
    if (first === 'A') say('  → El bot no tiene qué leer: fila ausente/deshabilitada o falta acceso a BD.')
    if (first === 'B') say('  → Causa raíz de "el bot dejó de responder": ENCRYPTION_KEY ausente o distinta de la usada al guardar. Sincronízala y re-guarda la clave desde el UI.')
    if (first === 'C') say('  → La BD y la encriptación están bien; el problema es la clave/modelo en OpenRouter (401/402/400 arriba).')
  }
  process.exit(anyFail ? 1 : 0)
}

main().catch((err) => {
  console.error('Error inesperado del script:', err)
  process.exit(1)
})
