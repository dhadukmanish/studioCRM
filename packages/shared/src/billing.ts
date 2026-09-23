import type { InvoiceTaxMode } from './enums.js';

/**
 * Bill calculation — the ONE place a bill's money is worked out.
 *
 * Both apps import it: the browser calls it to preview a line while the operator types, the
 * API calls it inside the create/update transaction to decide what is actually stored. A
 * total sent by a client is never trusted — it is recomputed here from validated quantities,
 * rates and the GST rate snapshotted off Item Master.
 *
 * ## Calculation policy (Phase 1)
 *
 * **The rate is tax-EXCLUSIVE.** Qty x Rate is the taxable value and GST is added on top.
 * The legacy billing screens supplied with the requirement are scanned images with no text
 * layer, so it could not be established from them whether the studio's rate was ever entered
 * tax-inclusive; nothing else in the repository establishes it either. Exclusive is the
 * assumption, it is isolated in `lineAmounts` below, and it is written down in
 * `docs/BILL_NUMBERING.md` so a later phase can change one function if the business says
 * otherwise. Existing bills would have to be recalculated if it does change.
 *
 * ## Rounding
 *
 * Money is rounded to 2 decimals per LINE, half-up, and the bill totals are the sums of the
 * already-rounded lines — so what the invoice prints per line always adds up to what it
 * prints at the bottom. Every intermediate step is integer arithmetic (paise, and hundredths
 * of a percent), never a float, so 0.1 + 0.2 problems cannot reach a stored amount.
 *
 * That exactness depends on the ceilings in `schemas/bills.ts`: at `BILL_QUANTITY_MAX` x
 * `BILL_RATE_MAX` with the highest GST slab, every product here stays below 2^53, where
 * integer arithmetic in a JS number is still exact. Raising either ceiling means checking
 * that again — see the note on those constants.
 */

/** Quantities and rates carry at most 2 decimals; a GST rate at most 2. Both are validated upstream. */
const SCALE = 100;

/** A number at the scale the columns store, as an exact integer of hundredths. */
const hundredths = (n: number) => Math.round(n * SCALE);

/** Integer hundredths back to a 2-decimal number. */
const fromHundredths = (n: number) => n / SCALE;

/** Half-up on a non-negative rational — `Math.round` is half-up, and nothing here is negative. */
const divRound = (numerator: number, denominator: number) => Math.round(numerator / denominator);

export interface BillLineValues {
  /** Units billed. Positive, at most 2 decimals. */
  quantity: number;
  /** Price per unit as the bill stores it — the Sub Item's rate is only its default. */
  rate: number;
  /** The GST % snapshotted from Item Master when the line was created. */
  gstRate: number;
}

export interface BillLineAmounts {
  /** Qty x Rate, rounded to 2 decimals. */
  taxableAmount: number;
  /** Tax charged on this line. Always 0 in a WITHOUT_GST bill. */
  gstAmount: number;
  /** taxableAmount + gstAmount. */
  lineTotal: number;
}

export interface BillTotals {
  /** Sum of the lines' taxable amounts. */
  subTotal: number;
  /** Sum of the lines' GST. 0 for a WITHOUT_GST bill. */
  gstAmount: number;
  /** subTotal + gstAmount. */
  grandTotal: number;
}

/**
 * One line's money.
 *
 * WITHOUT_GST charges no tax: `gstAmount` is 0 and the line total is the taxable value alone.
 * The line still KEEPS its `gstRate` snapshot — that is the Item Master rate the line was
 * built from, and losing it would make the same bill impossible to re-read later or to convert
 * to a GST invoice if the business asks for one. Nothing about the tax mode edits Item Master.
 */
export function lineAmounts(line: BillLineValues, mode: InvoiceTaxMode): BillLineAmounts {
  // Qty and rate are both hundredths, so their product is ten-thousandths; round it back to
  // paise in one step rather than rounding twice.
  const taxablePaise = divRound(hundredths(line.quantity) * hundredths(line.rate), SCALE);
  const gstPaise = mode === 'WITH_GST' ? divRound(taxablePaise * hundredths(line.gstRate), 100 * SCALE) : 0;
  return {
    taxableAmount: fromHundredths(taxablePaise),
    gstAmount: fromHundredths(gstPaise),
    lineTotal: fromHundredths(taxablePaise + gstPaise),
  };
}

/**
 * The bill's totals — the sums of lines that were already rounded, so the printed lines and
 * the printed total can never disagree by a paisa.
 *
 * Discount, advance, paid and outstanding are deliberately absent: nothing in this phase
 * establishes them, and a zero-valued field that no rule maintains is worse than no field.
 */
export function billTotals(lines: BillLineAmounts[]): BillTotals {
  let taxable = 0;
  let gst = 0;
  for (const l of lines) {
    taxable += hundredths(l.taxableAmount);
    gst += hundredths(l.gstAmount);
  }
  return { subTotal: fromHundredths(taxable), gstAmount: fromHundredths(gst), grandTotal: fromHundredths(taxable + gst) };
}

/** Calculate every line and the bill's totals in one pass — what the API stores, and what the form previews. */
export function calculateBill(lines: BillLineValues[], mode: InvoiceTaxMode): { lines: BillLineAmounts[]; totals: BillTotals } {
  const amounts = lines.map((l) => lineAmounts(l, mode));
  return { lines: amounts, totals: billTotals(amounts) };
}
