import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { RATE_LIMITS } from '@/lib/rate-limit'

/**
 * GET /api/ai/health
 *
 * Read-only diagnostic for "the WhatsApp bot is not answering". The
 * inbound path is asynchronous (`after()`) and every eligibility gate in
 * `dispatchInboundToAiReply` reads DATABASE STATE, so a silent bot and a
 * healthy one look identical from the outside. This endpoint reports each
 * gate's current value for the caller's account so the blocker can be read
 * directly instead of inferred.
 *
 * Uses the service-role client (bypasses RLS) so it reports what the bot
 * itself sees, not what the dashboard user is allowed to see. Returns
 * configuration state only — never a decrypted key or access token, just
 * booleans.
 */
export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const db = supabaseAdmin()
    const problems: string[] = []

    // ---- 1. Environment --------------------------------------------
    const env = {
      META_APP_SECRET: Boolean(process.env.META_APP_SECRET),
      ENCRYPTION_KEY: Boolean(process.env.ENCRYPTION_KEY),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    }
    if (!env.META_APP_SECRET) {
      problems.push(
        'META_APP_SECRET is not set — every webhook POST is rejected with 401, so no inbound ever reaches the bot.'
      )
    }
    if (!env.ENCRYPTION_KEY) {
      problems.push(
        'ENCRYPTION_KEY is not set — stored tokens/keys cannot be decrypted.'
      )
    }

    // ---- 2. WhatsApp channel ---------------------------------------
    // The webhook resolves the account by `phone_number_id`; 0 rows or >1
    // rows drops the inbound before any contact/message work.
    const { data: waRows, error: waErr } = await db
      .from('whatsapp_config')
      .select('id, phone_number_id, account_id, access_token')
      .eq('account_id', accountId)

    let accessTokenDecryptable: boolean | null = null
    if (waErr) {
      problems.push(`Could not read whatsapp_config: ${waErr.message}`)
    } else if (!waRows || waRows.length === 0) {
      problems.push(
        'No whatsapp_config row for this account — inbound messages cannot be matched to it.'
      )
    } else {
      if (waRows.length > 1) {
        problems.push(
          `${waRows.length} whatsapp_config rows share this account; each phone_number_id must map to exactly one.`
        )
      }
      try {
        decrypt(waRows[0].access_token)
        accessTokenDecryptable = true
      } catch (err) {
        accessTokenDecryptable = false
        problems.push(
          `whatsapp_config.access_token could not be decrypted (${err instanceof Error ? err.message : err}) — ENCRYPTION_KEY does not match the stored value.`
        )
      }
    }

    // ---- 3. AI configuration ---------------------------------------
    // `is_active` and `auto_reply_enabled` BOTH default to false. The bot
    // is silent unless both are true.
    const { data: aiRows, error: aiErr } = await db
      .from('ai_configs')
      .select(
        'provider, model, is_active, auto_reply_enabled, auto_reply_max_per_conversation, api_key, handoff_agent_id'
      )
      .eq('account_id', accountId)
      .maybeSingle()

    let aiKeyDecryptable: boolean | null = null
    if (aiErr) {
      problems.push(`Could not read ai_configs: ${aiErr.message}`)
    } else if (!aiRows) {
      problems.push(
        'No ai_configs row for this account — the bot has no provider/key to call.'
      )
    } else {
      if (!aiRows.is_active) {
        problems.push(
          'ai_configs.is_active is false — the AI master switch is off.'
        )
      }
      if (!aiRows.auto_reply_enabled) {
        problems.push(
          'ai_configs.auto_reply_enabled is false — the auto-reply toggle is off.'
        )
      }
      if (!aiRows.api_key) {
        problems.push('ai_configs.api_key is empty.')
      } else {
        try {
          decrypt(aiRows.api_key)
          aiKeyDecryptable = true
        } catch (err) {
          aiKeyDecryptable = false
          problems.push(
            `ai_configs.api_key could not be decrypted (${err instanceof Error ? err.message : err}) — ENCRYPTION_KEY does not match.`
          )
        }
      }
    }

    // ---- 4. Standing down the bot ----------------------------------
    // ANY active automation on these triggers makes dispatchInboundToAiReply
    // return before it ever calls the provider.
    const { data: standing } = await db
      .from('automations')
      .select('id, name, trigger_type, is_active')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])

    if (standing && standing.length > 0) {
      problems.push(
        `${standing.length} active automation(s) answer "new_message_received"/"keyword_match", which makes the AI bot stand down entirely: ` +
          standing.map((a) => `${a.name ?? a.id} (${a.trigger_type})`).join(', ')
      )
    }

    // ---- 5. Human-claimed threads ----------------------------------
    // `assigned_agent_id` IS the pause flag (there is no `is_paused`
    // column). Any conversation holding one is skipped by the bot.
    const { count: assignedCount } = await db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .not('assigned_agent_id', 'is', null)

    if (assignedCount && assignedCount > 0) {
      problems.push(
        `${assignedCount} conversation(s) still have assigned_agent_id set; the bot skips every one of them.`
      )
    }

    // ---- 6. Inbound vs bot replies (the smoking gun) ---------------
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const [inbound24, bot24, inbound7d, bot7d] = await Promise.all([
      db
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_type', 'customer')
        .gte('created_at', since),
      db
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_type', 'bot')
        .gte('created_at', since),
      db
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_type', 'customer')
        .gte('created_at', since7d),
      db
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_type', 'bot')
        .gte('created_at', since7d),
    ])

    const lastInbound = await db
      .from('messages')
      .select('created_at, conversation_id')
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const lastBot = await db
      .from('messages')
      .select('created_at, conversation_id')
      .eq('sender_type', 'bot')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // ---- 7. Legacy reply counter -----------------------------------
    const { data: stuckCounters } = await db
      .from('conversations')
      .select('id, ai_reply_count')
      .eq('account_id', accountId)
      .gt('ai_reply_count', 0)
      .limit(20)

    return NextResponse.json({
      ok: problems.length === 0,
      problems,
      env,
      whatsapp: {
        configured: (waRows?.length ?? 0) > 0,
        rows: waRows?.length ?? 0,
        phoneNumberIds: waRows?.map((r) => r.phone_number_id) ?? [],
        accessTokenDecryptable,
      },
      ai: aiRows
        ? {
            provider: aiRows.provider,
            model: aiRows.model,
            isActive: aiRows.is_active,
            autoReplyEnabled: aiRows.auto_reply_enabled,
            maxPerConversation: aiRows.auto_reply_max_per_conversation,
            handoffAgentId: aiRows.handoff_agent_id,
            apiKeyDecryptable: aiKeyDecryptable,
          }
        : null,
      automationsStandingDownTheBot: standing ?? [],
      conversationsWithAssignedAgent: assignedCount ?? 0,
      traffic: {
        last24h: { inbound: inbound24.count ?? 0, botReplies: bot24.count ?? 0 },
        last7d: { inbound: inbound7d.count ?? 0, botReplies: bot7d.count ?? 0 },
        lastInboundAt: lastInbound.data?.created_at ?? null,
        lastBotReplyAt: lastBot.data?.created_at ?? null,
      },
      conversationsWithNonZeroReplyCounter: stuckCounters ?? [],
      rateLimit: RATE_LIMITS.aiAutoReplyAccount,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}