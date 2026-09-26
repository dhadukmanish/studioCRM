import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, Bookmark, ChevronDown, ChevronLeft, ChevronRight, Columns3, Download, Filter, GripVertical, Lock, MoreVertical, Plus, RefreshCw, RotateCcw, Save, Search, Trash2, Upload, X } from 'lucide-react';
import { FILTER_OPS, OPS_WITHOUT_VALUE, isIsoDate, type FilterFieldDef, type ListFilter, type FilterOp } from '@erp/shared';
import { Checkbox, Combobox, DateInput, Dropdown, EmptyState, Modal, Select, Spinner, TextInput } from '@/components/ui';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cx } from '@/lib/format';

/* ============================================================================
 * Types
 * ========================================================================== */
export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (row: T, index: number) => ReactNode;
  /** default true — set false for computed/action columns */
  sortable?: boolean;
  /** value used for client-side sorting (defaults to row[key]) */
  sortValue?: (row: T) => string | number | null | undefined;
  width?: string | number;
  align?: 'left' | 'right' | 'center';
  /** hidden by default (user can enable in Customize Columns) */
  hidden?: boolean;
  /** cannot be hidden / reordered (first column in reference UI) */
  locked?: boolean;
  className?: string;
  /** Extra classes for the header cell (e.g. let a long header wrap to two lines). */
  headerClassName?: string;
}

export interface ListState {
  page: number;
  limit: number;
  search: string;
  sortBy?: string;
  sortOrder: 'asc' | 'desc';
  filters: ListFilter[];
}

export function useListState(init?: Partial<ListState>) {
  const [state, setState] = useState<ListState>({ page: 1, limit: 20, search: '', sortOrder: 'desc', filters: [], ...init });
  const set = (p: Partial<ListState>) => setState((s) => ({ ...s, ...p, page: p.page ?? (p.search !== undefined || p.limit !== undefined || p.sortBy !== undefined || p.filters !== undefined ? 1 : s.page) }));
  return [state, set] as const;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  total?: number;
  loading?: boolean;
  state?: ListState;
  onStateChange?: (p: Partial<ListState>) => void;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Extra classes for one desktop table row (e.g. a rule where a report's next group starts). */
  rowClassName?: (row: T, index: number) => string | false | undefined;
  selectable?: boolean;
  selected?: string[];
  onSelectedChange?: (ids: string[]) => void;
  toolbar?: ReactNode;
  actions?: ReactNode;
  /** dynamic filter builder fields (defaults to all columns as text) */
  filterFields?: FilterFieldDef[] | false;
  /** persist column layout + saved filters under this module name */
  storageKey?: string;
  /** show a visible "Columns" button next to the kebab (the kebab always has it too) */
  columnsButton?: boolean;
  onRefresh?: () => void;
  onImport?: () => void;
  onExport?: () => void;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  rowActions?: (row: T) => ReactNode;
  footer?: ReactNode;
  /**
   * A totals row under the table, aligned with the visible columns (by column key) — a report's
   * whole-result totals. Desktop table only; give phones a `footer` strip.
   */
  totalsRow?: Record<string, ReactNode>;
  dense?: boolean;
  /** Narrower cell padding (12px instead of 20px) for wide, figure-heavy tables such as reports. */
  compact?: boolean;
  hideSearch?: boolean;
  hidePagination?: boolean;
  searchPlaceholder?: string;
  /** sort / filter rows in the browser (for lists the API returns whole) */
  clientSide?: boolean;
  /**
   * Phone-width rendering of one row. When given, below the `sm` breakpoint the rows show as
   * stacked cards instead of a table squeezed into unreadable columns; the toolbar, sorting and
   * pagination are unchanged.
   */
  mobileCard?: (row: T, index: number) => ReactNode;
}

/* ============================================================================
 * Helpers
 * ========================================================================== */
type Layout = { key: string; visible: boolean }[];

const defaultLayout = (columns: Column<any>[]): Layout => [...columns.filter((c) => c.locked), ...columns.filter((c) => !c.locked)].map((c) => ({ key: c.key, visible: c.locked ? true : !c.hidden }));

function applyClientFilters<T>(rows: T[], filters: ListFilter[]) {
  if (!filters.length) return rows;
  return rows.filter((r: any) =>
    filters.every((f) => {
      const raw = r[f.field];
      const s = raw == null ? '' : String(raw).toLowerCase();
      const v = f.value == null ? '' : String(f.value).toLowerCase();
      switch (f.op) {
        case 'contains': return !v || s.includes(v);
        case 'not_contains': return !s.includes(v);
        case 'equals': return v ? s === v : true;
        case 'not_equals': return s !== v;
        case 'starts_with': return s.startsWith(v);
        case 'ends_with': return s.endsWith(v);
        case 'gt': return Number(raw) > Number(f.value);
        case 'gte': return raw >= (f.value as any);
        case 'lt': return Number(raw) < Number(f.value);
        case 'lte': return raw <= (f.value as any);
        case 'between': { const [a, b] = Array.isArray(f.value) ? f.value : String(f.value).split(','); return raw >= a && raw <= b; }
        case 'in': return (Array.isArray(f.value) ? f.value : String(f.value).split(',')).map(String).includes(String(raw));
        case 'is_empty': return raw == null || raw === '';
        case 'is_not_empty': return raw != null && raw !== '';
        default: return true;
      }
    }),
  );
}

function applyClientSort<T>(rows: T[], columns: Column<T>[], sortBy?: string, order: 'asc' | 'desc' = 'asc') {
  if (!sortBy) return rows;
  const col = columns.find((c) => c.key === sortBy);
  const val = (r: T) => (col?.sortValue ? col.sortValue(r) : (r as any)[sortBy]);
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
    return order === 'asc' ? c : -c;
  });
}

/* ============================================================================
 * Filter builder (field ▾ | operator ▾ | ×  /  value)
 * ========================================================================== */
/** A date filter only ever holds a real "YYYY-MM-DD": half-typed text must not reach the server's `::date` cast. */
const isoOrBlank = (v: string) => (isIsoDate(v) ? v : '');

function FilterBuilder({ fields, value, onApply, onClose, storageKey }: { fields: FilterFieldDef[]; value: ListFilter[]; onApply: (f: ListFilter[]) => void; onClose: () => void; storageKey?: string }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ListFilter[]>(value.length ? value : [{ field: fields[0]?.key ?? '', op: 'contains', value: '' }]);
  const [saveName, setSaveName] = useState<string | null>(null);
  useEffect(() => { setDraft(value.length ? value : [{ field: fields[0]?.key ?? '', op: 'contains', value: '' }]); }, [value]); // eslint-disable-line
  const def = (key: string) => fields.find((f) => f.key === key);
  const opsFor = (key: string) => FILTER_OPS[def(key)?.type ?? 'text'];
  const upd = (i: number, p: Partial<ListFilter>) => setDraft((d) => d.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const setField = (i: number, key: string) => { const ops = opsFor(key); upd(i, { field: key, op: ops[0].value, value: def(key)?.type === 'select' ? [] : '' }); };
  const valid = draft.filter((f) => f.field && (OPS_WITHOUT_VALUE.includes(f.op) || (Array.isArray(f.value) ? f.value.length : f.value !== '' && f.value != null)));
  const saveGroup = async () => {
    if (!storageKey || !saveName?.trim()) return;
    const existing = (qc.getQueryData<any[]>(['filter-groups', storageKey]) ?? []).filter((g) => g.name !== saveName.trim());
    await api.put('/api/filter-groups', { moduleName: storageKey, filterGroups: [...existing, { name: saveName.trim(), filters: valid }] });
    qc.invalidateQueries({ queryKey: ['filter-groups', storageKey] });
    toast.success('Filter saved');
    setSaveName(null);
  };
  return (
    <div className="border-b border-line">
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <span className="text-[13px] font-medium text-gray-800">Filters</span>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex flex-wrap gap-3 px-4 py-2">
        {draft.map((f, i) => {
          const d = def(f.field);
          const type = d?.type ?? 'text';
          const noValue = OPS_WITHOUT_VALUE.includes(f.op);
          return (
            <div key={i} className="w-[380px] rounded-lg bg-gray-50 p-2.5">
              <div className="flex items-center gap-2">
                <Select size="sm" className="flex-1" value={f.field} placeholder="" onChange={(v) => setField(i, v)} options={fields.map((x) => ({ value: x.key, label: x.label }))} />
                <Select size="sm" className="w-[130px]" value={f.op} placeholder="" onChange={(v) => upd(i, { op: v as FilterOp })} options={opsFor(f.field).map((o) => ({ value: o.value, label: o.label }))} />
                <button type="button" className="icon-btn h-7 w-7 shrink-0" onClick={() => setDraft((x) => x.filter((_, j) => j !== i))}><X className="h-3.5 w-3.5" /></button>
              </div>
              {!noValue && (
                <div className="mt-2">
                  {type === 'select' && f.op === 'in' ? (
                    <Combobox multiple size="sm" value={Array.isArray(f.value) ? (f.value as string[]) : []} onChange={(v) => upd(i, { value: v })} options={d?.options ?? []} placeholder="Select values" />
                  ) : type === 'select' ? (
                    <Select size="sm" value={String(f.value ?? '')} onChange={(v) => upd(i, { value: v })} options={d?.options ?? []} placeholder="Select value" />
                  ) : type === 'boolean' ? (
                    <Select size="sm" value={String(f.value ?? '')} onChange={(v) => upd(i, { value: v })} options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} placeholder="Select" />
                  ) : type === 'date' && f.op === 'between' ? (
                    <div className="flex items-center gap-2">
                      <DateInput size="sm" value={Array.isArray(f.value) ? String(f.value[0] ?? '') : ''} onChange={(v) => upd(i, { value: [isoOrBlank(v), Array.isArray(f.value) ? f.value[1] : ''] })} />
                      <span className="text-[12px] text-gray-500">and</span>
                      <DateInput size="sm" value={Array.isArray(f.value) ? String(f.value[1] ?? '') : ''} onChange={(v) => upd(i, { value: [Array.isArray(f.value) ? f.value[0] : '', isoOrBlank(v)] })} />
                    </div>
                  ) : type === 'date' ? (
                    <DateInput size="sm" value={String(f.value ?? '')} onChange={(v) => upd(i, { value: isoOrBlank(v) })} />
                  ) : f.op === 'between' ? (
                    <div className="flex items-center gap-2">
                      <TextInput size="sm" type="number" value={Array.isArray(f.value) ? String(f.value[0] ?? '') : ''} onChange={(e) => upd(i, { value: [e.target.value, Array.isArray(f.value) ? f.value[1] : ''] })} />
                      <span className="text-[12px] text-gray-500">and</span>
                      <TextInput size="sm" type="number" value={Array.isArray(f.value) ? String(f.value[1] ?? '') : ''} onChange={(e) => upd(i, { value: [Array.isArray(f.value) ? f.value[0] : '', e.target.value] })} />
                    </div>
                  ) : (
                    <TextInput size="sm" type={type === 'number' ? 'number' : 'text'} value={String(f.value ?? '')} placeholder="Filter value" onChange={(e) => upd(i, { value: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onApply(valid)} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-3 pt-1">
        <button type="button" className="link inline-flex items-center gap-1 text-[13px]" onClick={() => setDraft((d) => [...d, { field: fields[0]?.key ?? '', op: 'contains', value: '' }])}><Plus className="h-4 w-4" /> Add filter</button>
        <div className="flex items-center gap-2">
          <button type="button" className="text-[13px] text-gray-600 hover:text-gray-900 mr-2" onClick={() => { setDraft([]); onApply([]); }}>Remove all</button>
          {storageKey && (saveName === null ? (
            <button type="button" className="btn-outline-primary" onClick={() => setSaveName('')} disabled={!valid.length}><Save className="h-4 w-4" /> Save</button>
          ) : (
            <span className="inline-flex items-center gap-1"><TextInput size="sm" autoFocus placeholder="Filter name" value={saveName} onChange={(e) => setSaveName(e.target.value)} className="w-[160px]" onKeyDown={(e) => e.key === 'Enter' && saveGroup()} /><button type="button" className="btn-primary" onClick={saveGroup}>OK</button><button type="button" className="btn-ghost" onClick={() => setSaveName(null)}>✕</button></span>
          ))}
          <button type="button" className="btn-outline-primary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => onApply(valid)}>Filter</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * Customize columns (drag to reorder, locked first column, search, reset)
 * ========================================================================== */
function CustomizeColumns({ open, onClose, columns, layout, onSave }: { open: boolean; onClose: () => void; columns: Column<any>[]; layout: Layout; onSave: (l: Layout) => void }) {
  const [draft, setDraft] = useState<Layout>(layout);
  const [q, setQ] = useState('');
  const dragFrom = useRef<number | null>(null);
  useEffect(() => { if (open) { setDraft(layout); setQ(''); } }, [open, layout]);
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const selected = draft.filter((d) => d.visible).length;
  const move = (from: number, to: number) => setDraft((d) => { if (from === to || byKey.get(d[to]?.key)?.locked) return d; const n = [...d]; const [it] = n.splice(from, 1); n.splice(to, 0, it); return n; });
  return (
    <Modal open={open} onClose={onClose} size="sm" title={<div><div>Customize Columns</div><div className="text-[12px] font-normal text-gray-500">{selected} of {draft.length} Selected</div></div>}
      footer={<><button className="btn-outline mr-auto" onClick={() => setDraft(defaultLayout(columns))}><RotateCcw className="h-4 w-4" /> Reset to Default</button><button className="btn-outline-primary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={() => { onSave(draft); onClose(); }}>Save</button></>}>
      <div className="relative mb-3"><Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search columns..." className="input input-sm pl-9" /></div>
      <ul className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
        {draft.map((d, i) => {
          const c = byKey.get(d.key);
          if (!c) return null;
          const label = typeof c.header === 'string' ? c.header : d.key;
          if (q && !label.toLowerCase().includes(q.toLowerCase())) return null;
          return (
            <li key={d.key} draggable={!c.locked && !q} onDragStart={() => (dragFrom.current = i)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragFrom.current != null) move(dragFrom.current, i); dragFrom.current = null; }}
              className={cx('flex items-center gap-2 rounded-lg border border-line bg-white px-2 py-2 text-[14px]', !c.locked && !q && 'cursor-grab active:cursor-grabbing', c.locked && 'bg-gray-50')}>
              <GripVertical className={cx('h-4 w-4', c.locked ? 'text-gray-200' : 'text-gray-400')} />
              <Checkbox checked={d.visible} disabled={c.locked} onChange={(v) => setDraft((x) => x.map((y) => (y.key === d.key ? { ...y, visible: v } : y)))} />
              <span className={cx('flex-1', !d.visible && 'text-gray-500')}>{label}</span>
              {c.locked && <Lock className="h-3.5 w-3.5 text-gray-400" />}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

/* ============================================================================
 * DataTable
 * ========================================================================== */
export function DataTable<T>({ columns, rows, total, loading, state, onStateChange, rowKey, onRowClick, rowClassName, selectable, selected = [], onSelectedChange, toolbar, actions, filterFields, storageKey, columnsButton, onRefresh, onImport, onExport, emptyTitle, emptyDescription, rowActions, footer, totalsRow, dense, compact, hideSearch, hidePagination, searchPlaceholder, clientSide, mobileCard }: Props<T>) {
  const qc = useQueryClient();
  const [showFilters, setShowFilters] = useState(false);
  const [customize, setCustomize] = useState(false);
  const [search, setSearch] = useState(state?.search ?? '');
  useEffect(() => setSearch(state?.search ?? ''), [state?.search]);
  useEffect(() => {
    if (!onStateChange || state === undefined) return;
    const t = setTimeout(() => search !== state.search && onStateChange({ search }), 350);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- column layout: local first, then server preference ---- */
  const [layout, setLayout] = useState<Layout>(() => {
    try { const saved = storageKey && localStorage.getItem(`cols:${storageKey}`); if (saved) return mergeLayout(JSON.parse(saved), columns); } catch {}
    return defaultLayout(columns);
  });
  const serverLayout = useQuery({ queryKey: ['column-preferences', storageKey], queryFn: () => api.get<Layout>(`/api/column-preferences?moduleName=${storageKey}`), enabled: !!storageKey, staleTime: Infinity });
  useEffect(() => { if (serverLayout.data?.length) setLayout(mergeLayout(serverLayout.data, columns)); }, [serverLayout.data]); // eslint-disable-line
  const saveLayout = (l: Layout) => {
    setLayout(l);
    if (!storageKey) return;
    try { localStorage.setItem(`cols:${storageKey}`, JSON.stringify(l)); } catch {}
    api.put('/api/column-preferences', { moduleName: storageKey, columns: l }).then(() => qc.setQueryData(['column-preferences', storageKey], l)).catch(() => {});
  };
  const cols = useMemo(() => layout.filter((l) => l.visible).map((l) => columns.find((c) => c.key === l.key)!).filter(Boolean), [columns, layout]);

  /* ---- saved filter groups ---- */
  const filterGroups = useQuery({ queryKey: ['filter-groups', storageKey], queryFn: () => api.get<{ name: string; filters: ListFilter[] }[]>(`/api/filter-groups?moduleName=${storageKey}`), enabled: !!storageKey && filterFields !== false, staleTime: 60_000 });
  const fields: FilterFieldDef[] = useMemo(() => (filterFields === false ? [] : filterFields ?? columns.filter((c) => c.sortable !== false).map((c) => ({ key: c.key, label: typeof c.header === 'string' ? c.header : c.key, type: 'text' as const }))), [filterFields, columns]);
  const activeFilters = state?.filters ?? [];

  /* ---- client-side processing ---- */
  const shown = useMemo(() => (clientSide ? applyClientSort(applyClientFilters(rows, activeFilters), columns, state?.sortBy, state?.sortOrder) : rows), [rows, clientSide, activeFilters, state?.sortBy, state?.sortOrder, columns]);

  const allIds = shown.map(rowKey);
  const allChecked = allIds.length > 0 && allIds.every((id) => selected.includes(id));
  const toggleAll = () => onSelectedChange?.(allChecked ? selected.filter((id) => !allIds.includes(id)) : Array.from(new Set([...selected, ...allIds])));

  const count = clientSide ? shown.length : total ?? rows.length;
  const page = state?.page ?? 1;
  const limit = state?.limit ?? (rows.length || 1);
  const from = count === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(count, page * limit);
  const pages = Math.max(1, Math.ceil(count / limit));

  const sortIcon = (c: Column<T>) => {
    if (c.sortable === false) return null;
    if (state?.sortBy !== c.key) return <ArrowUpDown className="h-3 w-3 text-gray-300 opacity-0 group-hover:opacity-100" />;
    return state.sortOrder === 'asc' ? <ArrowUp className="h-3 w-3 text-primary" /> : <ArrowDown className="h-3 w-3 text-primary" />;
  };
  const onSort = (c: Column<T>) => c.sortable !== false && onStateChange?.({ sortBy: c.key, sortOrder: state?.sortBy === c.key && state.sortOrder === 'asc' ? 'desc' : 'asc' });

  const kebab = [
    ...(onImport ? [{ label: 'Import', icon: <Upload className="h-4 w-4" />, onClick: onImport }] : []),
    ...(onExport ? [{ label: 'Export', icon: <Download className="h-4 w-4" />, onClick: onExport }] : []),
    { label: 'Customize Columns', icon: <Columns3 className="h-4 w-4" />, onClick: () => setCustomize(true) },
    ...(onRefresh ? [{ label: 'Refresh', icon: <RefreshCw className="h-4 w-4" />, onClick: onRefresh }] : []),
  ];
  const savedItems = (filterGroups.data ?? []).map((g) => ({ label: <span className="flex items-center gap-2"><Bookmark className="h-3.5 w-3.5" />{g.name}</span>, onClick: () => { onStateChange?.({ filters: g.filters }); setShowFilters(true); } }));

  return (
    <div className="card overflow-hidden">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-line">
        {toolbar}
        {!hideSearch && (
          <div className="relative w-full sm:w-[320px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={searchPlaceholder ?? 'Search...'} className="input input-sm pl-9 pr-8" />
            {search && <X className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 cursor-pointer" onClick={() => setSearch('')} />}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {selected.length > 0 && <span className="text-[13px] text-gray-500">{selected.length} selected</span>}
          {fields.length > 0 && (
            <span className="inline-flex">
              <button type="button" onClick={() => setShowFilters((s) => !s)} className={cx('btn-outline-primary rounded-r-none', activeFilters.length > 0 && 'bg-primary/5')}>
                <Filter className="h-4 w-4" />{activeFilters.length > 0 && <span className="badge bg-primary text-white">{activeFilters.length}</span>}
              </button>
              <Dropdown trigger={<button type="button" className="btn-outline-primary rounded-l-none border-l-0 px-1.5"><ChevronDown className="h-4 w-4" /></button>} items={savedItems.length ? [...savedItems, { divider: true, label: '' }, { label: 'Clear filters', icon: <Trash2 className="h-4 w-4" />, onClick: () => onStateChange?.({ filters: [] }) }] : [{ label: 'No saved filters', disabled: true }]} />
            </span>
          )}
          {columnsButton && (
            // Phone cards have no columns to choose; Customize Columns stays in the kebab.
            <button type="button" onClick={() => setCustomize(true)} className={cx('btn-outline', mobileCard && 'max-sm:hidden')}><Columns3 className="h-4 w-4" /> Columns</button>
          )}
          {actions}
          <Dropdown items={kebab} trigger={<button type="button" className="icon-btn" aria-label="More list options" title="More"><MoreVertical className="h-4 w-4" /></button>} />
        </div>
      </div>
      {showFilters && fields.length > 0 && <FilterBuilder fields={fields} value={activeFilters} storageKey={storageKey} onClose={() => setShowFilters(false)} onApply={(f) => onStateChange?.({ filters: f })} />}

      {mobileCard && (
        <ul className="divide-y divide-line sm:hidden">
          {loading && shown.length === 0 && <li className="py-10 text-center text-gray-500"><Spinner className="inline h-5 w-5" /></li>}
          {!loading && shown.length === 0 && <li><EmptyState title={emptyTitle} description={emptyDescription} /></li>}
          {shown.map((r, i) => (
            <li
              key={rowKey(r)}
              onClick={() => onRowClick?.(r)}
              {...(onRowClick ? { role: 'button', tabIndex: 0, onKeyDown: (e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), onRowClick(r)) } : {})}
              className={cx('flex items-start gap-2 px-4 py-3', onRowClick && 'cursor-pointer active:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none', loading && 'opacity-60')}
            >
              <div className="min-w-0 flex-1">{mobileCard(r, i)}</div>
              {rowActions && <div onClick={(e) => e.stopPropagation()}>{rowActions(r)}</div>}
            </li>
          ))}
        </ul>
      )}
      {/* table */}
      <div className={cx('overflow-x-auto', mobileCard && 'hidden sm:block')}>
        <table className="min-w-full">
          <thead className="bg-head border-b border-line">
            <tr>
              {selectable && (
                <th className="table-head w-10 !px-4"><Checkbox checked={allChecked} onChange={toggleAll} /></th>
              )}
              {cols.map((c) => (
                <th key={c.key} style={{ width: c.width }} className={cx('table-head group', compact && '!px-3', c.sortable !== false && 'cursor-pointer select-none hover:text-gray-800', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.headerClassName)} onClick={() => onSort(c)}>
                  <span className="inline-flex items-center gap-1">{c.header}{sortIcon(c)}</span>
                </th>
              ))}
              {rowActions && <th className={cx('table-head w-16 text-right', compact && '!px-3')}>Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {loading && shown.length === 0 && (
              <tr><td colSpan={cols.length + 2} className="py-12 text-center text-gray-500"><Spinner className="inline h-5 w-5" /></td></tr>
            )}
            {!loading && shown.length === 0 && (
              <tr><td colSpan={cols.length + 2}><EmptyState title={emptyTitle} description={emptyDescription} /></td></tr>
            )}
            {shown.map((r, i) => {
              const id = rowKey(r);
              const isSel = selected.includes(id);
              return (
                <tr key={id} onClick={() => onRowClick?.(r)} className={cx('transition-colors', onRowClick && 'cursor-pointer', isSel ? 'bg-primary-lighter/30' : 'hover:bg-gray-50/70', loading && 'opacity-60', rowClassName?.(r, i))}>
                  {selectable && (
                    <td className="table-cell !px-4" onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={isSel} onChange={(v) => onSelectedChange?.(v ? [...selected, id] : selected.filter((x) => x !== id))} />
                    </td>
                  )}
                  {cols.map((c) => (
                    <td key={c.key} className={cx('table-cell', dense && '!py-2.5', compact && '!px-3', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.className)}>
                      {c.render ? c.render(r, i) : ((r as any)[c.key] ?? '-') as ReactNode}
                    </td>
                  ))}
                  {rowActions && <td className={cx('table-cell text-right', dense && '!py-2.5', compact && '!px-3')} onClick={(e) => e.stopPropagation()}>{rowActions(r)}</td>}
                </tr>
              );
            })}
          </tbody>
          {totalsRow && shown.length > 0 && (
            <tfoot className="border-t-2 border-line bg-head">
              <tr>
                {selectable && <td />}
                {cols.map((c) => (
                  <td key={c.key} className={cx('table-cell !py-2.5 font-semibold text-gray-900', compact && '!px-3', c.align === 'right' && 'text-right')}>{totalsRow[c.key] ?? null}</td>
                ))}
                {rowActions && <td />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {footer}
      {!hidePagination && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-[13px] text-gray-600">
          <div className="flex items-center gap-2">
            <span>Rows per page</span>
            <Select size="sm" className="w-[80px]" value={limit} placeholder="" onChange={(v) => onStateChange?.({ limit: Number(v) })} options={[10, 20, 50, 100].map((n) => ({ value: n, label: String(n) }))} />
          </div>
          <div className="flex items-center gap-3">
            <span>Showing <b>{from}-{to}</b> of <b>{count}</b></span>
            <div className="flex items-center gap-1">
              <button className="icon-btn h-7 w-7" aria-label="Previous page" disabled={page <= 1} onClick={() => onStateChange?.({ page: page - 1 })}><ChevronLeft className="h-4 w-4" /></button>
              {pageNumbers(page, pages).map((n, i) => (typeof n === 'string' ? <span key={`e${i}`} className="px-1">…</span> : <button key={n} onClick={() => onStateChange?.({ page: n })} className={cx('h-7 min-w-7 rounded-lg px-2 text-[13px]', n === page ? 'bg-primary text-white' : 'hover:bg-gray-100')}>{n}</button>))}
              <button className="icon-btn h-7 w-7" aria-label="Next page" disabled={page >= pages} onClick={() => onStateChange?.({ page: page + 1 })}><ChevronRight className="h-4 w-4" /></button>
            </div>
          </div>
        </div>
      )}
      <CustomizeColumns open={customize} onClose={() => setCustomize(false)} columns={columns} layout={layout} onSave={saveLayout} />
    </div>
  );
}

/** Merge a saved layout with the current column definitions (new columns appended, removed ones dropped). */
function mergeLayout(saved: Layout, columns: Column<any>[]): Layout {
  const known = new Set(columns.map((c) => c.key));
  const kept = saved.filter((s) => known.has(s.key));
  const seen = new Set(kept.map((s) => s.key));
  const extra = columns.filter((c) => !seen.has(c.key)).map((c) => ({ key: c.key, visible: !c.hidden }));
  const merged = [...kept, ...extra];
  // locked columns always first and visible
  const locked = columns.filter((c) => c.locked).map((c) => c.key);
  return [...locked.map((k) => ({ key: k, visible: true })), ...merged.filter((m) => !locked.includes(m.key))];
}

function pageNumbers(page: number, pages: number): (number | string)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const set = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const arr = Array.from(set).sort((a, b) => a - b);
  const out: (number | string)[] = [];
  arr.forEach((n, i) => { if (i > 0 && n - (arr[i - 1] as number) > 1) out.push('…'); out.push(n); });
  return out;
}
