import { useState } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { BILL_LIMITS, INVOICE_TAX_MODES, INVOICE_TAX_MODE_LABELS, type InvoiceTaxMode } from '@erp/shared';
import { Checkbox, Combobox, Field, TextInput, type Option } from '@/components/ui';
import { cx } from '@/lib/format';
import { AppointmentSuggestions } from './AppointmentSuggestions';
import type { BillFormValues, BillRecord } from './types';
import type { AppointmentLookup } from '@/lib/queries';

interface Props {
  /** Present when editing — the book and the bill number become read-only facts. */
  bill?: BillRecord;
  bookOptions: Option[];
  booksLoading: boolean;
  linkedAppointmentNo: number | null;
  /**
   * The bookings lookup is guarded by `operations_appointments` — it carries a customer's
   * name and number. Without that grant the strip is hidden rather than shown failing: a
   * walk-in bill is typed by hand anyway, which is exactly what those operators do.
   */
  canSeeAppointments: boolean;
  onPickAppointment: (a: AppointmentLookup) => void;
  onClearAppointment: () => void;
  disabled?: boolean;
}

const trimmed = (v: unknown) => (typeof v === 'string' ? v.trim() : v);

/**
 * The bill's header, in one compact band.
 *
 * The first row is everything a bill cannot be saved without; the rest lives behind "More
 * details", because a studio bill usually has no delivery date, no baby name, no birthdate
 * and no remark — and a form that shows nine empty fields to collect four is slower to work.
 * The disclosure opens by itself whenever the bill being edited actually uses one of them.
 */
export function BillHeaderFields({ bill, bookOptions, booksLoading, linkedAppointmentNo, canSeeAppointments, onPickAppointment, onClearAppointment, disabled }: Props) {
  const { register, control, watch, setValue, formState: { errors } } = useFormContext<BillFormValues>();
  const hasSecondary = !!(bill && (bill.deliveryDate || bill.babyName || bill.hasBirthDate || bill.remark));
  const [more, setMore] = useState(hasSecondary);
  const hasBirthDate = watch('hasBirthDate');
  const mobileNumber = watch('mobileNumber');

  return (
    <div className="card p-4">
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Field label="Book" required={!bill} error={errors.bookId?.message} hint={bill ? undefined : 'Decides the bill number series.'}>
          {bill ? (
            <ReadOnlyValue title="The book a bill is numbered under cannot change after it is saved">{bill.bookNumber}</ReadOnlyValue>
          ) : (
            <Controller
              control={control}
              name="bookId"
              rules={{ required: 'Book is required' }}
              render={({ field }) => <Combobox size="sm" value={field.value} onChange={field.onChange} options={bookOptions} placeholder={booksLoading ? 'Loading…' : 'Select book'} disabled={disabled || booksLoading} />}
            />
          )}
        </Field>

        {/* Never a preview number: the series is only moved by a successful save, on the server. */}
        <Field label="Bill No." hint={bill ? undefined : 'Issued by the book on save.'}>
          <ReadOnlyValue>{bill ? bill.billNumber : <span className="text-gray-400">Auto on Save</span>}</ReadOnlyValue>
        </Field>

        <Field label="Bill Date" required error={errors.billDate?.message}>
          <TextInput size="sm" type="date" autoFocus={!bill} disabled={disabled} {...register('billDate', { required: 'Bill date is required' })} />
        </Field>

        <Field label="Tax Mode" error={errors.taxMode?.message}>
          <Controller control={control} name="taxMode" render={({ field }) => <TaxModeToggle value={field.value} onChange={field.onChange} disabled={disabled} />} />
        </Field>

        <Field label="Mobile No." required error={errors.mobileNumber?.message}>
          <TextInput size="sm" inputMode="tel" placeholder="Enter mobile no." maxLength={BILL_LIMITS.mobileNumber} disabled={disabled} {...register('mobileNumber', { required: 'Mobile no. is required', setValueAs: trimmed })} />
        </Field>

        <Field label="Customer Name" required error={errors.customerName?.message}>
          <TextInput size="sm" placeholder="Enter customer name" maxLength={BILL_LIMITS.customerName} disabled={disabled} {...register('customerName', { required: 'Customer name is required', setValueAs: trimmed })} />
        </Field>
      </div>

      {/* The booking strip sits directly under the mobile it follows, full width so a long
          candidate never squeezes the fields above it. */}
      {(canSeeAppointments || linkedAppointmentNo !== null) && (
        <div className="mt-2 min-h-[20px]">
          <AppointmentSuggestions mobile={canSeeAppointments ? mobileNumber : ''} linked={linkedAppointmentNo} onPick={onPickAppointment} onClear={onClearAppointment} />
        </div>
      )}

      <button
        type="button"
        onClick={() => setMore((m) => !m)}
        aria-expanded={more}
        className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-gray-600 transition hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/40 rounded"
      >
        {more ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        More details
        <span className="font-normal text-gray-400">(delivery date, baby name, birthdate, remark)</span>
      </button>

      {more && (
        <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-3 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Field label="Delivery Date" error={errors.deliveryDate?.message}>
            <TextInput size="sm" type="date" disabled={disabled} {...register('deliveryDate')} />
          </Field>
          <Field label="Baby Name" error={errors.babyName?.message}>
            <TextInput size="sm" placeholder="Enter baby name" maxLength={BILL_LIMITS.babyName} disabled={disabled} {...register('babyName', { setValueAs: trimmed })} />
          </Field>
          <Field label="Birthdate">
            <div className="flex h-8 items-center">
              <Controller
                control={control}
                name="hasBirthDate"
                render={({ field }) => (
                  <Checkbox
                    checked={field.value}
                    disabled={disabled}
                    label="Bill carries a birthdate"
                    onChange={(v) => {
                      field.onChange(v);
                      // Unticking drops the date: the column stores NULL, and a stale date
                      // left behind by an earlier edit would be a lie the server rejects.
                      if (!v) setValue('birthDate', '');
                    }}
                  />
                )}
              />
            </div>
          </Field>
          {hasBirthDate && (
            <Field label="Birth Date" required error={errors.birthDate?.message}>
              <TextInput size="sm" type="date" disabled={disabled} {...register('birthDate', { required: 'Birth date is required' })} />
            </Field>
          )}
          <Field label="Remark" error={errors.remark?.message} className={hasBirthDate ? 'sm:col-span-2' : 'sm:col-span-2 xl:col-span-3'}>
            <TextInput size="sm" placeholder="Optional note for this bill" maxLength={BILL_LIMITS.remark} disabled={disabled} {...register('remark', { setValueAs: trimmed })} />
          </Field>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- controls -- */

/** A value the operator may read but not change — same box as an input, visibly inert. */
const ReadOnlyValue = ({ children, title }: { children: React.ReactNode; title?: string }) => (
  <div title={title} className="input input-sm flex items-center bg-gray-50 font-medium text-gray-700">
    {children}
  </div>
);

/**
 * Two exclusive options, so the whole choice is visible at a glance — a bill is either taxed
 * or it is not, and which one it is decides what the customer pays.
 */
function TaxModeToggle({ value, onChange, disabled }: { value: InvoiceTaxMode; onChange: (v: InvoiceTaxMode) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Tax mode" className="flex h-8 overflow-hidden rounded-lg border border-input">
      {INVOICE_TAX_MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          disabled={disabled}
          onClick={() => onChange(m)}
          className={cx(
            // nowrap: "Without GST" must never wrap inside a 32px-high segment and lose half
            // its word — the mode decides what the customer is charged.
            'flex-1 whitespace-nowrap px-2 text-[12.5px] font-medium transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary/40 disabled:opacity-50',
            value === m ? 'bg-primary text-white' : 'bg-surface text-gray-600 hover:bg-gray-50',
          )}
        >
          {INVOICE_TAX_MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );
}
