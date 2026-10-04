import { SUBSCRIPTION_STATUS_LABELS, type SubscriptionStatus } from '@erp/shared';
import { Badge } from '@/components/ui';

/** A studio's subscription status — colour from theme tokens, always paired with the label. */
const COLOR: Record<SubscriptionStatus, 'gray' | 'green' | 'red' | 'blue' | 'amber'> = {
  UNMANAGED: 'gray',
  TRIAL: 'blue',
  ACTIVE: 'green',
  GRACE: 'amber',
  EXPIRED: 'red',
  SUSPENDED: 'gray',
};

export function StatusBadge({ status }: { status: SubscriptionStatus }) {
  // Suspended is the one neutral state that must stand out from "No plan": the dark end of the
  // gray scale, which every theme defines (a plain span, so no Badge colour class competes).
  if (status === 'SUSPENDED') return <span className="badge bg-gray-800 text-gray-0">{SUBSCRIPTION_STATUS_LABELS[status]}</span>;
  return <Badge color={COLOR[status]}>{SUBSCRIPTION_STATUS_LABELS[status]}</Badge>;
}

/** "12 days", "1 day", "-" — and "ended" once past the last day. */
export function daysLeftText(daysLeft: number | null): string {
  if (daysLeft === null) return '-';
  if (daysLeft < 1) return 'Ended';
  return `${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
}
