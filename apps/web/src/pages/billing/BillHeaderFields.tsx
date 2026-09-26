import { Controller, useFormContext } from 'react-hook-form';
import { CalendarPlus } from 'lucide-react';
import { BILL_LIMITS, BILL_MOBILE_DIGITS, INVOICE_TAX_MODE_LABELS, normalizeMobile, sanitizeMobileInput, type InvoiceTaxMode } from '@erp/shared';
import { Checkbox, Combobox, DateInput, Field, TextInput, validDate, type Option } from '@/components/ui';
import { AppointmentSuggestions } from './AppointmentSuggestions';
import type { BillFormValues, BillRecord } from './types';
import type { AppointmentLookup } from '@/lib/queries';

interface Props {
  /** Present when editing — the book and the bill number become read-only facts. */
  bill?: BillRecord;
  bookOptions: Option[];
  booksLoading: boolean;
  /** The bill's tax mode — the selected book's series type (new) or the saved one (edit). Never chosen here. */
  taxMode: InvoiceTaxMode;
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
const MOBILE_RULE = /^\d{10}$/;

/**
 * The bill's header, in one compact card: the fields a bill cannot be saved without on the first
 * row, the optional ones (baby name, delivery date, next visit, birthdate, remark) directly below —
 * no disclosure to open. Six columns on a desktop, stacking cleanly on a phone.
 */
export function BillHeaderFields({ bill, bookOptions, booksLoading, taxMode, linkedAppointmentNo, canSeeAppointments, onPickAppointment, onClearAppointment, disabled }: Props) {
  const { register, control, watch, setValue, formState: { errors } } = useFormContext<BillFormValues>();
  const hasBirthDate = watch('hasBirthDate');
  const mobileNumber = watch('mobileNumber');
  /**
   * A bill saved before the ten-digit rule is shown as its customer key; that untouched key may be
   * saved back as it is (the server allows exactly that). Any change must be ten digits.
   */
  const legacyKey = bill && !MOBILE_RULE.test(bill.mobileNumber) ? normalizeMobile(bill.mobileNumber) : null;

  return (
    <div className="card p-4">
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Field label="Book" required={!bill} error={errors.bookId?.message}>
          {bill ? (
            <ReadOnlyValue title="The book a bill is numbered under cannot change after it is saved">{bill.bookNumber}</ReadOnlyValue>
          ) : (
            <Controller
              control={control}
              name="bookId"
              rules={{ required: 'Book is required' }}
              render={({ field }) => <Combobox size="sm" value={field.value} onChange={field.onChange} options={bookOptions} placeholder={booksLoading ? 'Loading…' : 'Select book'} disabled={disabled || booksLoading} clearable={false} />}
            />
          )}
        </Field>

        {/* Never a preview number: the series is only moved by a successful save, on the server. */}
        <Field label="Bill No.">
          <ReadOnlyValue>{bill ? bill.billNumber : <span className="font-normal text-gray-400">Auto-generated</span>}</ReadOnlyValue>
        </Field>

        <Field label="Bill Date" required error={errors.billDate?.message}>
          <Controller control={control} name="billDate" rules={{ required: 'Bill date is required', validate: validDate }} render={({ field }) => <DateInput {...field} size="sm" autoFocus={!bill} disabled={disabled} />} />
        </Field>

        {/* Decided by the book (a With GST or Without GST series) — shown, never chosen. */}
        <Field label="Tax Mode" error={errors.taxMode?.message}>
          <ReadOnlyValue title={bill ? 'A saved bill keeps the tax mode it was issued with' : 'Set by the selected book'}>
            {bill || !booksLoading ? INVOICE_TAX_MODE_LABELS[taxMode] : <span className="font-normal text-gray-400">—</span>}
          </ReadOnlyValue>
        </Field>

        <Field label="Mobile No." required error={errors.mobileNumber?.message}>
          <Controller
            control={control}
            name="mobileNumber"
            rules={{ required: 'Mobile no. is required', validate: (v) => MOBILE_RULE.test(v ?? '') || (legacyKey !== null && v === legacyKey) || `Mobile no. must be exactly ${BILL_MOBILE_DIGITS} digits` }}
            render={({ field }) => (
              <TextInput
                ref={field.ref}
                name={field.name}
                value={field.value}
                onBlur={field.onBlur}
                size="sm"
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                maxLength={BILL_MOBILE_DIGITS}
                placeholder="10-digit mobile"
                aria-label="Mobile number, 10 digits"
                disabled={disabled}
                // Digits only, at most ten — a letter or an eleventh digit never stays in the box.
                onChange={(e) => field.onChange(sanitizeMobileInput(e.target.value))}
                // A paste is sanitized WHOLE before maxLength can cut it: "+91 98765 43210" keeps
                // 9876543210, not "+91 98765 ".
                onPaste={(e) => {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const current = el.value;
                  const next = current.slice(0, el.selectionStart ?? current.length) + e.clipboardData.getData('text') + current.slice(el.selectionEnd ?? current.length);
                  field.onChange(sanitizeMobileInput(next));
                }}
              />
            )}
          />
        </Field>

        <Field label="Customer Name" required error={errors.customerName?.message}>
          <TextInput size="sm" placeholder="Enter customer name" maxLength={BILL_LIMITS.customerName} disabled={disabled} {...register('customerName', { required: 'Customer name is required', setValueAs: trimmed })} />
        </Field>
      </div>

      {/* The booking strip sits directly under the mobile it follows, full width so a long
          candidate never squeezes the fields above it. */}
      {(canSeeAppointments || linkedAppointmentNo !== null) && (
        <div className="mt-2 min-h-[20px]">
          <AppointmentSuggestions mobile={canSeeAppointments ? mobileNumber : ''} linked={linkedAppointmentNo} onPick={onPickAppointment} onClear={onClearAppointment} excludeId={bill?.nextAppointmentId} />
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Field label="Baby Name" error={errors.babyName?.message}>
          <TextInput size="sm" placeholder="Enter baby name" maxLength={BILL_LIMITS.babyName} disabled={disabled} {...register('babyName', { setValueAs: trimmed })} />
        </Field>
        <Field label="Delivery Date" error={errors.deliveryDate?.message}>
          <Controller control={control} name="deliveryDate" rules={{ validate: validDate }} render={({ field }) => <DateInput {...field} size="sm" disabled={disabled} />} />
        </Field>
        <Field
          label="Next Visit Date"
          error={errors.nextVisitDate?.message}
          hint={
            bill?.nextAppointmentNumber ? (
              <span className="inline-flex items-center gap-1 text-primary-dark">
                <CalendarPlus className="h-3.5 w-3.5" strokeWidth={1.5} /> Next Appointment #{bill.nextAppointmentNumber}
              </span>
            ) : (
              'Creates next appointment after saving'
            )
          }
        >
          <Controller control={control} name="nextVisitDate" rules={{ validate: validDate }} render={({ field }) => <DateInput {...field} size="sm" disabled={disabled} aria-label="Next visit date" />} />
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
            <Controller control={control} name="birthDate" rules={{ required: 'Birth date is required', validate: validDate }} render={({ field }) => <DateInput {...field} size="sm" disabled={disabled} />} />
          </Field>
        )}
        <Field label="Remark" error={errors.remark?.message} className={hasBirthDate ? 'sm:col-span-2 lg:col-span-1' : 'sm:col-span-2 lg:col-span-1 xl:col-span-2'}>
          <TextInput size="sm" placeholder="Optional note for this bill" maxLength={BILL_LIMITS.remark} disabled={disabled} {...register('remark', { setValueAs: trimmed })} />
        </Field>
      </div>
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
