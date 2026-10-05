import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import {
  NO_DELIVERABLE_ADDRESS,
  resolveBroadcastAddress,
} from '@/lib/whatsapp/broadcast-address'
import type { BroadcastIdentity } from '@/lib/whatsapp/broadcast-address'
import {
  recipientAddressVariants,
  isRecipientNotAllowedError,
  isDialablePhone,
} from '@/lib/whatsapp/phone-utils'
import { isOpaqueMetaId } from '@/lib/whatsapp/meta-api'
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
  /**
   * Echoed back so the caller can match this result to a recipient row
   * without going through the address.
   *
   * Matching by address string cannot work once the SERVER resolves the
   * destination: the address the client sent is only a hint, and for a
   * contact with phone = 'unknown' the value that was actually delivered to
   * is a BSUID the client never saw. Keying on `contact_id` also collapses
   * two contacts that happen to share a number into one result, which the
   * previous phone-keyed lookup silently did.
   */
  contact_id?: string
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

    // --- Server-side address hydration (first attempt, no refresh needed) ---
    //
    // This endpoint used to derive every destination from the `phone` STRING
    // the client sent, via `recipientAddressVariants(recipient.phone)`, and to
    // never read `contacts` at all. For a contact whose row says
    // phone = 'unknown' — which is what the webhook writes when Meta discloses
    // no number — that produced no usable variant, the recipient was rejected
    // as NO_DELIVERABLE_ADDRESS, and the campaign lost a person it could
    // actually reach: the numerical Meta id (wa_id / recipient_id / wa_user_id)
    // was sitting on the same row the request had just named by contact_id.
    //
    // Worse, it made the send depend on whatever the browser happened to hold:
    // the first attempt used whatever identity columns the client's list had at
    // that moment, and a refresh or retry re-read the row and got a different
    // answer for the same contact. Destination resolution has no business
    // depending on client-side cache state, so the row is read HERE, at send
    // time, and resolved with the same `resolveBroadcastAddress` the Inbox
    // uses — one code path, so Broadcasts cannot drift from Inbox again.
    //
    // One batched query for the whole campaign. A per-recipient SELECT would be
    // an N+1 against Supabase for every send, which is the opposite of what
    // this endpoint is for.
    const identityByContactId = new Map<string, BroadcastIdentity>()
    {
      const contactIds = [
        ...new Set(
          recipients
            .map((r) => r.contact_id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0),
        ),
      ]

      if (contactIds.length > 0) {
        const { data: identityRows, error: identityError } = await supabase
          .from('contacts')
          .select(
            'id, account_id, phone, wa_id, recipient_id, wa_user_id, username',
          )
          .eq('account_id', accountId)
          .in('id', contactIds)

        if (identityError) {
          // Fail loudly rather than silently degrading to phone-only
          // resolution, which is the failure this whole block exists to fix.
          console.error(
            'Failed to hydrate broadcast recipient identities:',
            identityError,
          )
          return NextResponse.json(
            {
              error:
                'Could not load recipient delivery addresses from the contact records. Nothing was sent.',
            },
            { status: 500 },
          )
        }

        for (const row of identityRows ?? []) {
          // The account_id filter above is the tenant boundary. A caller cannot
          // name a contact from another account to borrow its address.
          if (row.account_id !== accountId) continue
          identityByContactId.set(row.id, row)
        }
      }
    }

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    for (const recipient of recipients) {
      // Preferred destination: the authoritative contact row, resolved
      // server-side. `resolveBroadcastAddress` walks phone -> wa_id ->
      // recipient_id -> wa_user_id -> history-derived id, so a visible number
      // and a hidden number are both handled by the same call and a visible
      // number still wins outright.
      const identity = recipient.contact_id
        ? identityByContactId.get(recipient.contact_id)
        : undefined
      const resolvedAddress = identity
        ? resolveBroadcastAddress(identity)
        : null

      // Fallback for callers with no contact_id (legacy CSV upload, raw
      // phone_numbers), which have no row to consult.
      const variants = resolvedAddress
        ? [resolvedAddress.to]
        : recipientAddressVariants(recipient.phone)

      // Only a dialable number or an opaque Meta id is a destination. This
      // used to additionally demand `isValidE164(...)`, which rejected every
      // BSUID recipient — the exact addresses the Inbox delivers to
      // successfully.
      //
      // A bare @handle is rejected here even though it produces a non-empty
      // variant list. Meta answers `(#100) Invalid parameter` for a text
      // handle in `to`, and `context.message_id` does not change that:
      // quoting makes the send a reply, it does not make the handle
      // addressable. Failing here keeps the local reason instead of risking a
      // 200 with the message silently dropped.
      const addressable =
        variants.length > 0 &&
        (isDialablePhone(variants[0]) || isOpaqueMetaId(variants[0]))

      if (!addressable) {
        results.push({
          contact_id: recipient.contact_id,
          phone: recipient.phone,
          status: 'failed',
          // Name the missing column so the operator knows which id to fix,
          // instead of a bare "no address" that reads like bad luck.
          error: identity
            ? `${NO_DELIVERABLE_ADDRESS} (contact ${identity.phone ?? 'no phone'} / wa_id=${identity.wa_id ?? 'null'} / recipient_id=${identity.recipient_id ?? 'null'} / wa_user_id=${identity.wa_user_id ?? 'null'})`
            : NO_DELIVERABLE_ADDRESS,
        })
        failedCount++
        continue
      }

      let sentMessageId: string | null = null
      let lastError: string | null = null

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
          contact_id: recipient.contact_id,
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
          contact_id: recipient.contact_id,
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
