// ---------------------------------------------------------------------------
// Application-wide enums. Add your own domain enums here (or in a new file).
// ---------------------------------------------------------------------------

/** Kinds of custom fields supported by the custom-field engine. */
export const CUSTOM_FIELD_TYPES = ['text', 'textarea', 'number', 'decimal', 'currency', 'percent', 'date', 'datetime', 'time', 'checkbox', 'toggle', 'select', 'multi_select', 'radio', 'checkbox_group', 'tags', 'email', 'url', 'phone', 'lookup'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_TYPE_GROUPS: { group: string; types: { type: CustomFieldType; label: string; desc: string }[] }[] = [
  { group: 'Text', types: [{ type: 'text', label: 'Single line', desc: 'Short text such as a name or code' }, { type: 'textarea', label: 'Multi line', desc: 'Longer notes or descriptions' }, { type: 'email', label: 'Email', desc: 'Validated e-mail address' }, { type: 'url', label: 'URL', desc: 'Web link' }, { type: 'phone', label: 'Phone', desc: 'Phone number' }] },
  { group: 'Number', types: [{ type: 'number', label: 'Number', desc: 'Whole number' }, { type: 'decimal', label: 'Decimal', desc: 'Number with decimals' }, { type: 'currency', label: 'Currency', desc: 'Money amount' }, { type: 'percent', label: 'Percent', desc: 'Percentage value' }] },
  { group: 'Date & time', types: [{ type: 'date', label: 'Date', desc: 'Calendar date' }, { type: 'datetime', label: 'Date & time', desc: 'Date with time' }, { type: 'time', label: 'Time', desc: 'Time of day' }] },
  { group: 'Choice', types: [{ type: 'select', label: 'Dropdown', desc: 'Pick one option' }, { type: 'multi_select', label: 'Multi select', desc: 'Pick many options' }, { type: 'radio', label: 'Radio', desc: 'One option, all visible' }, { type: 'checkbox_group', label: 'Checkbox group', desc: 'Many options, all visible' }, { type: 'tags', label: 'Tags', desc: 'Free-form tags' }, { type: 'lookup', label: 'Lookup', desc: 'Pick from a list you maintain' }] },
  { group: 'Boolean', types: [{ type: 'checkbox', label: 'Checkbox', desc: 'Yes / no' }, { type: 'toggle', label: 'Toggle', desc: 'On / off switch' }] },
];

/**
 * Modules that can carry custom fields. Add an entry when you create a new
 * entity that should support custom fields (and render <CustomFieldInputs moduleName=...>).
 */
export const CUSTOM_FIELD_MODULES: { name: string; label: string }[] = [
  { name: 'users', label: 'Users' },
  { name: 'companies', label: 'Companies' },
];

/**
 * GST slabs an item may be configured with — the statutory Indian set, so a new rate never
 * needs a code change. Item Master only stores the rate; nothing here calculates tax.
 */
export const GST_RATES = [0, 5, 12, 18, 28] as const;
export type GstRate = (typeof GST_RATES)[number];
/**
 * "18" -> "18%" (whole numbers stay whole, fractional slabs keep their decimals).
 * A missing rate renders as "-", never as "0%" — 0% is a real slab and must not stand in
 * for absent data.
 */
export const formatGst = (rate: number | string | null | undefined) => {
  if (rate === null || rate === undefined || rate === '') return '-';
  const n = Number(rate);
  if (Number.isNaN(n)) return '-';
  return `${n % 1 === 0 ? n : n.toFixed(2)}%`;
};

/**
 * Head groups an Account Group can be classified under — the set the studio's existing
 * accounting uses, in the order it presents them. Classification only: nothing in this phase
 * posts, balances or reports off these values.
 *
 * The Account Groups themselves (CASH, BANK, CUSTOMER, PARTNER, ...) are tenant data in
 * `account_groups`, never constants — only their classification is fixed.
 */
export const HEAD_GROUPS = ['LIABILITIES', 'ASSETS', 'EXPENSES', 'INCOME', 'CASH', 'OTHER'] as const;
export type HeadGroup = (typeof HEAD_GROUPS)[number];

export const THEME_MODES = ['light', 'dark', 'system'] as const;

/**
 * Which side of the account an opening balance sits on. The amount itself is always stored
 * positive — Credit is a side, never a negative number.
 *
 * Opening information only at this stage: nothing posts a ledger or journal entry from it.
 */
export const ACCOUNT_OPENING_SIDES = ['DEBIT', 'CREDIT'] as const;
export type AccountOpeningSide = (typeof ACCOUNT_OPENING_SIDES)[number];
/** "DEBIT" -> "Dr". The short form is what the studio's accounting has always shown. */
export const OPENING_SIDE_SHORT: Record<AccountOpeningSide, string> = { DEBIT: 'Dr', CREDIT: 'Cr' };

/**
 * The extra detail block an Account Group drives on the Account Master form, one storage kind
 * per block. `party` serves both CLIENT and EXPOSER/PARTY: the legacy screens show identical
 * fields for the two, only the heading differs.
 */
export const ACCOUNT_DETAIL_KINDS = ['bank', 'employee', 'loan', 'partner', 'party'] as const;
export type AccountDetailKind = (typeof ACCOUNT_DETAIL_KINDS)[number];

/**
 * Account Group NAME -> the detail block it drives, keyed by the normalized legacy names.
 *
 * Deliberately keyed on the group name, not on the head group: BANK is filed under ASSETS,
 * but that must not give every ASSETS group a bank account number. Groups the legacy screens
 * show with no extra fields (CASH, INCOME, EXPENSES, DISCOUNT) are simply absent here, which
 * is also how any group a tenant invents behaves — common fields only.
 */
const ACCOUNT_DETAIL_BY_GROUP: Record<string, { kind: AccountDetailKind; title: string }> = {
  BANK: { kind: 'bank', title: 'Bank Details' },
  EMPLOYEE: { kind: 'employee', title: 'Employee Details' },
  LOAN: { kind: 'loan', title: 'Loan Details' },
  PARTNER: { kind: 'partner', title: 'Partner Details' },
  CLIENT: { kind: 'party', title: 'Client Details' },
  'EXPOSER/PARTY': { kind: 'party', title: 'Party Details' },
};

/**
 * Matching key for a group name: upper-cased, trimmed, inner runs of whitespace collapsed and
 * whitespace around a slash removed, so "exposer / party" and "EXPOSER/PARTY" are the same
 * group. The stored name itself is never touched — this only decides which form to show.
 */
export const normalizeGroupName = (name: string) => name.trim().toUpperCase().replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ');

/** The detail block a group drives, or null for a group that has only the common fields. */
export function accountDetailFor(groupName: string | null | undefined) {
  if (!groupName) return null;
  return ACCOUNT_DETAIL_BY_GROUP[normalizeGroupName(groupName)] ?? null;
}

/**
 * How a bill presents tax. The business issues both kinds of invoice, so this is an explicit
 * mode on the bill rather than a guess made at print time.
 *
 * WITH_GST charges the GST rate each line snapshotted from Item Master. WITHOUT_GST charges
 * no tax at all — but the line keeps its GST snapshot, because that snapshot is a record of
 * the Item Master configuration the line was built from, not a tax that was charged. Nothing
 * about either mode edits Item Master, and the split into CGST/SGST/IGST is a later phase.
 */
export const INVOICE_TAX_MODES = ['WITH_GST', 'WITHOUT_GST'] as const;
export type InvoiceTaxMode = (typeof INVOICE_TAX_MODES)[number];
export const INVOICE_TAX_MODE_LABELS: Record<InvoiceTaxMode, string> = { WITH_GST: 'With GST', WITHOUT_GST: 'Without GST' };

/**
 * How a bill's discount was entered.
 *
 * A discount is a BILL-level concession, never a per-line one, and it is stored as the pair
 * the operator actually chose rather than as one ambiguous number: NONE means there is no
 * discount at all, AMOUNT means a rupee figure was typed, PERCENT means a percentage of the
 * bill's sub total was. The money it works out to is the server's (`discountAmount`), and it
 * reduces the taxable value BEFORE GST — see `billing.ts`.
 */
export const BILL_DISCOUNT_TYPES = ['NONE', 'AMOUNT', 'PERCENT'] as const;
export type BillDiscountType = (typeof BILL_DISCOUNT_TYPES)[number];
export const BILL_DISCOUNT_TYPE_LABELS: Record<BillDiscountType, string> = { NONE: 'None', AMOUNT: 'Amount', PERCENT: 'Percent' };
/** The compact form the billing screen puts on a segmented control. */
export const BILL_DISCOUNT_TYPE_SHORT: Record<BillDiscountType, string> = { NONE: 'None', AMOUNT: '₹', PERCENT: '%' };

/**
 * Invoice templates (docs/INVOICE_TEMPLATES.md). A template controls PRESENTATION only —
 * nothing here can change a figure on a bill.
 *
 * `supportedMode` says which bills a template may render: BOTH, or only one tax mode.
 */
export const INVOICE_TEMPLATE_MODES = ['BOTH', 'WITH_GST', 'WITHOUT_GST'] as const;
export type InvoiceTemplateMode = (typeof INVOICE_TEMPLATE_MODES)[number];
export const INVOICE_TEMPLATE_MODE_LABELS: Record<InvoiceTemplateMode, string> = { BOTH: 'With & without GST', WITH_GST: 'With GST only', WITHOUT_GST: 'Without GST only' };

/** The controlled visual styles. Each is a fixed set of typography/border rules, not free CSS. */
export const INVOICE_LAYOUT_PRESETS = ['CLASSIC', 'COMPACT', 'DETAILED'] as const;
export type InvoiceLayoutPreset = (typeof INVOICE_LAYOUT_PRESETS)[number];
export const INVOICE_LAYOUT_PRESET_LABELS: Record<InvoiceLayoutPreset, string> = { CLASSIC: 'Classic', COMPACT: 'Compact', DETAILED: 'Detailed' };

/**
 * The item-table columns an invoice can print, all read from the bill line's own snapshot.
 * `amount` is Qty x Rate before the bill discount; `taxable` is the net base after it.
 */
export const INVOICE_COLUMNS = ['serial', 'item', 'product', 'hsn', 'quantity', 'rate', 'amount', 'taxable', 'gstRate', 'gstAmount', 'total', 'remark'] as const;
export type InvoiceColumn = (typeof INVOICE_COLUMNS)[number];
export const INVOICE_COLUMN_LABELS: Record<InvoiceColumn, string> = {
  serial: '#', item: 'Item', product: 'Product', hsn: 'HSN/SAC', quantity: 'Qty', rate: 'Rate', amount: 'Amount',
  taxable: 'Taxable', gstRate: 'GST %', gstAmount: 'GST', total: 'Total', remark: 'Remark',
};

export const INVOICE_ALIGNMENTS = ['LEFT', 'CENTER', 'RIGHT'] as const;
export type InvoiceAlignment = (typeof INVOICE_ALIGNMENTS)[number];
export const INVOICE_PAPER_SIZES = ['A4'] as const;
export const INVOICE_ORIENTATIONS = ['PORTRAIT'] as const;
export const INVOICE_MARGINS = ['NARROW', 'NORMAL'] as const;
export type InvoiceMargin = (typeof INVOICE_MARGINS)[number];
export const INVOICE_DENSITIES = ['COMPACT', 'NORMAL'] as const;
export type InvoiceDensity = (typeof INVOICE_DENSITIES)[number];
