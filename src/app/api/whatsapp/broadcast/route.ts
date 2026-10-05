import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import {
  needsQuotedAnchor,
  recoverInboundWamids,
} from '@/lib/whatsapp/broadcast-address'
import {
  recipientAddressVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import { resolveTemplateRow } from '@/lib/whatsapp/template-body'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

/**
 * Two input shapes are accepted:
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     {
 *       recipients: Array<{ phone: string; params: string[] }>,
 *       template_name, template_language
 *     }
 *
 *   LEGACY (all phones receive the same params — kept so existing
 *   callers don't break):
 *     {
 *       phone_numbers: string[],
 *       template_params: string[],
 *       template_name, template_language
 *     }
 *
 * Previous implementation only supported the legacy shape, and the
 * sending hook was forced to ship every batch with `templateParams[0]`
 * — meaning every recipient got contact-0's personalization. The new
 * shape is what actually fixes that.
 */
interface NewRecipient {
  phone: string
  /**
   * The contact this recipient was resolved from. Used server-side to find
   * an inbound message to quote when the address is a bare @handle, which
   * Meta cannot accept as a destination on its own. Deliberately resolved
   * here rather than accepting a wamid from the client: the anchor has to
   * belong to this contact's own conversation, or a caller could quote
   * messages they cannot see.
   */
  contact_id?: string
  /** Body variable values, one per {{N}}. Legacy field. */
  params?: string[]
  /**
   * Structured per-send values (header text variable, media URL
   * override, URL/COPY_CODE button values). When set, takes
   * precedence over `params` for the body too — see
   * sendTemplateMessage for the merge rules.
   */
  messageParams?: SendTimeParams
}

export async function POST(request: Request) {
  try {
    // Requires the 'agent' role — `canSendMessages` in lib/auth/roles is
    // explicit that running broadcasts is a write operation and that
    // viewers are read-only.
    //
    // This endpoint writes NOTHING to the database: it reads the config
    // and template, then calls Meta directly. So unlike the rest of the
    // app there was no RLS policy backstopping a missing role check —
    // resolving `account_id` straight off the profile (which only needs
    // 'viewer') was the ONLY gate, and it let a viewer blast a template
    // to arbitrary phone numbers from the account's WhatsApp number.
    // Nothing about that is recoverable after the fact, so the check has
    // to happen here.
    const { supabase, accountId, userId } = await requireRole('agent')

    // Per-user broadcast budget. Note: this limits how often a user
    // can *start* a campaign, not how many messages go out inside
    // one — the fan-out loop below runs without additional gating.
    const limit = checkRateLimit(`broadcast:${userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
    } = body

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      )
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 }
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Load the template row once so sendTemplateMessage can build
    // header + button components on each iteration. Loading inside
    // the loop would N+1 against Supabase for every recipient.
    // Guard against a malformed local row crashing every send in
    // the loop with the same opaque TypeError — fail loudly once.
    const resolvedTemplate = await resolveTemplateRow(
      supabase,
      accountId,
      template_name,
      template_language,
    )
    if (resolvedTemplate.malformed) {
      return NextResponse.json(
        {
          error:
            'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
        },
        { status: 500 },
      )
    }
    const templateRow = resolvedTemplate.row

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    // One batched lookup for the whole campaign, and only when some
    // recipient actually needs an anchor — a broadcast of plain numbers
    // pays nothing for this.
    const needsAnyQuote = recipients.some((r) =>
      needsQuotedAnchor(typeof r?.phone === 'string' ? r.phone : ''),
    )
    const wamidsByContact = needsAnyQuote
      ? await recoverInboundWamids(
          supabase,
          recipients
            .map((r) => (typeof r?.contact_id === 'string' ? r.contact_id : ''))
            .filter((id) => id.length > 0),
        )
      : new Map<string, string>()

    for (const recipient of recipients) {
      // Only an EMPTY address is undeliverable. This used to additionally
      // demand `isValidE164(...)`, which rejected every BSUID and @handle —
      // the exact addresses the Inbox delivers to successfully.
      const variants = recipientAddressVariants(recipient.phone)

      if (variants.length === 0) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Missing recipient address',
        })
        failedCount++
        continue
      }

      let sentMessageId: string | null = null
      let lastError: string | null = null

      // A bare @handle is not a destination Meta accepts: it answers
      // (#100) Invalid parameter, or 200 with the message silently dropped.
      // The one supported route to such a contact is a quoted reply anchored
      // on a message they actually wrote, so resolve that anchor here.
      //
      // Only for the handle bucket. A dialable number needs nothing, and an
      // opaque Meta id (BSUID / WAID) is addressable on its own — quoting it
      // would turn an ordinary send into a reply for no reason.
      const needsQuote = needsQuotedAnchor(recipient.phone)

      let contextMessageId: string | undefined
      if (needsQuote) {
        const contactId =
          typeof recipient.contact_id === 'string' ? recipient.contact_id : ''
        const wamid = contactId ? wamidsByContact.get(contactId) : undefined
        if (!wamid) {
          // Refuse locally rather than fire a request that cannot deliver.
          results.push({
            phone: recipient.phone,
            status: 'failed',
            error: 'Requires phone number or previous inbound message',
          })
          failedCount++
          continue
        }
        contextMessageId = wamid
      }

      for (const variant of variants) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: template_name,
            language: resolvedTemplate.language,
            template: templateRow ?? undefined,
            messageParams: recipient.messageParams,
            params: recipient.params ?? [],
            ...(contextMessageId ? { contextMessageId } : {}),
          })
          sentMessageId = result.messageId
          lastError = null
          break
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error'
          if (!isRecipientNotAllowedError(errorMessage)) {
            lastError = errorMessage
            break
          }
          lastError = errorMessage
          // retry with next variant
        }
      }

      if (sentMessageId) {
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
        })
        sentCount++
      } else {
        console.error(
          `Failed to send broadcast to ${recipient.phone}:`,
          lastError
        )
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || 'Unknown error',
        })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    })
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp broadcast POST:', error)
    return toErrorResponse(error)
  }
}
