import { z } from 'zod';
import { INVOICE_TAX_MODES } from '../enums.js';

/**
 * Bill — the studio's invoice document: a header, its customer snapshot and at least one line.
 *
 * What a client may send is deliberately small. It sends IDENTIFIERS (book, optional
 * appointment, item, sub item) and the values the operator actually typed (dates, customer
 * fields, quantity, rate, remarks). Everything else is the server's:
 *
 *  - `billNumber` — issued by `allocateBillNumber` inside the create transaction.
 *  - `mobileSearch` — derived from the typed mobile by `normalizeMobile`.
 *  - every line snapshot (item name, product name, HSN, GST %) — read from Item / Sub Item
 *    Master by the server, never accepted from a payload.
 *  - every amount (taxable, GST, line total, and the bill's totals) — recomputed from the
 *    validated lines by the shared calculation in `billing.ts`.
 *
 * None of those fields exist in this schema, and zod strips unknown keys, so a payload that
 * carries them loses them before any route code runs.
 */

/** Single source of truth for the field limits — the form reuses these, never its own literals. */
export const BILL_LIMITS = {
  customerName: 120,
  /** Generous on purpose: a stored number may carry a country prefix, spaces or dashes. */
  mobileNumber: 30,
  babyName: 120,
  remark: 500,
  lineRemark: 500,
  /** More lines than any studio bill has ever had; a guard against a runaway payload. */
  maxLines: 100,
} as const;

/**
 * Ceilings for a line's quantity and rate. Both are far past anything a studio bills, and they
 * are deliberately not the columns' own maxima: every payload these schemas accept has to stay
 * inside the amount columns (a full 100-line bill at both ceilings, plus 28% GST, still fits
 * `numeric(16, 2)`) and inside exact integer arithmetic in `billing.ts` (every product stays
 * below 2^53, so no rounding can drift). Raising either one means checking both again.
 */
export const BILL_QUANTITY_MAX = 9999.99;
export const BILL_RATE_MAX = 999999.99;

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Optional free text: trimmed, and blank is stored as NULL, never as ''. */
const optionalText = (label: string, max: number) =>
  z.preprocess((v) => (isBlank(v) ? null : v), z.string().trim().max(max, `${label} cannot exceed ${max} characters`).nullable());

/* -------------------------------------------------------------------- dates -- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date is checked by rebuilding it, so 2026-02-30 is rejected instead of silently
 * rolling over into March. Deliberately no `new Date(str)`: that parses a bare date as UTC
 * midnight, which is a different day in some timezones — a bill date must never shift.
 * Same rule as Appointment; kept here so neither module can drift from the other.
 */
function isRealDate(value: string) {
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const requiredDate = (label: string) =>
  z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .regex(DATE_RE, `Enter a valid ${label.toLowerCase()}`)
    .refine(isRealDate, `Enter a valid ${label.toLowerCase()}`);

const optionalDate = (label: string) =>
  z.preprocess(
    (v) => (isBlank(v) ? null : typeof v === 'string' ? v.trim() : v),
    z.string().regex(DATE_RE, `Enter a valid ${label.toLowerCase()}`).refine(isRealDate, `Enter a valid ${label.toLowerCase()}`).nullable(),
  );

/* ------------------------------------------------------------------ numbers -- */

/**
 * Money and quantities coerce "500.50" -> 500.5 for form posts but never coerce emptiness
 * into a number: plain `z.coerce.number()` turns '', null and [] into 0, and 0 would be a
 * silently free line. The 2-decimal refusal is deliberate too — a silently rounded rate is a
 * changed price. Same treatment Sub Item Master gives its rate.
 */
const decimal2 = (label: string, opts: { min: number; max: number; exclusiveMin?: boolean }) =>
  z.preprocess(
    (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined),
    z
      .number({ required_error: `${label} is required`, invalid_type_error: `${label} is required` })
      .finite(`${label} is required`)
      .max(opts.max, `${label} is too large`)
      .refine((n) => (opts.exclusiveMin ? n > opts.min : n >= opts.min), opts.exclusiveMin ? `${label} must be greater than ${opts.min}` : `${label} cannot be negative`)
      .refine((n) => /^\d+(\.\d{1,2})?$/.test(String(n)), `${label} can have at most 2 decimal places`),
  );

/* -------------------------------------------------------------------- lines -- */

/**
 * One bill line. The client chooses the product and types the quantity, rate and remark; the
 * server resolves the names, the HSN code and the GST rate from the masters and calculates
 * every amount.
 *
 * `subItemId` is required: the legacy grid bills a Product under an Item, and a line with no
 * product would have no rate of its own to default from. The server additionally proves the
 * sub item belongs to the chosen item — the browser is never trusted with that relationship.
 */
export const billItemSchema = z.object({
  itemId: z.string({ required_error: 'Item is required', invalid_type_error: 'Item is required' }).min(1, 'Item is required').uuid('Select a valid item'),
  subItemId: z.string({ required_error: 'Product is required', invalid_type_error: 'Product is required' }).min(1, 'Product is required').uuid('Select a valid product'),
  /** A line that bills nothing is a mistake, not a zero-quantity line, so 0 is refused. */
  quantity: decimal2('Qty', { min: 0, max: BILL_QUANTITY_MAX, exclusiveMin: true }),
  /** Defaults from the Sub Item's rate in the UI, but the bill stores whatever is saved here. */
  rate: decimal2('Rate', { min: 0, max: BILL_RATE_MAX }),
  /** Defaults from the Sub Item's remark in the UI; the line owns its own copy from then on. */
  remark: optionalText('Remark', BILL_LIMITS.lineRemark),
});
export type BillItemInput = z.infer<typeof billItemSchema>;

/* ------------------------------------------------------------------- header -- */

const billBaseSchema = z.object({
  /**
   * The Book the bill is numbered under. It decides the number series, and therefore the
   * document's identity — which is why the update schema does not have this field at all.
   */
  bookId: z.string({ required_error: 'Book is required', invalid_type_error: 'Book is required' }).min(1, 'Book is required').uuid('Select a valid book'),
  /**
   * The booking this bill came from, when there is one. Optional on purpose: a walk-in
   * customer has no appointment. It is traceability only — the customer fields below are the
   * bill's own snapshot and are never re-read from the appointment.
   */
  appointmentId: z.preprocess((v) => (isBlank(v) ? null : v), z.string().uuid('Select a valid appointment').nullable()).default(null),
  billDate: requiredDate('Bill date'),
  /** When the studio promised the work. Optional — no delivery workflow exists in this phase. */
  deliveryDate: optionalDate('Delivery date'),
  customerName: z
    .string({ required_error: 'Customer name is required', invalid_type_error: 'Customer name is required' })
    .trim()
    .min(1, 'Customer name is required')
    .max(BILL_LIMITS.customerName, `Customer name cannot exceed ${BILL_LIMITS.customerName} characters`),
  /** Text, never numeric: leading zeros, a country prefix and the operator's spacing all matter. */
  mobileNumber: z
    .string({ required_error: 'Mobile no. is required', invalid_type_error: 'Mobile no. is required' })
    .trim()
    .min(1, 'Mobile no. is required')
    .max(BILL_LIMITS.mobileNumber, `Mobile no. cannot exceed ${BILL_LIMITS.mobileNumber} characters`)
    .refine((v) => /\d/.test(v), 'Enter a valid mobile no.'),
  babyName: optionalText('Baby name', BILL_LIMITS.babyName),
  /** The legacy form's Birthdate checkbox: the date input only exists while this is ticked. */
  hasBirthDate: z.boolean().default(false),
  birthDate: optionalDate('Birth date'),
  remark: optionalText('Remark', BILL_LIMITS.remark),
  taxMode: z.enum(INVOICE_TAX_MODES, { errorMap: () => ({ message: 'Select a valid tax mode' }) }).default('WITH_GST'),
  /**
   * The bill's lines, in the order they will print. At least one: a saved bill with nothing
   * on it is not a document. There is deliberately no Draft status in this phase — its
   * lifecycle is not defined, and inventing one would be inventing business rules.
   */
  items: z.array(billItemSchema).min(1, 'Add at least one item').max(BILL_LIMITS.maxLines, `A bill cannot have more than ${BILL_LIMITS.maxLines} items`),
});

/**
 * The checkbox and the date are one field pair: unticked means the bill holds no birth date
 * at all (never a stale one left behind by an earlier edit), ticked means the date is the
 * point and must be there.
 */
const birthDateRule = (v: { hasBirthDate: boolean; birthDate: string | null }, ctx: z.RefinementCtx) => {
  if (v.hasBirthDate && !v.birthDate) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['birthDate'], message: 'Birth date is required' });
  // Unticking is not an error — the date is simply dropped, which is what the column stores.
  if (!v.hasBirthDate && v.birthDate) v.birthDate = null;
};

/** Create: the whole document in one payload, book included. */
export const billSchema = billBaseSchema.superRefine(birthDateRule);
export type BillInput = z.infer<typeof billSchema>;

/**
 * Update: the same document without its identity. The Book and the bill number are fixed at
 * creation — changing the book would move the bill into another number series and make it a
 * different document — so the field is absent here rather than merely ignored.
 *
 * An update carries the FULL header and the FULL line set: the lines are replaced as a set
 * inside one transaction, which is what keeps line numbering deterministic and the stored
 * totals honest. No update ever allocates a bill number.
 */
export const billUpdateSchema = billBaseSchema.omit({ bookId: true }).superRefine(birthDateRule);
export type BillUpdateInput = z.infer<typeof billUpdateSchema>;
