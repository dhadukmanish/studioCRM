import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Controller, FormProvider, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, Download, FileText, MessageCircle } from 'lucide-react';
import {
  BILL_DISCOUNT_TYPES,
  BILL_DISCOUNT_TYPE_SHORT,
  BILL_LIMITS,
  BOOK_SERIES_TYPE_LABELS,
  billDiscountError,
  calculateBill,
  formatGst,
  invoiceFileName,
  normalizeMobile,
  type BillDiscountType,
  type GstSummaryRow,
} from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { EmptyState, Select, Spinner, TextInput, type Option } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { downloadInvoicePdf } from '@/lib/invoice';
import { toast } from '@/lib/toast';
import { ShareInvoiceDialog } from '@/components/invoice/ShareInvoiceDialog';
import { applyApiErrors, useBooksLookup, useDefaultBillingBook, useItemsLookup, useSave, type AppointmentLookup } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';
import { cx, fmtMoney, todayISO } from '@/lib/format';
import { BillHeaderFields } from './BillHeaderFields';
import { BillLinesGrid } from './BillLinesGrid';
import { BillPaymentsPanel } from './BillPaymentsPanel';
import { BillStudioStatus } from './BillStudioStatus';
import { BillAdvanceEntry, EMPTY_ADVANCE, advancePayload, type AdvanceDraft, type AdvanceErrors } from './BillAdvanceEntry';
import { useBillPayments, useCustomerAdvance } from '@/lib/receipts';
import { emptyLine, type BillFormValues, type BillLineFormValues, type BillRecord } from './types';

const PERMISSION = 'operations_billing';
const URL = '/api/bills';
const QUERY_KEY = 'bills';

/* ------------------------------------------------------------------ route -- */

/**
 * The billing workspace — one route for both `/modules/billing/new` and `/modules/billing/:id`.
 *
 * A bill is a document with lines, so it gets a full page rather than a dialog: the header,
 * the grid and the totals have to be visible at the same time on a 1366x768 screen, which is
 * exactly what a modal cannot give. Layout priority top to bottom is header, then lines, then
 * totals — the order the operator fills them in.
 */
export default function BillFormPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();

  const record = useQuery({
    queryKey: [QUERY_KEY, 'record', id],
    queryFn: () => api.get<BillRecord>(`${URL}/${id}`),
    enabled: !!id,
  });

  if (id && record.isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="h-6 w-6 text-primary" />
      </div>
    );
  }
  if (id && (record.isError || !record.data)) {
    return (
      <EmptyState
        title="Bill could not be loaded"
        description={record.error instanceof Error ? record.error.message : 'The bill may have been deleted.'}
        action={
          <div className="flex items-center gap-2">
            <button type="button" className="btn-outline" onClick={() => nav('/modules/billing')}>Back to bills</button>
            <button type="button" className="btn-primary" onClick={() => record.refetch()}>Try again</button>
          </div>
        }
      />
    );
  }
  // Remounting per bill keeps the form's defaults honest — no reset effect to get wrong.
  return <BillForm key={id ?? 'new'} bill={record.data} />;
}

/* ------------------------------------------------------------------- form -- */

const toForm = (bill?: BillRecord): BillFormValues => ({
  bookId: bill?.bookId ?? '',
  appointmentId: bill?.appointmentId ?? '',
  billDate: bill?.billDate ?? todayISO(),
  deliveryDate: bill?.deliveryDate ?? '',
  customerName: bill?.customerName ?? '',
  // A bill saved before the 10-digit rule may hold "+91 98765 43210": shown as its customer KEY (the
  // normalized digits, last ten), so re-saving it is not a mobile change — see `legacyMobileKey`.
  mobileNumber: bill ? normalizeMobile(bill.mobileNumber) : '',
  babyName: bill?.babyName ?? '',
  hasBirthDate: bill?.hasBirthDate ?? false,
  birthDate: bill?.birthDate ?? '',
  remark: bill?.remark ?? '',
  nextVisitDate: bill?.nextVisitDate ?? '',
  // A new bill's mode follows the selected book (set below); a saved bill keeps its own.
  taxMode: bill?.taxMode ?? 'WITH_GST',
  discountType: bill?.discountType ?? 'NONE',
  // NONE stores 0; showing it as an empty box keeps the control quiet until it is used.
  discountValue: bill && bill.discountType !== 'NONE' ? String(bill.discountValue) : '',
  // A new bill opens with one blank line, because every bill has at least one.
  items: bill ? bill.items.map(toFormLine) : [emptyLine()],
});

/**
 * A saved line back into the form. The GST rate comes from the line's SNAPSHOT, not from the
 * item's rate today: a bill saved at 12% must keep reading as 12% even after Item Master
 * moves. Choosing a different item replaces it with the current one, which is correct — that
 * is a different line.
 */
const toFormLine = (l: BillRecord['items'][number]): BillLineFormValues => ({
  itemId: l.itemId,
  subItemId: l.subItemId,
  itemName: l.itemNameSnapshot,
  productName: l.subItemNameSnapshot,
  gstRate: l.gstRateSnapshot,
  quantity: String(l.quantity),
  rate: String(l.rate),
  remark: l.remark ?? '',
});

/** Optional text as the API wants it: trimmed, and empty is NULL, never '' and never undefined. */
const blank = (v?: string | null) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** A v4 UUID for the create request — `randomUUID` where the browser has it (secure contexts), else from random bytes. */
function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The server's refusals of the advance (`advance.amount`, `advance.accountId` …) back onto the Advance fields. */
function advanceErrorsOf(e: unknown): AdvanceErrors {
  if (!(e instanceof ApiError) || !Array.isArray(e.details)) return {};
  const out: AdvanceErrors = {};
  for (const d of e.details as { path?: (string | number)[]; message: string }[]) {
    const [first, field] = d.path ?? [];
    if (first === 'advance') out[field === 'accountId' || field === 'paymentMode' ? field : 'amount'] = d.message;
  }
  return out;
}

function BillForm({ bill }: { bill?: BillRecord }) {
  const nav = useNavigate();
  const can = useAuthStore((s) => s.can);
  const allowed = can(PERMISSION, bill ? 'update' : 'create');

  const form = useForm<BillFormValues>({ defaultValues: toForm(bill) });
  const { control, handleSubmit, register, setValue, setError, formState: { errors, isDirty } } = form;
  const { fields, insert, remove } = useFieldArray({ control, name: 'items' });

  const books = useBooksLookup();
  const items = useItemsLookup();
  const bookOptions: Option[] = useMemo(() => (books.data ?? []).map((b) => ({ value: b.id, label: b.bookNumber, sub: BOOK_SERIES_TYPE_LABELS[b.seriesType] })), [books.data]);

  /**
   * A NEW bill opens on the server's default book (the only active one, the configured default,
   * the last used, or a stable first) — a suggestion the operator can change, and it takes no
   * number. Applied once, and never over a book the operator already picked.
   */
  const defaultBook = useDefaultBillingBook(!bill);
  const bookId = useWatch({ control, name: 'bookId' });
  useEffect(() => {
    const suggested = defaultBook.data?.bookId;
    if (bill || !suggested || form.getValues('bookId')) return;
    setValue('bookId', suggested);
  }, [bill, defaultBook.data, form, setValue]);

  /** The book decides the tax mode of a new bill; the preview follows it as the book changes. */
  useEffect(() => {
    if (bill) return;
    const book = books.data?.find((b) => b.id === bookId);
    if (book) setValue('taxMode', book.seriesType);
  }, [bill, bookId, books.data, setValue]);
  const itemOptions: Option[] = useMemo(() => (items.data ?? []).map((i) => ({ value: i.id, label: i.itemName })), [items.data]);

  /**
   * `useWatch`, not `watch`: the quantity and rate inputs are registered two levels down in
   * `BillLineRow`, and `watch('items')` here did not re-render this component when one of
   * them changed — the operator typed a quantity and went on seeing 0.00 until something else
   * happened to re-render the page. Found in a browser, and fixed by subscribing properly.
   */
  const watched = (useWatch({ control, name: 'items' }) ?? []) as Partial<BillLineFormValues>[];
  /**
   * One row per field-array entry, so the grid, the preview and the payload are provably the
   * same lines. The watched array can briefly disagree with `fields` right after a line is
   * removed — which rendered a row with no React key and then crashed the save on a line whose
   * values no longer existed. Driving everything off `fields` removes that whole class of bug.
   */
  const lines: BillLineFormValues[] = fields.map((_f, i) => ({ ...emptyLine(), ...(watched[i] ?? {}) }));
  const taxMode = useWatch({ control, name: 'taxMode' });
  const discountType = useWatch({ control, name: 'discountType' });
  const discountValue = useWatch({ control, name: 'discountValue' });
  const appointmentId = useWatch({ control, name: 'appointmentId' });
  const [linkedNo, setLinkedNo] = useState<number | null>(bill?.appointmentNumber ?? null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [lineCountError, setLineCountError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  /** A NEW bill's Advance box (money received now) — becomes a receipt in the bill's own save. */
  const canAdvance = !bill && can('operations_receipts', 'create');
  const [advance, setAdvance] = useState<AdvanceDraft>(EMPTY_ADVANCE);
  const [advanceErrors, setAdvanceErrors] = useState<AdvanceErrors>({});
  const changeAdvance = useCallback((next: AdvanceDraft) => {
    setAdvance(next);
    setAdvanceErrors({});
  }, []);
  /** One id per new-bill form: a retried or double-submitted save returns the bill it already made. */
  const [requestId] = useState(newRequestId);
  /** Money the customer paid EARLIER (before this bill) — shown, applied only after saving, by hand. */
  const typedMobile = normalizeMobile(useWatch({ control, name: 'mobileNumber' }) ?? '');
  const earlier = useCustomerAdvance(!bill && can('operations_receipts') && typedMobile.length === 10 ? typedMobile : null);
  /** A saved bill's Paid / Due — the server's derived figures, never recomputed here. */
  const payments = useBillPayments(bill?.id);

  /**
   * The preview. Every figure on this screen comes out of `calculateBill` in `@erp/shared` —
   * the same function the API runs inside the bill's transaction. Nothing here adds, multiplies
   * or rounds money; if these two ever disagreed, the server's answer would be the bill.
   */
  const preview = useMemo(
    () =>
      calculateBill(
        lines.map((l) => ({ quantity: Number(l.quantity) || 0, rate: Number(l.rate) || 0, gstRate: l.gstRate ?? 0 })),
        taxMode,
        { type: discountType, value: Number(discountValue) || 0 },
      ),
    [lines, taxMode, discountType, discountValue],
  );

  /**
   * Why the typed discount would be refused, from the SAME function the API validates with
   * (`billDiscountError` in `@erp/shared`) — so the warning the operator sees while typing and
   * the error the server returns on save can never be different rules. Shown, not enforced:
   * the save is still the server's decision.
   */
  const discountWarning = billDiscountError({ type: discountType, value: Number(discountValue) || 0 }, preview.totals.subTotal);

  /**
   * Switching the discount off clears what was typed — NONE means there is no discount at all.
   * `<Select>` always carries a blank placeholder option; choosing it means the same thing.
   */
  const pickDiscountType = (next: string) => {
    const type = (next || 'NONE') as BillDiscountType;
    setValue('discountType', type, { shouldDirty: true });
    if (type === 'NONE') setValue('discountValue', '', { shouldDirty: true });
  };

  /**
   * A new blank line right AFTER `after` (a row's + button), or at the end when `after` is omitted
   * (Enter on the last line, the empty-state button), and the caret goes to its Item cell.
   */
  const addLine = useCallback(
    (after?: number) => {
      if (fields.length >= BILL_LIMITS.maxLines) return;
      const at = after === undefined ? fields.length : after + 1;
      insert(at, emptyLine(), { shouldFocus: false });
      setLineCountError(null);
      setFocusIndex(at);
    },
    [insert, fields.length],
  );

  /** Enter at the end of a line: on to the next one, or a new one when this was the last. */
  const nextLine = useCallback(
    (index: number) => (index < fields.length - 1 ? setFocusIndex(index + 1) : addLine()),
    [addLine, fields.length],
  );

  // 'appointments': a next visit creates or moves an appointment in the same save.
  const save = useSave<Record<string, unknown>, BillRecord>({ invalidate: [QUERY_KEY, 'bill-invoice', 'bill-payments', 'receipts', 'receivables', 'appointments'], onSuccess: () => nav('/modules/billing') });

  const submit = handleSubmit((v) => {
    if (lines.length === 0) {
      setLineCountError('Add at least one item before saving this bill.');
      return;
    }
    setLineCountError(null);
    const header = {
      appointmentId: v.appointmentId || null,
      billDate: v.billDate,
      deliveryDate: blank(v.deliveryDate),
      customerName: (v.customerName ?? '').trim(),
      mobileNumber: (v.mobileNumber ?? '').trim(),
      babyName: blank(v.babyName),
      hasBirthDate: v.hasBirthDate,
      birthDate: v.hasBirthDate ? blank(v.birthDate) : null,
      remark: blank(v.remark),
      nextVisitDate: blank(v.nextVisitDate),
      // No taxMode: the book decides it (new) or the saved bill keeps it (edit) — the server's call.
      // The pair the operator chose. What it is worth in money is the server's answer, and
      // so is each line's share of it — neither is in this payload.
      discountType: v.discountType,
      discountValue: v.discountValue,
      /**
       * The lines exactly as the grid shows them — identifiers and typed values only. No
       * snapshot, no amount, no bill number: the server resolves the names, the HSN, the GST
       * rate and every total for itself, and ignores anything else a payload carries.
       */
      items: lines.map((l) => ({ itemId: l.itemId, subItemId: l.subItemId, quantity: l.quantity, rate: l.rate, remark: blank(l.remark) })),
    };
    // Only a new bill carries money; an existing bill's payments go through receipts.
    const adv = canAdvance ? advancePayload(advance) : { advance: null, errors: {} };
    setAdvanceErrors(adv.errors);
    if (Object.keys(adv.errors).length) return;
    save.mutate(
      // The book and the bill number are fixed at creation, so an update does not carry them.
      bill ? { method: 'put', url: `${URL}/${bill.id}`, body: header } : { method: 'post', url: URL, body: { ...header, bookId: v.bookId, advance: adv.advance, requestId } },
      {
        onError: (e) => {
          applyApiErrors(e, setError);
          setAdvanceErrors(advanceErrorsOf(e));
        },
      },
    );
  });

  // Ctrl/Cmd+S saves from anywhere on the page — the grid's Enter belongs to the next line.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (allowed) submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit, allowed]);

  const pickAppointment = (a: AppointmentLookup) => {
    setValue('appointmentId', a.id, { shouldDirty: true });
    // Only the fields the booking is about — the bill's own date, book and lines are not its business.
    setValue('mobileNumber', a.mobileNumber, { shouldDirty: true });
    setValue('customerName', a.customerName, { shouldDirty: true });
    if (a.babyName) setValue('babyName', a.babyName, { shouldDirty: true });
    setLinkedNo(a.appointmentNumber);
  };
  /** Removes the LINK only. What was typed into the bill is the bill's, and it stays. */
  const clearAppointment = () => {
    setValue('appointmentId', '', { shouldDirty: true });
    setLinkedNo(null);
  };

  const title = bill ? `Bill ${bill.bookNumber}/${bill.billNumber}` : 'New Bill';
  // The invoice actions exist only for a SAVED bill (it needs the issued number) and show the
  // saved version, so unsaved edits must be saved first.
  const unsavedHint = 'Save your changes first — the invoice shows the saved bill';
  const downloadPdf = async () => {
    if (!bill) return;
    setDownloading(true);
    try {
      await downloadInvoicePdf(bill.id, invoiceFileName(bill.bookNumber, bill.billNumber));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'The PDF could not be generated');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <FormProvider {...form}>
      <Crumb items={[{ label: 'Operations' }, { label: 'Billing', href: '/modules/billing' }, { label: bill ? `${bill.bookNumber}/${bill.billNumber}` : 'New' }]} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className="icon-btn" aria-label="Back to bills" title="Back to bills" onClick={() => nav('/modules/billing')}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-[20px] font-semibold text-gray-900">{title}</h2>
        {bill && <span className="text-[13px] text-gray-500">{bill.customerName}</span>}
        {bill && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-outline"
              disabled={isDirty}
              title={isDirty ? unsavedHint : 'Preview or print the invoice'}
              onClick={() => nav(`/modules/billing/${bill.id}/invoice`)}
            >
              <FileText className="h-4 w-4" strokeWidth={1.5} /> Preview
            </button>
            <button
              type="button"
              className="btn-outline"
              disabled={isDirty || downloading}
              title={isDirty ? unsavedHint : 'Download the invoice PDF'}
              onClick={downloadPdf}
            >
              {downloading ? <Spinner /> : <Download className="h-4 w-4" strokeWidth={1.5} />} PDF
            </button>
            <button type="button" className="btn-outline" disabled={isDirty} title={isDirty ? unsavedHint : 'Share the invoice on WhatsApp'} onClick={() => setSharing(true)}>
              <MessageCircle className="h-4 w-4" strokeWidth={1.5} /> WhatsApp
            </button>
          </div>
        )}
        {bill && <ShareInvoiceDialog billId={bill.id} open={sharing} onClose={() => setSharing(false)} />}
      </div>

      <form onSubmit={submit} className="space-y-3 pb-2">
        <BillHeaderFields
          bill={bill}
          canSeeAppointments={can('operations_appointments')}
          bookOptions={bookOptions}
          booksLoading={books.isLoading}
          taxMode={taxMode}
          linkedAppointmentNo={appointmentId ? linkedNo : null}
          onPickAppointment={pickAppointment}
          onClearAppointment={clearAppointment}
          disabled={!allowed || save.isPending}
        />

        {/* overflow-hidden, like the DataTable card: the grid is wider than a phone, and its
            own scroller must contain that width instead of letting the page slide sideways. */}
        <div className="card overflow-hidden p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="section-title">Items</h3>
            {items.isLoading && <span className="flex items-center gap-1.5 text-[12px] text-gray-500"><Spinner className="h-3 w-3" /> Loading items…</span>}
            {items.isError && <span className="text-[12px] text-red-600">Item Master could not be loaded.</span>}
          </div>
          <BillLinesGrid
            lines={lines}
            fieldIds={fields.map((f) => f.id)}
            amounts={preview.lines}
            items={items.data ?? []}
            itemOptions={itemOptions}
            taxMode={taxMode}
            onAdd={addLine}
            onNext={nextLine}
            onRemove={(i) => remove(i)}
            focusIndex={focusIndex}
            onFocused={() => setFocusIndex(null)}
            disabled={!allowed || save.isPending}
          />
          {lineCountError && <p className="mt-2 text-[12px] text-red-600">{lineCountError}</p>}
        </div>

        <div className="card flex flex-col gap-4 p-4 lg:flex-row lg:items-start lg:justify-between">
          {/* Beside the totals: the GST detail and — on a saved bill — its Studio Status, side by
              side where there is room (xl), stacked below that. Neither squeezes the totals. */}
          <div className={cx('grid min-w-0 flex-1 gap-4', taxMode === 'WITH_GST' && bill && 'min-[1400px]:grid-cols-[minmax(0,1fr)_auto]')}>
            {/* Only where tax is actually charged. A rate-wise table on a bill that charges
                nothing would read as a claim that those rates were billed. */}
            {taxMode === 'WITH_GST' && <GstDetails rows={preview.gstSummary} gstTotal={preview.totals.gstAmount} taxableTotal={preview.totals.netTaxable} />}
            {bill && <BillStudioStatus billId={bill.id} plannedDelivery={bill.deliveryDate} dirty={isDirty} className={cx(taxMode === 'WITH_GST' && 'min-[1400px]:border-l min-[1400px]:border-line min-[1400px]:pl-4')} />}
          </div>

          <dl className="w-full shrink-0 space-y-1.5 text-[13px] sm:w-[300px]">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-gray-500">Sub Total</dt>
              <dd className="tabular-nums text-gray-800">{fmtMoney(preview.totals.subTotal)}</dd>
            </div>
            {/* The control sits inside the totals, where its effect is: no separate card for
                something that is one number off the bottom of the bill. */}
            <div className="flex items-start justify-between gap-3">
              <dt className="pt-1.5 text-gray-500">Discount</dt>
              <dd className="flex flex-col items-end gap-1">
                <span className="tabular-nums text-gray-800">
                  {preview.totals.discountAmount > 0 ? `− ${fmtMoney(preview.totals.discountAmount)}` : fmtMoney(0)}
                </span>
                <div className="flex items-center gap-1.5">
                  <Controller
                    control={control}
                    name="discountType"
                    render={({ field }) => (
                      <Select
                        size="sm"
                        className="w-[74px]"
                        value={field.value}
                        onChange={pickDiscountType}
                        options={BILL_DISCOUNT_TYPES.map((t) => ({ value: t, label: BILL_DISCOUNT_TYPE_SHORT[t] }))}
                        disabled={!allowed || save.isPending}
                      />
                    )}
                  />
                  {discountType !== 'NONE' && (
                    <TextInput
                      size="sm"
                      className="w-[88px] text-right"
                      inputMode="decimal"
                      placeholder={discountType === 'PERCENT' ? '0.00 %' : '0.00'}
                      aria-label={discountType === 'PERCENT' ? 'Discount percentage' : 'Discount amount'}
                      disabled={!allowed || save.isPending}
                      {...register('discountValue')}
                    />
                  )}
                </div>
                {(discountWarning || errors.discountValue?.message) && (
                  <p className="max-w-[184px] text-right text-[11px] leading-tight text-red-600">{discountWarning ?? errors.discountValue?.message}</p>
                )}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-gray-500">Taxable Amount</dt>
              <dd className="tabular-nums text-gray-800">{fmtMoney(preview.totals.netTaxable)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-gray-500">GST</dt>
              <dd className="tabular-nums text-gray-800">{fmtMoney(preview.totals.gstAmount)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-t border-line pt-1.5">
              <dt className="text-[14px] font-medium text-gray-700">Grand Total</dt>
              <dd className="text-[18px] font-semibold tabular-nums text-gray-900">{fmtMoney(preview.totals.grandTotal)}</dd>
            </div>
            {/* New bill: money received with it. Saved bill: what has been paid and what is due — the
                server's derived figures (receipts + applied advance), never recomputed here. */}
            {canAdvance && (
              <BillAdvanceEntry
                draft={advance}
                onChange={changeAdvance}
                errors={advanceErrors}
                grandTotal={preview.totals.grandTotal}
                earlierAdvance={earlier.data?.availableAdvance ?? 0}
                disabled={save.isPending}
              />
            )}
            {bill && payments.data && (
              <>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-gray-500">Paid</dt>
                  <dd className="tabular-nums text-gray-800">{fmtMoney(payments.data.paidAmount)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-[14px] font-medium text-gray-700">Due</dt>
                  <dd className="text-[15px] font-semibold tabular-nums text-gray-900">{fmtMoney(payments.data.outstandingAmount)}</dd>
                </div>
                {isDirty && <p className="text-right text-[11.5px] text-gray-500">Paid and Due are the saved bill’s.</p>}
              </>
            )}
          </dl>
        </div>

        {/* A saved bill's money received so far. Its figures are the server's, from active receipts. */}
        {bill && <BillPaymentsPanel billId={bill.id} customerKey={bill.mobileSearch} customerName={bill.customerName} reference={`${bill.bookNumber}/${bill.billNumber}`} dirty={isDirty} />}

        <div className="sticky bottom-0 z-10 flex items-center justify-end gap-3 border-t border-line bg-page py-3">
          {!allowed && <span className="mr-auto text-[12px] text-gray-500">You don’t have permission to {bill ? 'edit' : 'create'} bills.</span>}
          <button type="button" className="btn-outline" onClick={() => nav('/modules/billing')} disabled={save.isPending}>Cancel</button>
          {allowed && (
            <button type="submit" className="btn-primary" disabled={save.isPending}>
              {save.isPending && <Spinner />} {bill ? 'Update Bill' : 'Save Bill'}
            </button>
          )}
        </div>
      </form>
    </FormProvider>
  );
}

/* ----------------------------------------------------------- GST details -- */

/**
 * The rate-wise GST summary — what tax was charged at each slab, grouped off the very line
 * amounts shown above. It is never a second calculation: `calculateBill` groups it, so the
 * summary and the grid cannot disagree.
 *
 * Collapsible, and open by default only while it is small. On a bill with one or two slabs
 * the operator wants to see it; on a long one it must not push the save bar off the screen.
 */
function GstDetails({ rows, taxableTotal, gstTotal }: { rows: GstSummaryRow[]; taxableTotal: number; gstTotal: number }) {
  const [open, setOpen] = useState(rows.length <= 3);
  if (rows.length === 0) return null;
  return (
    <div className="max-w-[360px] rounded border border-line">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[12px] font-medium text-gray-700"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>GST Details</span>
        <span className="flex items-center gap-1.5 text-[12px] font-normal text-gray-500">
          {rows.length} {rows.length === 1 ? 'rate' : 'rates'}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {open && (
        <table className="w-full border-t border-line text-[12px]">
          <thead>
            <tr className="bg-head">
              <th scope="col" className="table-head px-2.5 text-left">Rate</th>
              <th scope="col" className="table-head px-2.5 text-right">Taxable</th>
              <th scope="col" className="table-head px-2.5 text-right">GST</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.gstRate}>
                <td className="border-t border-line px-2.5 py-1 text-gray-600">{formatGst(r.gstRate)}</td>
                <td className="border-t border-line px-2.5 py-1 text-right tabular-nums text-gray-700">{fmtMoney(r.taxableAmount)}</td>
                <td className="border-t border-line px-2.5 py-1 text-right tabular-nums text-gray-700">{fmtMoney(r.gstAmount)}</td>
              </tr>
            ))}
            {/* The taxable figures here are AFTER the discount, so this row is the bill's own
                Taxable Amount and its GST — the two totals opposite must match to the paisa. */}
            <tr className="font-medium text-gray-900">
              <td className="border-t border-line px-2.5 py-1">Total</td>
              <td className="border-t border-line px-2.5 py-1 text-right tabular-nums">{fmtMoney(taxableTotal)}</td>
              <td className="border-t border-line px-2.5 py-1 text-right tabular-nums">{fmtMoney(gstTotal)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
