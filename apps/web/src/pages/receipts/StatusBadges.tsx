import { BILL_PAYMENT_STATUS_LABELS, RECEIPT_STATUS_LABELS, type BillPaymentStatus, type ReceiptStatus } from '@erp/shared';
import { Badge } from '@/components/ui';

/** Status is always spelled out — the colour only repeats what the text says. */
const PAYMENT_COLOR = { UNPAID: 'amber', PARTIALLY_PAID: 'blue', PAID: 'green' } as const;

export const BillPaymentStatusBadge = ({ status }: { status: BillPaymentStatus }) => <Badge color={PAYMENT_COLOR[status]}>{BILL_PAYMENT_STATUS_LABELS[status]}</Badge>;

export const ReceiptStatusBadge = ({ status }: { status: ReceiptStatus }) => <Badge color={status === 'ACTIVE' ? 'green' : 'red'}>{RECEIPT_STATUS_LABELS[status]}</Badge>;
