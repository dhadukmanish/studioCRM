import type { InvoiceTaxMode } from '@erp/shared';

/**
 * The Billing screens' view of the API contract (`apps/api/src/routes/bills.ts` +
 * `services/bills.ts`). Declared once here so the list, the form and the grid cannot drift
 * from each other — and deliberately narrow: only the fields these screens render.
 *
 * Every amount is a number the SERVER derived. Nothing on this side ever posts one back.
 */
export interface BillRow {
  id: string;
  bookId: string;
  /** Joined from Book Master by the list endpoint — searchable, sortable and filterable. */
  bookNumber: string;
  billNumber: number;
  appointmentId: string | null;
  /** "YYYY-MM-DD" calendar dates — rendered with `fmtDateOnly`, never parsed into a Date. */
  billDate: string;
  deliveryDate: string | null;
  customerName: string;
  mobileNumber: string;
  babyName: string | null;
  hasBirthDate: boolean;
  birthDate: string | null;
  remark: string | null;
  taxMode: InvoiceTaxMode;
  subTotal: number;
  gstAmount: number;
  grandTotal: number;
  createdAt: string;
  updatedAt: string;
}

/** One saved line. The snapshots are the server's copy of the masters at the time of saving. */
export interface BillItemRow {
  id: string;
  lineNumber: number;
  itemId: string;
  subItemId: string;
  itemNameSnapshot: string;
  subItemNameSnapshot: string;
  hsnCodeSnapshot: string;
  gstRateSnapshot: number;
  quantity: number;
  rate: number;
  taxableAmount: number;
  gstAmount: number;
  lineTotal: number;
  remark: string | null;
}

/** `GET /api/bills/:id` — the bill, its book, its booking's number and its lines in print order. */
export interface BillRecord extends BillRow {
  appointmentNumber: number | null;
  items: BillItemRow[];
}

/**
 * One line as the FORM holds it.
 *
 * Quantity and rate stay strings while the operator types: a number field cannot express
 * "cleared", and 0 is a real quantity the shared schema rejects for a good reason. The shared
 * zod schema coerces "2.5" itself, so what is typed is what is posted.
 *
 * `gstRate` is display and preview only — read from Item Master through the lookup. It is
 * stripped before the payload is built, because a line's GST rate is the server's snapshot.
 */
export interface BillLineFormValues {
  itemId: string;
  subItemId: string;
  /**
   * The names this line was SAVED with. They exist so a line whose item or product has since
   * been deactivated still reads as a name: the lookups offer active rows only, and a
   * Combobox with no matching option falls back to showing the raw id. Display only — they
   * are never posted, and the server holds the authoritative snapshot.
   */
  itemName?: string;
  productName?: string;
  gstRate: number | null;
  quantity: string;
  rate: string;
  remark: string;
}

/** The whole bill as the form holds it. Bill number, snapshots and amounts are absent by design. */
export interface BillFormValues {
  bookId: string;
  appointmentId: string;
  billDate: string;
  deliveryDate: string;
  customerName: string;
  mobileNumber: string;
  babyName: string;
  hasBirthDate: boolean;
  birthDate: string;
  remark: string;
  taxMode: InvoiceTaxMode;
  items: BillLineFormValues[];
}

export const emptyLine = (): BillLineFormValues => ({ itemId: '', subItemId: '', itemName: '', productName: '', gstRate: null, quantity: '', rate: '', remark: '' });
