import { Fragment, forwardRef, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2, MoreVertical, Search, X } from 'lucide-react';
import { cx } from '@/lib/format';

/* ---------------- Dialog focus contract ---------------- */
/**
 * What a modal dialog owes the keyboard: it opens on its first field, keeps Tab inside while
 * it is open, closes on Escape and hands focus back to whatever had it before. Shared by
 * <Modal> and <Drawer> so the two behave identically whichever one a form is presented in.
 */
function useDialogFocus(open: boolean, panel: RefObject<HTMLDivElement>, body: RefObject<HTMLDivElement>, onClose: () => void) {
  const restoreTo = useRef<HTMLElement | null>(null);
  // kept in a ref so the effect below runs once per open, not on every parent re-render
  const close = useRef(onClose);
  close.current = onClose;

  /**
   * Remember what had focus outside the panel. Reading document.activeElement when the dialog
   * opens is too late: React applies a field's autoFocus during commit, before any effect
   * runs, so by then focus is already inside.
   */
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      // `closest`, not the panel ref: refs attach after React has already applied autoFocus,
      // so the ref is still null for the very first focus event inside a freshly opened dialog.
      if (el !== document.body && !el.closest?.('[role="dialog"]')) restoreTo.current = el;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  useEffect(() => {
    if (!open) return;
    const within = (root: HTMLElement | null) => Array.from(root?.querySelectorAll<HTMLElement>('input:not([type=hidden]), select, textarea, button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])') ?? []).filter((el) => el.offsetParent !== null);
    const focusables = () => within(panel.current);
    // Open on the first field, not on the header's close button.
    (within(body.current)[0] ?? focusables()[0] ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close.current(); return; }
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (!els.length) return;
      const [first, last] = [els[0], els[els.length - 1]];
      const active = document.activeElement as HTMLElement;
      if (!panel.current?.contains(active)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // after the list behind it has re-rendered, so focus is not stolen back by the refresh
      const target = restoreTo.current;
      setTimeout(() => { if (target && document.contains(target)) target.focus(); }, 0);
    };
  }, [open]);
}

/* ---------------- Modal ---------------- */
export function Modal({ open, onClose, title, children, footer, size = 'md', className, maxHeight = 'max-h-[calc(100vh-4rem)]' }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'; className?: string; /** the panel's height cap — one class, so a caller can raise or lower it without fighting the default */ maxHeight?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useDialogFocus(open, panel, body, onClose);
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [open]);
  if (!open) return null;
  const w = { sm: 'max-w-[420px]', md: 'max-w-[560px]', lg: 'max-w-[760px]', xl: 'max-w-[1000px]', full: 'max-w-[1200px]' }[size];
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1} className={cx('card w-full my-auto flex flex-col outline-none', maxHeight, w, className)}>
        {title !== undefined && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-line">
            <h3 className="text-[18px] font-semibold text-gray-900">{title}</h3>
            <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-900" aria-label="Close"><X className="h-5 w-5" /></button>
          </div>
        )}
        <div ref={body} className="px-6 py-5 overflow-y-auto flex-1">{children}</div>
        {footer && <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-line">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------- Drawer (right side panel) ---------------- */
export function Drawer({ open, onClose, title, children, footer, width = 'w-[480px]' }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useDialogFocus(open, panel, body, onClose);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1} className={cx('absolute right-0 top-0 h-full bg-white shadow-xl flex flex-col max-w-full outline-none', width)}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <h3 className="text-[18px] font-semibold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-500 transition hover:text-gray-900"><X className="h-5 w-5" /></button>
        </div>
        <div ref={body} className="px-6 py-5 overflow-y-auto flex-1">{children}</div>
        {footer && <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-line">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------- Confirm ---------------- */
export function ConfirmDialog({ open, onClose, onConfirm, title = 'Are you sure?', message, confirmText = 'Delete', loading }: { open: boolean; onClose: () => void; onConfirm: () => void; title?: string; message?: ReactNode; confirmText?: string; loading?: boolean }) {
  return (
    <Modal open={open} onClose={onClose} size="sm" title={title} footer={<><button className="btn-outline" onClick={onClose}>Cancel</button><button className="btn-danger" onClick={onConfirm} disabled={loading}>{loading && <Spinner />}{confirmText}</button></>}>
      <p className="text-[14px] text-gray-600">{message ?? 'This action cannot be undone.'}</p>
    </Modal>
  );
}

/* ---------------- Field wrapper ---------------- */
export function Field({ label, required, error, hint, children, className }: { label?: ReactNode; required?: boolean; error?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      {label && <label className={cx('label', required && 'label-req')}>{label}</label>}
      {children}
      {error ? <p className="mt-1 text-[12px] text-red-600">{error}</p> : hint ? <p className="mt-1 text-[12px] text-gray-500">{hint}</p> : null}
    </div>
  );
}

/* ---------------- Section (form group with title) ---------------- */
export function FormSection({ title, description, children, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('grid gap-4 md:grid-cols-[220px_1fr] py-6 border-b border-line last:border-0', className)}>
      <div>
        <h4 className="text-[15px] font-semibold text-gray-900">{title}</h4>
        {description && <p className="mt-1 text-[13px] text-gray-500">{description}</p>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </div>
  );
}

/* ---------------- Select (native styled) ---------------- */
export function Select({ value, onChange, options, placeholder = 'Select...', className, disabled, size }: { value: string | number | null | undefined; onChange: (v: string) => void; options: { value: string | number; label: string }[]; placeholder?: string; className?: string; disabled?: boolean; size?: 'sm' }) {
  return (
    <div className={cx('relative', className)}>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={cx('input appearance-none pr-8', size === 'sm' && 'input-sm')}>
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
    </div>
  );
}

/* ---------------- Combobox (searchable; single or multi) ---------------- */
export interface Option { value: string; label: string; sub?: string }
export function Combobox({ value, onChange, options, placeholder = 'Select...', multiple, disabled, className, size, clearable = true, onCreate, createLabel }: { value: string | string[] | null | undefined; onChange: (v: any) => void; options: Option[]; placeholder?: string; multiple?: boolean; disabled?: boolean; className?: string; size?: 'sm'; clearable?: boolean; onCreate?: (text: string) => void; createLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean }>({ top: 0, left: 0, width: 0, up: false });
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const up = window.innerHeight - r.bottom < 280 && r.top > 280;
    setPos({ top: up ? r.top : r.bottom, left: r.left, width: Math.max(r.width, 220), up });
  };
  useEffect(() => {
    if (!open) return;
    place();
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false));
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', esc, true);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', esc, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open]);
  const selected = useMemo(() => (multiple ? (Array.isArray(value) ? value : []) : value ? [String(value)] : []), [value, multiple]);
  const filtered = useMemo(() => (q ? options.filter((o) => (o.label + ' ' + (o.sub ?? '')).toLowerCase().includes(q.toLowerCase())) : options), [options, q]);
  const toggle = (v: string) => {
    if (multiple) onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
    else {
      onChange(v);
      setOpen(false);
    }
    setQ('');
  };
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  return (
    <div ref={ref} className={cx('relative', className)}>
      <button type="button" disabled={disabled} onClick={() => setOpen((o) => !o)} className={cx('input flex items-center gap-1 text-left pr-8', size === 'sm' && 'input-sm h-auto min-h-8', multiple && 'h-auto min-h-10 py-1 flex-wrap')}>
        {selected.length === 0 ? (
          <span className="text-gray-400 truncate">{placeholder}</span>
        ) : multiple ? (
          selected.map((v) => (
            <span key={v} className="badge bg-gray-100 text-gray-700 gap-1">
              {labelOf(v)}
              <X className="h-3 w-3 cursor-pointer" onClick={(e) => { e.stopPropagation(); toggle(v); }} />
            </span>
          ))
        ) : (
          <span className="truncate text-gray-800">{labelOf(selected[0])}</span>
        )}
        <span className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 text-gray-500">
          {clearable && selected.length > 0 && !disabled && <X className="h-3.5 w-3.5 hover:text-gray-800" onClick={(e) => { e.stopPropagation(); onChange(multiple ? [] : ''); }} />}
          <ChevronDown className="h-4 w-4" />
        </span>
      </button>
      {open &&
        createPortal(
          <div ref={popRef} style={{ position: 'fixed', left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top + 4 } : { top: pos.top + 4 }) }} className="z-[100] card shadow-lg overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search className="h-4 w-4 text-gray-400" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type to search" className="h-9 w-full text-[13px] outline-none" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (filtered[0]) toggle(filtered[0].value); } }} />
            </div>
            <ul className="max-h-60 overflow-y-auto py-1">
              {filtered.length === 0 && !onCreate && <li className="px-3 py-2 text-[13px] text-gray-500">No results</li>}
              {filtered.map((o) => (
                <li key={o.value} onClick={() => toggle(o.value)} className={cx('flex items-center justify-between gap-2 px-3 py-2 text-[13px] cursor-pointer hover:bg-gray-50', selected.includes(o.value) && 'bg-primary-lighter/40')}>
                  <span className="truncate">
                    {o.label}
                    {o.sub && <span className="ml-1 text-gray-400">{o.sub}</span>}
                  </span>
                  {selected.includes(o.value) && <Check className="h-4 w-4 text-primary shrink-0" />}
                </li>
              ))}
              {onCreate && q && !filtered.some((o) => o.label.toLowerCase() === q.toLowerCase()) && (
                <li onClick={() => { onCreate(q); setQ(''); setOpen(false); }} className="px-3 py-2 text-[13px] text-primary cursor-pointer hover:bg-gray-50">+ {createLabel ?? 'Add'} "{q}"</li>
              )}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}

/* ---------------- Checkbox / Switch / Radio ---------------- */
export function Checkbox({ checked, onChange, label, disabled, className, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; className?: string; /** accessible name when the checkbox has no visible label (e.g. a grid cell) */ ariaLabel?: string }) {
  return (
    <label className={cx('inline-flex items-center gap-2 text-[14px] text-gray-700 cursor-pointer select-none', disabled && 'opacity-50 cursor-not-allowed', className)}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={label ? undefined : ariaLabel} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary/40 accent-primary" />
      {label}
    </label>
  );
}
export function Switch({ checked, onChange, label, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <label className={cx('inline-flex items-center gap-2 text-[14px] text-gray-700 cursor-pointer select-none', disabled && 'opacity-50', className)}>
      <span role="switch" aria-checked={checked} onClick={() => !disabled && onChange(!checked)} className={cx('relative inline-flex h-5 w-9 shrink-0 rounded-full transition', checked ? 'bg-primary' : 'bg-gray-300')}>
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition', checked ? 'left-[18px]' : 'left-0.5')} />
      </span>
      {label}
    </label>
  );
}
export function RadioGroup({ value, onChange, options, inline = true, name }: { value: string; onChange: (v: string) => void; options: { value: string; label: ReactNode }[]; inline?: boolean; name?: string }) {
  return (
    <div className={cx('flex gap-4', inline ? 'flex-wrap items-center' : 'flex-col')}>
      {options.map((o) => (
        <label key={o.value} className="inline-flex items-center gap-2 text-[14px] text-gray-700 cursor-pointer">
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} className="h-4 w-4 accent-primary" />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/* ---------------- Tabs ---------------- */
export function Tabs({ value, onChange, tabs, className }: { value: string; onChange: (v: string) => void; tabs: { value: string; label: ReactNode; count?: number }[]; className?: string }) {
  return (
    <div className={cx('flex gap-6 border-b border-line overflow-x-auto', className)}>
      {tabs.map((t) => (
        <button key={t.value} type="button" onClick={() => onChange(t.value)} className={cx('-mb-px whitespace-nowrap border-b-2 px-1 pb-2.5 pt-1 text-[14px] font-medium transition', value === t.value ? 'border-primary text-primary' : 'border-transparent text-gray-500 hover:text-gray-800')}>
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 badge bg-gray-100 text-gray-600">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Dropdown menu ---------------- */
export interface MenuItem { label: ReactNode; onClick?: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean; divider?: boolean }
export function Dropdown({ trigger, items, align = 'right', className }: { trigger?: ReactNode; items: MenuItem[]; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div ref={ref} className={cx('relative inline-block', className)}>
      <span onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>{trigger ?? <button type="button" className="icon-btn"><MoreVertical className="h-4 w-4" /></button>}</span>
      {open && (
        <div className={cx('absolute z-50 mt-1 min-w-[180px] card shadow-lg py-1', align === 'right' ? 'right-0' : 'left-0')}>
          {items.map((it, i) =>
            it.divider ? (
              <div key={i} className="my-1 border-t border-line" />
            ) : (
              <button key={i} type="button" disabled={it.disabled} onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick?.(); }} className={cx('flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-gray-50 disabled:opacity-50', it.danger ? 'text-red-600' : 'text-gray-700')}>
                {it.icon}
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Misc ---------------- */
export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cx('h-4 w-4 animate-spin', className)} />;

export function Badge({ children, color = 'gray', className }: { children: ReactNode; color?: 'gray' | 'green' | 'red' | 'blue' | 'amber' | 'purple'; className?: string }) {
  const c = { gray: 'bg-gray-100 text-gray-700', green: 'bg-green-50 text-green-700', red: 'bg-red-50 text-red-700', blue: 'bg-primary-lighter text-primary-dark', amber: 'bg-amber-50 text-amber-700', purple: 'bg-purple-50 text-purple-700' }[color];
  return <span className={cx('badge', c, className)}>{children}</span>;
}

export function EmptyState({ title = 'No data found', description, action, icon }: { title?: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-3 text-gray-300">{icon}</div>
      <p className="text-[15px] font-medium text-gray-700">{title}</p>
      {description && <p className="mt-1 text-[13px] text-gray-500 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, breadcrumb }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumb?: { label: string; href?: string }[] }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        {breadcrumb && (
          <div className="mb-1 flex items-center gap-1 text-[12px] text-gray-500">
            {breadcrumb.map((b, i) => (
              <Fragment key={i}>
                {i > 0 && <span>/</span>}
                <span className={i === breadcrumb.length - 1 ? 'text-gray-700' : ''}>{b.label}</span>
              </Fragment>
            ))}
          </div>
        )}
        <h2 className="text-[20px] font-semibold text-gray-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[13px] text-gray-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: 'sm' }>(function TextInput({ className, size, ...rest }, ref) {
  return <input ref={ref} {...rest} className={cx('input', size === 'sm' && 'input-sm', className)} />;
});
export const TextArea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return <textarea ref={ref} {...rest} className={cx('input h-auto min-h-[80px] py-2', className)} />;
});
