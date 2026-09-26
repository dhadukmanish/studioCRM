import { z } from 'zod';
import { BILL_DISCOUNT_TYPES, INVOICE_TAX_MODES, type BillDiscountType } from '../enums.js';
import { calculateBill } from '../billing.js';

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
 *  - every amount (taxable, GST, line total, the discount in money, each line's allocated
 *    share of it, and the bill's totals) — recomputed from the validated lines by the shared
 *    calculation in `billing.ts`. The client chooses the discount TYPE and VALUE; what those
 *    are worth is never its answer.
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

/**
 * Runaway-payload guard on the discount the operator types. It is deliberately loose, because
 * the REAL bound is a business one and is checked against the bill itself further down: an
 * AMOUNT may not exceed the bill's sub total, and a PERCENT may not exceed 100. This value is
 * only the point past which no bill could ever need one — every line of a full bill at both
 * ceilings above — and it keeps a nonsense number out of `numeric(16, 2)`.
 */
export const BILL_DISCOUNT_MAX = 999999999999.99;

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

/* ------------------------------------------------------------------- mobile -- */

/** A bill's customer mobile is exactly this many digits — nothing else. */
export const BILL_MOBILE_DIGITS = 10;

/**
 * What the mobile input keeps while the operator types or pastes: digits only, at most ten.
 * A pasted number carrying the Indian country code (`+91 98765 43210`, 12 digits) or a trunk
 * zero (`098765 43210`, 11 digits) loses that prefix instead of its last digit; anything else
 * keeps its first ten digits, so a letter or an extra keystroke can never stay in the field.
 * The server does not rely on this — `billMobileSchema` refuses anything but exactly ten digits.
 */
export function sanitizeMobileInput(raw: string): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits.slice(0, BILL_MOBILE_DIGITS);
}

/**
 * The server's rule: exactly ten digits, no spaces, prefixes or letters. Stored as text (a
 * leading digit pattern is data, not a number). Surrounding whitespace is trimmed first.
 */
/** The pre-ten-digit rule, kept only for re-saving a legacy bill (see `billUpdateSchema`). */
export const legacyBillMobileSchema = z
  .string({ required_error: 'Mobile no. is required', invalid_type_error: 'Mobile no. is required' })
  .trim()
  .min(1, 'Mobile no. is required')
  .max(BILL_LIMITS.mobileNumber, `Mobile no. cannot exceed ${BILL_LIMITS.mobileNumber} characters`)
  .refine((v) => /\d/.test(v), 'Enter a valid mobile no.');

export const billMobileSchema = z
  .string({ required_error: 'Mobile no. is required', invalid_type_error: 'Mobile no. is required' })
  .trim()
  .min(1, 'Mobile no. is required')
  .regex(/^\d+$/, 'Mobile no. can contain digits only')
  .length(BILL_MOBILE_DIGITS, `Mobile no. must be exactly ${BILL_MOBILE_DIGITS} digits`);

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
  mobileNumber: billMobileSchema,
  babyName: optionalText('Baby name', BILL_LIMITS.babyName),
  /** The legacy form's Birthdate checkbox: the date input only exists while this is ticked. */
  hasBirthDate: z.boolean().default(false),
  birthDate: optionalDate('Birth date'),
  remark: optionalText('Remark', BILL_LIMITS.remark),
  /**
   * The customer's next visit, chosen by the operator (never calculated). When set, saving the
   * bill creates — or moves — exactly one linked appointment for that date, in the same
   * transaction (`services/nextVisit.ts`). Optional.
   */
  nextVisitDate: optionalDate('Next visit date'),
  /**
   * DECIDED BY THE BOOK, not by the client. A new bill's tax mode is its book's series type and an
   * edit keeps the bill's saved one, so this field is optional: when a client does send it, the
   * server refuses a value that contradicts the book (or, on edit, the saved bill). Nothing ever
   * picks a tax mode from here.
   */
  taxMode: z.enum(INVOICE_TAX_MODES, { errorMap: () => ({ message: 'Select a valid tax mode' }) }).optional(),
  /**
   * The bill-level discount, as the pair the operator actually chose. NONE / AMOUNT / PERCENT
   * rather than one overloaded number, so "100" can never be read as 100% on one screen and
   * ₹100 on another. What it is worth in money is the server's — see `discountRule` below and
   * `billing.ts`. There is deliberately no per-LINE discount field: a line's share of this one
   * is allocated by the calculation, never typed.
   */
  discountType: z.enum(BILL_DISCOUNT_TYPES, { errorMap: () => ({ message: 'Select a valid discount type' }) }).default('NONE'),
  /**
   * Rupees when the type is AMOUNT, a percentage when it is PERCENT, 0 when it is NONE.
   * A missing or cleared field is no discount rather than an error — unlike a line's rate,
   * an empty discount box has an obvious and harmless meaning.
   */
  discountValue: z.preprocess((v) => (isBlank(v) ? 0 : v), decimal2('Discount', { min: 0, max: BILL_DISCOUNT_MAX })),
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

/**
 * The discount, checked against the bill it is being given on.
 *
 * NONE is normalised rather than refused: the type IS the statement that there is no
 * discount, so a value left behind by an earlier edit is dropped exactly as an unticked
 * birthdate drops its date. The two real limits are refused with a field message and never
 * silently clamped — 101% does not become 100%, and ₹5,000 off a ₹3,000 bill does not become
 * ₹3,000. The sub total is the bill's own GROSS taxable value, taken from the one shared
 * calculation so this rule can never drift from what the server would charge.
 */
const discountRule = (v: { discountType: BillDiscountType; discountValue: number; items: BillItemInput[] }, ctx: z.RefinementCtx) => {
  if (v.discountType === 'NONE') {
    v.discountValue = 0;
    return;
  }
  const message = billDiscountError({ type: v.discountType, value: v.discountValue }, billSubTotal(v.items));
  if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['discountValue'], message });
};

/**
 * A bill's GROSS taxable value — the base a discount is measured against. Taken from the one
 * shared calculation (with the tax mode that charges nothing, because tax is irrelevant to a
 * sub total) so this rule can never drift from what the server will actually charge.
 */
export const billSubTotal = (items: { quantity: number; rate: number }[]) =>
  calculateBill(
    items.map((l) => ({ quantity: l.quantity, rate: l.rate, gstRate: 0 })),
    'WITHOUT_GST',
  ).totals.subTotal;

/**
 * Why a discount is not acceptable on a bill of this size, or null when it is.
 *
 * Exported because the billing screen shows the same message live, as the operator types,
 * instead of keeping its own copy of the rule — a validation rule that exists twice is a bug
 * waiting for the two copies to disagree. The API's refusal and the form's warning are this
 * one function.
 */
export function billDiscountError(discount: { type: BillDiscountType; value: number }, subTotal: number): string | null {
  if (discount.type === 'NONE') return null;
  if (discount.value < 0) return 'Discount cannot be negative';
  if (discount.type === 'PERCENT') return discount.value > 100 ? 'Discount cannot be more than 100%' : null;
  return discount.value > subTotal ? `Discount cannot be more than the sub total (${subTotal.toFixed(2)})` : null;
}

/**
 * A next visit is a FUTURE booking relative to the bill: a date before the bill date is a typo,
 * refused on the field rather than turned into an appointment in the past.
 */
const nextVisitRule = (v: { billDate: string; nextVisitDate: string | null }, ctx: z.RefinementCtx) => {
  if (v.nextVisitDate && v.billDate && v.nextVisitDate < v.billDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nextVisitDate'], message: 'Next visit date cannot be before the bill date' });
  }
};

/** Create: the whole document in one payload, book included. */
export const billSchema = billBaseSchema.superRefine((v, ctx) => {
  birthDateRule(v, ctx);
  discountRule(v, ctx);
  nextVisitRule(v, ctx);
});
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
export const billUpdateSchema = billBaseSchema
  .omit({ bookId: true })
  /**
   * An edit may carry a bill's LEGACY mobile — one saved before the ten-digit rule, as typed
   * ("+91 98765 43210", a 9-digit number). The shape is checked loosely here; `updateBill` then
   * insists on exactly ten digits unless the bill keeps its own customer key unchanged, so a legacy
   * bill (even one with receipts) stays editable while any real change of mobile is ten digits.
   */
  .extend({ mobileNumber: legacyBillMobileSchema })
  .superRefine((v, ctx) => {
  birthDateRule(v, ctx);
  discountRule(v, ctx);
  nextVisitRule(v, ctx);
});
export type BillUpdateInput = z.infer<typeof billUpdateSchema>;
