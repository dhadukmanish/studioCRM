import { AlertTriangle } from 'lucide-react';
import { SUBSCRIPTION_GRACE_DAYS, SUBSCRIPTION_WARN_DAYS, type SubscriptionAccess } from '@erp/shared';
import { useDateFormatters } from '@/lib/settings';
import { cx } from '@/lib/format';

const dayCount = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/**
 * The studio's subscription warning — a slim strip above every page, never dismissible, shown only
 * when it matters: the last SUBSCRIPTION_WARN_DAYS of a trial or plan, the grace period, and once
 * expired (read-only). Nothing for an unmanaged studio or one with days to spare. A suspended
 * studio never gets here — it is signed out (403 SUB_003).
 */
export function SubscriptionBanner({ access }: { access?: SubscriptionAccess | null }) {
  const fmt = useDateFormatters();
  if (!access?.endsOn || access.daysLeft === null) return null;
  const ends = fmt.date(access.endsOn);
  let text: string | null = null;
  if ((access.status === 'TRIAL' || access.status === 'ACTIVE') && access.daysLeft <= SUBSCRIPTION_WARN_DAYS) {
    text = `Your ${access.status === 'TRIAL' ? 'trial' : 'subscription'} ends on ${ends} — ${dayCount(access.daysLeft)} left. Contact your provider to renew.`;
  } else if (access.status === 'GRACE') {
    // daysLeft is 0, -1, … during grace; full access lasts SUBSCRIPTION_GRACE_DAYS past the last paid day.
    text = `Your subscription ended on ${ends}. Renew within ${dayCount(Math.max(1, access.daysLeft + SUBSCRIPTION_GRACE_DAYS))} to avoid read-only mode.`;
  } else if (access.status === 'EXPIRED') {
    text = `Subscription expired on ${ends} — the account is read-only. You can still view and print.`;
  }
  if (!text) return null;
  const expired = access.status === 'EXPIRED';
  return (
    <div role={expired ? 'alert' : 'status'} className={cx('flex shrink-0 items-center gap-2 border-b border-line px-4 py-1.5 text-[13px] sm:px-6', expired ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800')}>
      <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={1.5} />
      <span className="min-w-0">{text}</span>
    </div>
  );
}
