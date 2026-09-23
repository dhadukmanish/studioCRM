import type { BillDiscountType, InvoiceTaxMode } from './enums.js';

/**
 * Bill calculation — the ONE place a bill's money is worked out.
 *
 * Both apps import it: the browser calls it to preview the bill while the operator types, the
 * API calls it inside the create/update transaction to decide what is actually stored. A
 * total sent by a client is never trusted — it is recomputed here from validated quantities,
 * rates, the GST rate snapshotted off Item Master and the discount the operator chose.
 *
 * ## The rate is GST-EXCLUSIVE — confirmed business rule
 *
 * Qty x Rate is the taxable value and GST is added on top of it. Rate 1000 at 18% bills 1000
 * taxable, 180 GST, 1180 total. This was an open assumption in Phase 1 and the studio has
 * since CONFIRMED it; it is no longer a guess to be revisited. See
 * `docs/BILLING_CALCULATION.md`.
 *
 * ## Calculation order
 *
 *     Gross Taxable  ->  Discount  ->  Net Taxable  ->  GST  ->  Grand Total
 *
 * The bill-level discount reduces the taxable base BEFORE tax is worked out — never after.
 * A bill may mix GST slabs, so the discount is ALLOCATED across the lines first (see
 * `allocateDiscount`) and each line is then taxed at its own snapshot rate on what is left of
 * it. Taking the tax on the undiscounted lines and subtracting the discount at the bottom
 * would make the rate-wise GST summary arithmetically false, which is why it is not done.
 *
 * ## Rounding
 *
 * Money is rounded to 2 decimals per LINE, half-up, and the bill totals are the sums of the
 * already-rounded lines — so what the invoice prints per line always adds up to what it
 * prints at the bottom. Every intermediate step is integer arithmetic (paise, and hundredths
 * of a percent), never a float, so 0.1 + 0.2 problems cannot reach a stored amount. The
 * allocation of a discount across lines distributes its rounding remainder deterministically,
 * so the allocated shares sum to the bill's discount EXACTLY, to the paisa.
 *
 * Products that can leave the exact-integer range of a JS number at the ceilings in
 * `schemas/bills.ts` (the allocation, and tax on a fully-taxed line) are done in `bigint` and
 * converted back only once the result is a paise figure again. The rest stays in `number`,
 * where every product provably stays below 2^53.
 */

/** Quantities and rates carry at most 2 decimals; a GST or discount percentage at most 2. */
const SCALE = 100;

/** A number at the scale the columns store, as an exact integer of hundredths. */
const hundredths = (n: number) => Math.round(n * SCALE);

/** Integer hundredths back to a 2-decimal number. */
const fromHundredths = (n: number) => n / SCALE;

/** Half-up on a non-negative rational — `Math.round` is half-up, and nothing here is negative. */
const divRound = (numerator: number, denominator: number) => Math.round(numerator / denominator);

/**
 * The same half-up division on `bigint`, for the products that can pass 2^53 at the schemas'
 * ceilings. `(2n + d) / 2d` floored IS half-up while both are non-negative, which everything
 * in this module is. The result is a paise figure, so it is exact as a `number` again.
 */
const divRoundBig = (numerator: bigint, denominator: bigint) => Number((2n * numerator + denominator) / (2n * denominator));

export interface BillLineValues {
  /** Units billed. Positive, at most 2 decimals. */
  quantity: number;
  /** Price per unit as the bill stores it, GST-exclusive — the Sub Item's rate is only its default. */
  rate: number;
  /** The GST % snapshotted from Item Master when the line was created. */
  gstRate: number;
}

/** The discount as the OPERATOR entered it. What it is worth in money is this module's answer. */
export interface BillDiscountValues {
  type: BillDiscountType;
  /** Rupees when the type is AMOUNT, a percentage when it is PERCENT, 0 when it is NONE. */
  value: number;
}

/** No discount — the default, and what every Phase 1 bill carries. */
export const NO_DISCOUNT: BillDiscountValues = { type: 'NONE', value: 0 };

export interface BillLineAmounts {
  /** Qty x Rate, rounded to 2 decimals. The line's taxable value BEFORE the bill's discount. */
  grossTaxable: number;
  /** This line's share of the bill-level discount. Never entered per line — see `allocateDiscount`. */
  discountAllocated: number;
  /** grossTaxable - discountAllocated: the base GST is actually charged on. */
  taxableAmount: number;
  /** Tax charged on this line. Always 0 in a WITHOUT_GST bill. */
  gstAmount: number;
  /** taxableAmount + gstAmount. */
  lineTotal: number;
}

export interface BillTotals {
  /** Sum of the lines' GROSS taxable values — before the discount, before GST. */
  subTotal: number;
  /** The discount in money. Exactly the sum of the lines' allocated shares. */
  discountAmount: number;
  /** subTotal - discountAmount, and equally the sum of the lines' net taxable values. */
  netTaxable: number;
  /** Sum of the lines' GST. 0 for a WITHOUT_GST bill. */
  gstAmount: number;
  /** netTaxable + gstAmount. */
  grandTotal: number;
}

/** One row of the rate-wise GST summary an invoice prints under its totals. */
export interface GstSummaryRow {
  /** The snapshot rate the lines in this group carry. */
  gstRate: number;
  /** Net taxable in this group — AFTER the allocated discount. */
  taxableAmount: number;
  /** GST charged on this group. 0 throughout a WITHOUT_GST bill. */
  gstAmount: number;
}

/**
 * One line's money, given the share of the bill discount that was allocated to it.
 *
 * WITHOUT_GST charges no tax: `gstAmount` is 0 and the line total is the net taxable value
 * alone. The line still KEEPS its `gstRate` snapshot — that is the Item Master rate the line
 * was built from, and losing it would make the same bill impossible to re-read later or to
 * convert to a GST invoice if the business asks for one. Nothing about the tax mode edits
 * Item Master, and a retained snapshot is not a claim that tax was charged.
 */
export function lineAmounts(line: BillLineValues, mode: InvoiceTaxMode, discountAllocated = 0): BillLineAmounts {
  // Qty and rate are both hundredths, so their product is ten-thousandths; round it back to
  // paise in one step rather than rounding twice.
  const grossPaise = divRound(hundredths(line.quantity) * hundredths(line.rate), SCALE);
  // Clamped, so a caller that hands this function a nonsense share still cannot produce a
  // negative taxable value. `calculateBill` never needs the clamp — its allocation is capped.
  const discountPaise = Math.min(Math.max(hundredths(discountAllocated), 0), grossPaise);
  const netPaise = grossPaise - discountPaise;
  const gstPaise = mode === 'WITH_GST' ? divRoundBig(BigInt(netPaise) * BigInt(hundredths(line.gstRate)), BigInt(100 * SCALE)) : 0;
  return {
    grossTaxable: fromHundredths(grossPaise),
    discountAllocated: fromHundredths(discountPaise),
    taxableAmount: fromHundredths(netPaise),
    gstAmount: fromHundredths(gstPaise),
    lineTotal: fromHundredths(netPaise + gstPaise),
  };
}

/**
 * What the discount is worth in money, in paise.
 *
 * AMOUNT is what was typed; PERCENT is that percentage of the bill's gross sub total,
 * rounded half-up. Both are capped at the sub total, and a bill with nothing to discount
 * (every line at rate 0) discounts nothing rather than dividing by zero. The cap is a
 * SAFETY NET, not the business rule: `billSchema` refuses an amount above the sub total and a
 * percentage above 100 with a field error, rather than silently shrinking either.
 */
function discountPaiseOf(subTotalPaise: number, discount: BillDiscountValues): number {
  if (discount.type === 'NONE' || !(discount.value > 0) || subTotalPaise <= 0) return 0;
  if (discount.type === 'AMOUNT') return Math.min(hundredths(discount.value), subTotalPaise);
  const percent = Math.min(hundredths(discount.value), 100 * SCALE);
  return Math.min(divRoundBig(BigInt(subTotalPaise) * BigInt(percent), BigInt(100 * SCALE)), subTotalPaise);
}

/**
 * Spread a bill-level discount across its lines — the canonical algorithm, in integer paise.
 *
 * Largest remainder (Hamilton). Each line's exact share is `discount x gross / subTotal`; the
 * floor of it is allocated first, and the paise left over by those floors go one each to the
 * lines with the largest dropped fraction. Ties go to the larger line, then to the earlier
 * one, so the same bill always allocates identically — the result is data, not a side effect
 * of iteration order.
 *
 * Two properties this guarantees, and which the tests pin:
 *
 *  - `sum(allocations) === discount`, exactly. The floors lose exactly the leftover paise and
 *    the leftover paise are all handed back out — never 99.99 of a 100.00 discount.
 *  - no line is allocated more than it is worth, so no net taxable value can go negative.
 *    (When `discount < subTotal`, every positive line's floor is strictly below its gross, so
 *    the +1 always fits; when they are equal there is no remainder to hand out at all.)
 *
 * Lines with nothing on them (rate 0) take no remainder paise — a zero-value line cannot
 * absorb a discount.
 */
function allocateDiscount(grossPaise: number[], discountPaise: number): number[] {
  const allocated = grossPaise.map(() => 0);
  const subTotal = grossPaise.reduce((t, g) => t + g, 0);
  if (discountPaise <= 0 || subTotal <= 0) return allocated;

  const capped = Math.min(discountPaise, subTotal);
  // bigint: at the schemas' ceilings `discount x gross` is far past 2^53, and the whole point
  // of this function is that its arithmetic is exact.
  const discount = BigInt(capped);
  const total = BigInt(subTotal);
  const remainders: { index: number; remainder: bigint }[] = [];
  let assigned = 0;

  grossPaise.forEach((gross, index) => {
    const share = discount * BigInt(gross);
    const base = Number(share / total);
    allocated[index] = base;
    assigned += base;
    if (gross > 0) remainders.push({ index, remainder: share % total });
  });

  remainders.sort((a, b) =>
    a.remainder === b.remainder ? grossPaise[b.index] - grossPaise[a.index] || a.index - b.index : a.remainder < b.remainder ? 1 : -1,
  );

  let leftover = capped - assigned;
  for (const { index } of remainders) {
    if (leftover <= 0) break;
    if (allocated[index] >= grossPaise[index]) continue;
    allocated[index] += 1;
    leftover -= 1;
  }
  return allocated;
}

/**
 * The bill's totals — the sums of lines that were already rounded, so the printed lines and
 * the printed total can never disagree by a paisa.
 *
 * Advance, paid and outstanding are deliberately absent: nothing establishes them yet, and a
 * zero-valued field that no rule maintains is worse than no field.
 */
export function billTotals(lines: BillLineAmounts[]): BillTotals {
  let gross = 0;
  let discount = 0;
  let net = 0;
  let gst = 0;
  for (const l of lines) {
    gross += hundredths(l.grossTaxable);
    discount += hundredths(l.discountAllocated);
    net += hundredths(l.taxableAmount);
    gst += hundredths(l.gstAmount);
  }
  return {
    subTotal: fromHundredths(gross),
    discountAmount: fromHundredths(discount),
    netTaxable: fromHundredths(net),
    gstAmount: fromHundredths(gst),
    grandTotal: fromHundredths(net + gst),
  };
}

/**
 * The rate-wise GST summary, grouped off the lines' OWN calculated amounts.
 *
 * Deliberately a sum of what the lines already say rather than a second calculation from
 * quantities and rates: a summary that could disagree with the lines above it would be worse
 * than none. The taxable figure here is therefore the NET one, after the allocated discount.
 *
 * A 0% group is kept — its taxable value is part of the bill whether or not a template
 * chooses to print the row. Sorted by rate so the summary reads the same on every bill.
 */
export function gstSummary(lines: { gstRate: number; taxableAmount: number; gstAmount: number }[]): GstSummaryRow[] {
  const groups = new Map<number, { taxable: number; gst: number }>();
  for (const l of lines) {
    const group = groups.get(l.gstRate) ?? { taxable: 0, gst: 0 };
    group.taxable += hundredths(l.taxableAmount);
    group.gst += hundredths(l.gstAmount);
    groups.set(l.gstRate, group);
  }
  return Array.from(groups.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([gstRate, g]) => ({ gstRate, taxableAmount: fromHundredths(g.taxable), gstAmount: fromHundredths(g.gst) }));
}

/**
 * Calculate every line, the bill's totals and its rate-wise GST summary in one pass — what
 * the API stores, and what the form previews. The discount is optional: a bill without one
 * calculates exactly as it did in Phase 1.
 */
export function calculateBill(
  lines: BillLineValues[],
  mode: InvoiceTaxMode,
  discount: BillDiscountValues = NO_DISCOUNT,
): { lines: BillLineAmounts[]; totals: BillTotals; gstSummary: GstSummaryRow[] } {
  const grossPaise = lines.map((l) => divRound(hundredths(l.quantity) * hundredths(l.rate), SCALE));
  const subTotalPaise = grossPaise.reduce((t, g) => t + g, 0);
  const allocated = allocateDiscount(grossPaise, discountPaiseOf(subTotalPaise, discount));
  const amounts = lines.map((l, i) => lineAmounts(l, mode, fromHundredths(allocated[i])));
  return {
    lines: amounts,
    totals: billTotals(amounts),
    gstSummary: gstSummary(amounts.map((a, i) => ({ gstRate: lines[i].gstRate, taxableAmount: a.taxableAmount, gstAmount: a.gstAmount }))),
  };
}
