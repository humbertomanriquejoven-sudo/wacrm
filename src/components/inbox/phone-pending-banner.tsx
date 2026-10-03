'use client';

import { useState } from 'react';
import { Loader2, PhoneCall } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { updateContactPhone } from '@/lib/contacts/phone-api';
import { AWAITING_PHONE_NOTICE } from '@/lib/whatsapp/pending-reply-notice';

/**
 * Inbox banner for a bot reply that Meta would not accept.
 *
 * The customer already got a message from us and already got an answer
 * written for them — it just could not be delivered, because the contact
 * has no address Meta recognises (their phone number is still the BSUID
 * Meta assigned while they were unregistered). This banner is the whole
 * recovery flow:
 *
 *   - it says what is waiting, so the agent knows silence is our fault and
 *     not the customer's;
 *   - it collects the missing number inline, rather than sending the agent
 *     hunting through the Contacts page;
 *   - saving sends the held-back reply immediately, because the route that
 *     stores the number is the one that delivers it.
 *
 * Renders nothing when no reply is parked, so it costs a single conditional
 * on a conversation that is fine.
 */
interface PhonePendingBannerProps {
  contactId: string;
  /** Whether a reply is parked on this conversation. */
  awaitingValidPhone?: boolean | null;
  /** The held-back reply, used to tell the agent whether this is their
   *  own answer waiting or a fresh one the customer never received. */
  pendingReplyText?: string | null;
  /** Called once a number has been saved and the deferred replies flushed,
   *  so the parent can re-read the conversation (the banner clears and the
   *  delivered message appears in the thread). */
  onPhoneSaved?: () => void;
}

export function PhonePendingBanner({
  contactId,
  awaitingValidPhone,
  pendingReplyText,
  onPhoneSaved,
}: PhonePendingBannerProps) {
  const t = useTranslations('Inbox.phoneBanner');
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);

  if (!awaitingValidPhone) return null;

  async function handleSave() {
    setSaving(true);
    try {
      const result = await updateContactPhone(contactId, phone.trim());
      const sent = result.pending_replies_sent ?? 0;
      if (sent > 0) {
        toast.success(
          sent === 1
            ? t('sentOne')
            : t('sentMany', { count: sent })
        );
      } else {
        toast.success(t('saved'));
      }
      setOpen(false);
      setPhone('');
      onPhoneSaved?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs sm:px-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <PhoneCall className="h-4 w-4 flex-shrink-0 text-amber-500" />
        <p className="font-medium text-amber-600 dark:text-amber-400">
          {AWAITING_PHONE_NOTICE}
        </p>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted"
          >
            {t('addPhone')}
          </button>
        )}
      </div>

      {!open && pendingReplyText && (
        <p className="mt-1 truncate text-amber-600/80 dark:text-amber-400/80">
          {t('hint')}
        </p>
      )}

      {open && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="tel"
            inputMode="tel"
            autoFocus
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && phone.trim() && !saving) {
                void handleSave();
              }
            }}
            placeholder={t('placeholder')}
            aria-label={t('phoneLabel')}
            className="min-w-0 flex-1 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-foreground outline-none focus:border-amber-500/50 sm:max-w-xs"
          />
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !phone.trim()}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            {saving ? t('sending') : t('saveAndSend')}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setPhone('');
            }}
            disabled={saving}
            className="flex-shrink-0 px-1 py-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
          >
            {t('cancel')}
          </button>
        </div>
      )}
    </div>
  );
}