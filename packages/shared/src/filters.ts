// Dynamic list filters shared by API (query parsing) and web (filter builder UI)

export type FilterFieldType = 'text' | 'number' | 'date' | 'select' | 'boolean';

export type FilterOp = 'contains' | 'not_contains' | 'equals' | 'not_equals' | 'starts_with' | 'ends_with' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'in' | 'is_empty' | 'is_not_empty';

export interface ListFilter {
  field: string;
  op: FilterOp;
  value?: string | number | boolean | null | (string | number)[];
}

export interface FilterFieldDef {
  key: string;
  label: string;
  type?: FilterFieldType;
  options?: { value: string; label: string }[];
}

export const FILTER_OPS: Record<FilterFieldType, { value: FilterOp; label: string }[]> = {
  text: [
    { value: 'contains', label: 'Contains' },
    { value: 'not_contains', label: 'Does not contain' },
    { value: 'equals', label: 'Equals' },
    { value: 'not_equals', label: 'Not equals' },
    { value: 'starts_with', label: 'Starts with' },
    { value: 'ends_with', label: 'Ends with' },
    { value: 'is_empty', label: 'Is empty' },
    { value: 'is_not_empty', label: 'Is not empty' },
  ],
  number: [
    { value: 'equals', label: 'Equals' },
    { value: 'not_equals', label: 'Not equals' },
    { value: 'gt', label: 'Greater than' },
    { value: 'gte', label: 'Greater or equal' },
    { value: 'lt', label: 'Less than' },
    { value: 'lte', label: 'Less or equal' },
    { value: 'between', label: 'Between' },
    { value: 'is_empty', label: 'Is empty' },
  ],
  date: [
    { value: 'equals', label: 'On' },
    { value: 'gte', label: 'On or after' },
    { value: 'lte', label: 'On or before' },
    { value: 'between', label: 'Between' },
    { value: 'is_empty', label: 'Is empty' },
  ],
  select: [
    { value: 'in', label: 'Is any of' },
    { value: 'equals', label: 'Is' },
    { value: 'not_equals', label: 'Is not' },
    { value: 'is_empty', label: 'Is empty' },
  ],
  boolean: [{ value: 'equals', label: 'Is' }],
};

export const OPS_WITHOUT_VALUE: FilterOp[] = ['is_empty', 'is_not_empty'];

/** Parse the `filters` query param (JSON string) defensively. */
export function parseFilters(raw: unknown): ListFilter[] {
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr.filter((f) => f && typeof f.field === 'string' && typeof f.op === 'string');
  } catch {
    return [];
  }
}
