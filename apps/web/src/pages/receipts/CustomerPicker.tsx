import { useEffect, useId, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { BILL_MOBILE_DIGITS, sanitizeMobileInput, type ReceivableCustomer } from '@erp/shared';
import { Spinner } from '@/components/ui';
import { cx, fmtMoney } from '@/lib/format';
import { useReceivableCustomer, useReceivableCustomers } from '@/lib/receipts';

/** Long enough that typing a name costs one request, short enough to feel immediate. */
const DEBOUNCE_MS = 300;

interface Props {
  value: ReceivableCustomer | null;
  onChange: (c: ReceivableCustomer | null) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  error?: string;
  /** Offer a 10-digit mobile nobody owes anything on — the customer paying an advance. */
  allowNew?: boolean;
}

/**
 * The receipt's customer, searched on the SERVER by name or mobile — customers who owe
 * something are offered; a full 10-digit mobile also finds a customer who owes nothing, or offers a
 * new one (an advance before any bill). (The shared Combobox filters a list it already holds, which
 * cannot express a search across every customer, hence this small listbox.)
 *
 * Keyboard: type to search, Up/Down to move, Enter to pick, Escape closes the list only.
 */
export function CustomerPicker({ value, onChange, disabled, autoFocus, error, allowNew = true }: Props) {
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => setActive(0), [search]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const q = useReceivableCustomers(search, open && !value);
  // A full 10-digit mobile may be someone who owes nothing (fully paid, or an advance only) or a
  // brand-new customer paying an advance before any bill: look that exact key up, and offer
  // "new customer" when it is nobody yet. Money is never received for a fake bill.
  const typedKey = sanitizeMobileInput(search);
  const isFullMobile = typedKey.length === BILL_MOBILE_DIGITS;
  const exact = useReceivableCustomer(allowNew && isFullMobile && open && !value ? typedKey : null);
  const found = q.data ?? [];
  const exactRow = exact.data?.[0];
  const rows: ReceivableCustomer[] = [
    ...found,
    ...(exactRow && !found.some((c) => c.customerKey === exactRow.customerKey) ? [exactRow] : []),
    ...(allowNew && isFullMobile && exact.data && !exactRow && !found.some((c) => c.customerKey === typedKey)
      ? [{ customerKey: typedKey, customerName: '', mobileNumber: typedKey, billCount: 0, pendingBillCount: 0, totalBilled: 0, totalPaid: 0, totalOutstanding: 0 }]
      : []),
  ];

  const pick = (c: ReceivableCustomer) => {
    onChange(c);
    setOpen(false);
    setText('');
  };

  if (value) {
    return (
      <div className={cx('input flex items-center gap-2 pr-1.5', disabled && 'bg-gray-50')}>
        <span className="min-w-0 flex-1 truncate">
          <span className="text-gray-900">{value.customerName}</span>
          <span className="ml-2 text-[13px] text-gray-500">{value.mobileNumber}</span>
        </span>
        {!disabled && (
          <button
            type="button"
            className="row-action"
            aria-label="Change customer"
            title="Change customer"
            onClick={() => {
              onChange(null);
              setOpen(true);
              setTimeout(() => input.current?.focus(), 0);
            }}
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={box} className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" strokeWidth={1.5} />
      <input
        ref={input}
        className={cx('input pl-9', error && 'border-red-500')}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label="Customer"
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder="Search customer by name or mobile"
        value={text}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, rows.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); if (open && rows[active]) pick(rows[active]); }
          else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
        }}
      />
      {open && (
        <ul id={listId} role="listbox" className="card absolute left-0 right-0 z-50 mt-1 max-h-72 overflow-y-auto py-1 shadow-lg">
          {q.isLoading && <li className="flex items-center gap-2 px-3 py-2 text-[13px] text-gray-500"><Spinner className="h-3 w-3" /> Searching…</li>}
          {q.isError && <li className="px-3 py-2 text-[13px] text-red-600">Customers could not be loaded.</li>}
          {!q.isLoading && !q.isError && rows.length === 0 && (
            <li className="px-3 py-2 text-[13px] text-gray-500">
              {search ? 'No customer with an outstanding balance matches.' : 'No customer has anything outstanding.'}
              {allowNew && !isFullMobile && ' Type a 10-digit mobile to receive an advance.'}
            </li>
          )}
          {rows.map((c, i) => (
            <li
              key={c.customerKey}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(c)}
              className={cx('flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-[13px]', i === active ? 'bg-primary-lighter/60' : 'hover:bg-gray-50')}
            >
              <span className="min-w-0 truncate">
                <span className="text-gray-900">{c.customerName || 'New customer'}</span>
                <span className="ml-2 text-gray-500">{c.mobileNumber}</span>
              </span>
              <span className="shrink-0 text-right tabular-nums text-gray-700">
                {c.billCount === 0 ? (
                  <span className="text-[12px] text-gray-500">No bill yet — advance</span>
                ) : (
                  <>
                    {fmtMoney(c.totalOutstanding)}
                    <span className="ml-1.5 text-[12px] text-gray-500">{c.pendingBillCount} {c.pendingBillCount === 1 ? 'bill' : 'bills'}</span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
