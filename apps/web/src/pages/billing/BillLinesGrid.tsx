import { useEffect, useRef } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { formatGst, type BillLineAmounts, type InvoiceTaxMode } from '@erp/shared';
import { Combobox, TextInput, type Option } from '@/components/ui';
import { useSubItemsLookup, type ItemLookup } from '@/lib/queries';
import { fmtNum } from '@/lib/format';
import type { BillFormValues, BillLineFormValues } from './types';

interface GridProps {
  /** The watched lines — the grid renders values, the form owns them. */
  lines: BillLineFormValues[];
  /** Stable react keys from `useFieldArray`, in the same order as `lines`. */
  fieldIds: string[];
  /** Per-line money from `calculateBill` in `@erp/shared`. Never computed in this file. */
  amounts: BillLineAmounts[];
  items: ItemLookup[];
  itemOptions: Option[];
  taxMode: InvoiceTaxMode;
  onAdd: () => void;
  /** Enter at the end of a line: the next one, appended only when there is no next one. */
  onNext: (index: number) => void;
  onRemove: (index: number) => void;
  /** Index whose Item cell should take focus, set after Enter or Add line. */
  focusIndex: number | null;
  onFocused: () => void;
  disabled?: boolean;
}

/**
 * The bill's lines, as a grid — one row per line, the way the studio's paper book reads.
 * Deliberately not a vertical sub-form per line: an operator entering six products must see
 * six rows, not six stacked forms.
 *
 * Everything computed here is READ from `amounts` (the shared calculation). The grid renders
 * money; it never works it out.
 */
export function BillLinesGrid({ lines, fieldIds, amounts, items, itemOptions, taxMode, onAdd, onNext, onRemove, focusIndex, onFocused, disabled }: GridProps) {
  return (
    <div className="overflow-x-auto">
      {/* Ten data columns have to stay readable side by side: the two pickers take a share of
          the width, every money column is fixed so the figures line up, and Remark takes what
          is left. The min-width is what the row genuinely needs before its own scroller. */}
      <table className="w-full min-w-[1100px] border-separate border-spacing-0">
        <colgroup>
          <col className="w-10" />
          <col className="w-[17%]" />
          <col className="w-[17%]" />
          <col className="w-[72px]" />
          <col className="w-[96px]" />
          <col className="w-[104px]" />
          <col className="w-[64px]" />
          <col className="w-[96px]" />
          <col className="w-[108px]" />
          <col />
          <col className="w-10" />
        </colgroup>
        <thead>
          <tr className="bg-head">
            <th scope="col" className="table-head px-2 text-center">#</th>
            <th scope="col" className="table-head px-2">Item</th>
            <th scope="col" className="table-head px-2">Product</th>
            <th scope="col" className="table-head px-2 text-right">Qty</th>
            <th scope="col" className="table-head px-2 text-right">Rate</th>
            {/* The NET taxable value: Qty x Rate less this line's share of the bill discount. */}
            <th scope="col" className="table-head px-2 text-right">Taxable</th>
            <th scope="col" className="table-head px-2 text-right">GST %</th>
            <th scope="col" className="table-head px-2 text-right">GST Amt</th>
            <th scope="col" className="table-head px-2 text-right">Total</th>
            <th scope="col" className="table-head px-2">Remark</th>
            {/* `relative`, because `.sr-only` is absolutely positioned: without a positioned
                ancestor its containing block is the page itself, so it escapes this grid's
                horizontal scroller and drags the whole document sideways on a phone. */}
            <th scope="col" className="table-head relative px-2"><span className="sr-only">Remove</span></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <BillLineRow
              key={fieldIds[i]}
              index={i}
              line={line}
              amount={amounts[i]}
              items={items}
              itemOptions={itemOptions}
              taxMode={taxMode}
              onEnter={() => onNext(i)}
              onRemove={() => onRemove(i)}
              focus={focusIndex === i}
              onFocused={onFocused}
              disabled={disabled}
            />
          ))}
          {lines.length === 0 && (
            <tr>
              <td colSpan={11} className="border-b border-line px-3 py-6 text-center text-[13px] text-gray-500">
                This bill has no lines yet. Add at least one before saving.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="mt-2 flex items-center gap-3">
        <button type="button" className="btn-outline" onClick={onAdd} disabled={disabled}>
          <Plus className="h-4 w-4" /> Add line
        </button>
        <span className="text-[12px] text-gray-500">Item → Product → Qty → Rate, then Enter to start the next line.</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- row -- */

interface RowProps {
  index: number;
  line: BillLineFormValues;
  amount?: BillLineAmounts;
  items: ItemLookup[];
  itemOptions: Option[];
  taxMode: InvoiceTaxMode;
  onEnter: () => void;
  onRemove: () => void;
  focus: boolean;
  onFocused: () => void;
  disabled?: boolean;
}

const cell = 'border-b border-line px-2 py-1 align-top';

function BillLineRow({ index, line, amount, items, itemOptions, taxMode, onEnter, onRemove, focus, onFocused, disabled }: RowProps) {
  const { control, register, setValue, formState: { errors } } = useFormContext<BillFormValues>();
  // One request per item, shared by every line that uses it — react-query caches by item id.
  const subItems = useSubItemsLookup(line.itemId || undefined);
  /**
   * The remark this row last filled in from the chosen product. It is what tells an
   * untouched default apart from something the operator wrote, so switching product replaces
   * the former and never overwrites the latter.
   */
  const autoRemark = useRef<string>('');
  const itemCell = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLTableRowElement>(null);

  // Fast entry: after Enter (or Add line) the caret belongs in the new line's first cell.
  useEffect(() => {
    if (!focus) return;
    itemCell.current?.querySelector('button')?.focus();
    onFocused();
  }, [focus, onFocused]);

  const lineErrors = errors.items?.[index];

  /** A new item invalidates the product, its rate and its GST — none of them belong to it. */
  const pickItem = (itemId: string) => {
    setValue(`items.${index}.itemId`, itemId, { shouldDirty: true });
    setValue(`items.${index}.itemName`, items.find((x) => x.id === itemId)?.itemName ?? '');
    setValue(`items.${index}.gstRate`, items.find((x) => x.id === itemId)?.gstRate ?? null);
    setValue(`items.${index}.subItemId`, '');
    setValue(`items.${index}.productName`, '');
    setValue(`items.${index}.rate`, '');
    if (line.remark === autoRemark.current) setValue(`items.${index}.remark`, '');
    autoRemark.current = '';
  };

  /** The product supplies the DEFAULT rate and remark; both stay the operator's to override. */
  const pickProduct = (subItemId: string) => {
    setValue(`items.${index}.subItemId`, subItemId, { shouldDirty: true });
    const sub = subItems.data?.find((s) => s.id === subItemId);
    if (!sub) return;
    setValue(`items.${index}.productName`, sub.productName);
    setValue(`items.${index}.rate`, String(sub.rate));
    const suggested = sub.remark ?? '';
    // Only a blank or previously auto-filled remark is replaced — never typed words.
    if (line.remark === '' || line.remark === autoRemark.current) {
      setValue(`items.${index}.remark`, suggested);
      autoRemark.current = suggested;
    }
  };

  /**
   * Enter inside the grid belongs to the grid, never to the form's submit button: in the
   * middle of a line it walks on to the rate, at the end of one it opens the next line.
   * Saving is Ctrl/Cmd+S or the Save button — an operator must not bill a customer by
   * pressing Enter one field too early.
   */
  const stepToRate = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    row.current?.querySelector<HTMLInputElement>('input[data-cell="rate"]')?.focus();
  };
  const nextLineOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    onEnter();
  };

  /**
   * The picker offers active masters. A line saved earlier may point at one that has since
   * been deactivated, and a Combobox with no matching option shows the bare id — so the
   * line's own saved name is added back as an option, marked for what it is.
   */
  const withSaved = (options: Option[], id: string, name?: string): Option[] =>
    id && !options.some((o) => o.value === id) ? [...options, { value: id, label: name || 'Not in the list any more', sub: '(inactive)' }] : options;

  const productOptions: Option[] = withSaved((subItems.data ?? []).map((s) => ({ value: s.id, label: s.productName })), line.subItemId, line.productName);
  const productPlaceholder = !line.itemId ? 'Select item first' : subItems.isLoading ? 'Loading…' : productOptions.length === 0 ? 'No products' : 'Select product';

  return (
    <tr ref={row} className="hover:bg-gray-50/60">
      <td className={`${cell} pt-3 text-center text-[12px] text-gray-500`}>{index + 1}</td>
      <td className={cell}>
        <div ref={itemCell}>
          <Controller
            control={control}
            name={`items.${index}.itemId`}
            render={({ field }) => <Combobox size="sm" value={field.value} onChange={(v: string) => pickItem(v)} options={withSaved(itemOptions, line.itemId, line.itemName)} placeholder="Select item" disabled={disabled} />}
          />
        </div>
        <CellError message={lineErrors?.itemId?.message} />
      </td>
      <td className={cell}>
        <Controller
          control={control}
          name={`items.${index}.subItemId`}
          render={({ field }) => (
            <Combobox size="sm" value={field.value} onChange={(v: string) => pickProduct(v)} options={productOptions} placeholder={productPlaceholder} disabled={disabled || !line.itemId || subItems.isLoading} />
          )}
        />
        <CellError message={lineErrors?.subItemId?.message} />
      </td>
      <td className={cell}>
        <TextInput size="sm" className="text-right" inputMode="decimal" aria-label={`Quantity, line ${index + 1}`} placeholder="0" disabled={disabled} onKeyDown={stepToRate} {...register(`items.${index}.quantity`)} />
        <CellError message={lineErrors?.quantity?.message} />
      </td>
      <td className={cell}>
        <TextInput size="sm" data-cell="rate" className="text-right" inputMode="decimal" aria-label={`Rate, line ${index + 1}`} placeholder="0.00" disabled={disabled} onKeyDown={nextLineOnEnter} {...register(`items.${index}.rate`)} />
        <CellError message={lineErrors?.rate?.message} />
      </td>
      {/*
        The taxable base, after the bill's discount has been spread across the lines. The
        allocated share itself is not a column: the discount is a BILL-level concession and a
        per-line figure in the entry grid would read like one the operator could type. It is in
        the title, and in the saved bill's data, for when the arithmetic has to be explained.
      */}
      <td
        className={`${cell} pt-2.5 text-right text-[13px] tabular-nums text-gray-700`}
        title={amount && amount.discountAllocated > 0 ? `Qty × Rate ${fmtNum(amount.grossTaxable)} − discount ${fmtNum(amount.discountAllocated)}` : undefined}
      >
        {fmtNum(amount?.taxableAmount ?? 0)}
      </td>
      {/* Read-only: the GST rate is Item Master's, and a bill line may not argue with it. */}
      <td className={`${cell} pt-2.5 text-right text-[13px] ${taxMode === 'WITH_GST' ? 'text-gray-600' : 'text-gray-400'}`} title="From Item Master — not editable on a bill">
        {line.gstRate === null ? '-' : formatGst(line.gstRate)}
      </td>
      <td className={`${cell} pt-2.5 text-right text-[13px] tabular-nums text-gray-600`}>{fmtNum(amount?.gstAmount ?? 0)}</td>
      <td className={`${cell} pt-2.5 text-right text-[13px] font-medium tabular-nums text-gray-900`}>{fmtNum(amount?.lineTotal ?? 0)}</td>
      <td className={cell}>
        <TextInput size="sm" placeholder="Optional note" aria-label={`Remark, line ${index + 1}`} disabled={disabled} onKeyDown={nextLineOnEnter} {...register(`items.${index}.remark`)} />
        <CellError message={lineErrors?.remark?.message} />
      </td>
      <td className={`${cell} pt-1.5 text-center`}>
        <button type="button" className="row-action-danger" onClick={onRemove} disabled={disabled} aria-label={`Remove line ${index + 1}`} title="Remove line">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}

/** A line's problem belongs next to that line, not only in a toast at the top of the screen. */
const CellError = ({ message }: { message?: string }) => (message ? <p className="mt-0.5 text-[11px] leading-tight text-red-600">{message}</p> : null);
