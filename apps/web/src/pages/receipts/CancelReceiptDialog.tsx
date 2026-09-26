import { useEffect, useState } from 'react';
import { RECEIPT_LIMITS, type ReceiptRecord } from '@erp/shared';
import { ConfirmDialog, TextInput } from '@/components/ui';
import { useSave } from '@/lib/queries';
import { fmtMoney } from '@/lib/format';
import { RECEIPT_INVALIDATES, RECEIPTS_URL } from '@/lib/receipts';

interface Target { id: string; receiptNumber: number; customerName: string; amount: number }

/**
 * Cancelling a receipt — the only way a wrong receipt is undone. It is never deleted: the
 * receipt stays in history as Cancelled and its allocations stop counting, so the bills it
 * settled go back to outstanding. The reason is optional and travels with the cancellation.
 */
export function CancelReceiptDialog({ receipt, onClose, onDone }: { receipt: Target | null; onClose: () => void; onDone?: (r: ReceiptRecord) => void }) {
  const [reason, setReason] = useState('');
  useEffect(() => setReason(''), [receipt?.id]);
  const cancel = useSave<{ reason: string | null }, ReceiptRecord>({
    invalidate: RECEIPT_INVALIDATES,
    onSuccess: (r) => {
      onClose();
      onDone?.(r);
    },
  });

  return (
    <ConfirmDialog
      open={!!receipt}
      onClose={onClose}
      loading={cancel.isPending}
      title="Cancel receipt?"
      confirmText="Cancel receipt"
      message={
        <>
          Cancel receipt <b>#{receipt?.receiptNumber}</b> of {fmtMoney(receipt?.amount)} from <b>{receipt?.customerName}</b>? The amounts it paid go back to
          outstanding on its bills. The receipt stays in history, marked Cancelled.
          <label className="label mt-4" htmlFor="cancel-receipt-reason">Reason (optional)</label>
          <TextInput
            id="cancel-receipt-reason"
            size="sm"
            maxLength={RECEIPT_LIMITS.cancelReason}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Entered against the wrong customer"
          />
        </>
      }
      onConfirm={() => receipt && cancel.mutate({ method: 'post', url: `${RECEIPTS_URL}/${receipt.id}/cancel`, body: { reason: reason.trim() || null } })}
    />
  );
}
