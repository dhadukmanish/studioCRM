import { useQuery } from '@tanstack/react-query';
import type { BillPayments, CustomerAdvance, PaymentAccountOption, PaymentMode, PendingBill, ReceiptRecord, ReceivableCustomer } from '@erp/shared';
import { api, qs } from '@/lib/api';

/**
 * Receipts' data access (`apps/api/src/routes/receipts.ts`). Every key starts with
 * `RECEIPTS_KEY`, so invalidating `'receipts'` after a receipt is saved or cancelled refreshes
 * the list, the record, the customer search and the pending bills in one go. A bill's payment
 * position lives under `BILL_PAYMENTS_KEY` and must be invalidated alongside `'bills'`.
 *
 * Every figure these return is the SERVER's — outstanding, paid and status are derived from
 * active allocations there and never recomputed here.
 */
export const RECEIPTS_KEY = 'receipts';
export const BILL_PAYMENTS_KEY = 'bill-payments';
export const RECEIPTS_URL = '/api/receipts';
/**
 * What a receipt save or cancel — or applying / reversing an advance — changes: receipts, the bills'
 * paid/outstanding, each bill's history, the receivables reports, and the work screens that show
 * a job's outstanding next to its progress.
 */
export const RECEIPT_INVALIDATES = [RECEIPTS_KEY, 'bills', BILL_PAYMENTS_KEY, 'receivables', 'work', 'delivery-report'];

/** A customer's advance still available (0 when none) — for the receipt form. */
export const useCustomerAdvance = (customerKey?: string | null) =>
  useQuery({
    queryKey: [RECEIPTS_KEY, 'advance', customerKey ?? ''],
    queryFn: () => api.get<CustomerAdvance>(`${RECEIPTS_URL}/advance${qs({ customer: customerKey })}`),
    enabled: !!customerKey,
  });

/** Apply advance to a bill. The amount is always the operator's explicit choice. */
export const applyAdvance = (billId: string, amount: number) => api.raw<{ message: string; data: { amount: number } }>('POST', `${RECEIPTS_URL}/apply-advance`, { billId, amount });
export const reverseAdvanceApplication = (id: string, reason?: string) => api.raw<{ message: string }>('POST', `${RECEIPTS_URL}/applications/${id}/reverse`, { reason: reason || null });

/** Customers with something outstanding, matching a name or mobile. The caller debounces. */
export const useReceivableCustomers = (search: string, enabled = true) =>
  useQuery({
    queryKey: [RECEIPTS_KEY, 'customers', 'search', search],
    queryFn: () => api.get<ReceivableCustomer[]>(`${RECEIPTS_URL}/customers${qs({ search })}`),
    placeholderData: (prev) => prev,
    staleTime: 15_000,
    enabled,
  });

/** Exactly one customer by key — answered even when nothing is outstanding (array of 0 or 1). */
export const useReceivableCustomer = (key?: string | null) =>
  useQuery({
    queryKey: [RECEIPTS_KEY, 'customers', 'key', key ?? ''],
    queryFn: () => api.get<ReceivableCustomer[]>(`${RECEIPTS_URL}/customers${qs({ key })}`),
    enabled: !!key,
  });

/** A customer's bills with an outstanding balance, oldest first — the order auto-allocation fills. */
export const usePendingBills = (customerKey?: string | null) =>
  useQuery({
    queryKey: [RECEIPTS_KEY, 'pending-bills', customerKey ?? ''],
    queryFn: () => api.get<PendingBill[]>(`${RECEIPTS_URL}/pending-bills${qs({ customer: customerKey })}`),
    enabled: !!customerKey,
  });

/** Active accounts that may receive money for a mode. The server re-validates the pick on save. */
export const usePaymentAccounts = (mode: PaymentMode) =>
  useQuery({
    queryKey: [RECEIPTS_KEY, 'accounts', mode],
    queryFn: () => api.get<PaymentAccountOption[]>(`${RECEIPTS_URL}/accounts${qs({ mode })}`),
    staleTime: 60_000,
  });

export const useReceipt = (id?: string) =>
  useQuery({
    queryKey: [RECEIPTS_KEY, 'record', id],
    queryFn: () => api.get<ReceiptRecord>(`${RECEIPTS_URL}/${id}`),
    enabled: !!id,
  });

/** A saved bill's payment position and receipt history (cancelled receipts included). */
export const useBillPayments = (billId?: string) =>
  useQuery({
    queryKey: [BILL_PAYMENTS_KEY, billId],
    queryFn: () => api.get<BillPayments>(`/api/bills/${billId}/payments`),
    enabled: !!billId,
  });

/** Where "Receive payment" goes: the new-receipt form, customer preselected, and that bill prefilled when one is named. */
export const receivePaymentHref = (customerKey: string, billId?: string, name?: string) => `/modules/receipts/new${qs({ customer: customerKey, bill: billId, name })}`;
