import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  BILL_LIMITS,
  BILL_MOBILE_DIGITS,
  BILL_QUANTITY_MAX,
  BILL_RATE_MAX,
  billItemSchema,
  billSchema,
  billTotals,
  billUpdateSchema,
  calculateBill,
  gstSummary,
  lineAmounts,
  normalizeMobile,
  sanitizeMobileInput,
} from '@erp/shared';

/**
 * Billing — the studio's invoice document: what a client may send, what the money works out
 * to, and what the server refuses to take from the browser.
 *
 * Section A is pure — the payload schema and the shared calculation, no database, always runs.
 * The money lives here: every amount a bill stores comes out of `calculateBill`, so the
 * rounding policy (per line, half-up, totals as sums of already-rounded lines) is pinned with
 * exact values rather than through HTTP.
 *
 * Section B needs a database and is skipped unless TEST_DATABASE_URL is set. The bill number
 * series, the master snapshots, tenant isolation and permission enforcement can only be proved
 * against real rows.
 */

/* --------------------------------------------------------------- helpers -- */

/** Ids the schema only has to see as well-formed uuids — section B uses real ones. */
const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const SUB_ITEM_ID = '22222222-2222-4222-8222-222222222222';
const BOOK_ID = '33333333-3333-4333-8333-333333333333';
const APPOINTMENT_ID = '44444444-4444-4444-8444-444444444444';

/** Minimal valid bill line; override only what the test is about. */
const makeLine = (overrides: Record<string, unknown> = {}) => ({ itemId: ITEM_ID, subItemId: SUB_ITEM_ID, quantity: 1, rate: 100, ...overrides });

/** Minimal valid create payload — one line, no optional header field set. */
const makeBill = (overrides: Record<string, unknown> = {}) => ({
  bookId: BOOK_ID,
  billDate: '2026-09-23',
  customerName: 'Ramesh Patel',
  mobileNumber: '9876543210',
  items: [makeLine()],
  ...overrides,
});

/** The update payload is the same document without its identity. */
const makeUpdate = (overrides: Record<string, unknown> = {}) => {
  const body = makeBill(overrides) as Record<string, unknown>;
  delete body.bookId;
  return body;
};

const parseBill = (input: unknown, schema: ZodTypeAny = billSchema) => schema.parse(input);

/** The issues zod raised, flattened to `{ path, message }` — fails if the input was accepted. */
function issuesFor(input: unknown, schema: ZodTypeAny = billSchema) {
  const r = schema.safeParse(input);
  if (r.success) throw new Error(`expected validation to fail, but it accepted ${JSON.stringify(input)}`);
  return r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/* ---------------------------------------------- A1. the shared calculation -- */

describe('lineAmounts (one line of a WITH_GST bill)', () => {
  it('bills quantity x rate and adds GST on top of it', () => {
    expect(lineAmounts({ quantity: 3, rate: 250, gstRate: 18 }, 'WITH_GST')).toEqual({ grossTaxable: 750, discountAllocated: 0, taxableAmount: 750, gstAmount: 135, lineTotal: 885 });
  });

  /** The policy the whole module rests on: the typed rate is what is charged BEFORE tax. */
  it('treats the rate as tax-exclusive, so the line total is more than quantity x rate', () => {
    expect(lineAmounts({ quantity: 1, rate: 100, gstRate: 18 }, 'WITH_GST')).toEqual({ grossTaxable: 100, discountAllocated: 0, taxableAmount: 100, gstAmount: 18, lineTotal: 118 });
  });

  it('rounds the taxable value to 2 decimals', () => {
    expect(lineAmounts({ quantity: 3, rate: 33.33, gstRate: 18 }, 'WITH_GST')).toEqual({ grossTaxable: 99.99, discountAllocated: 0, taxableAmount: 99.99, gstAmount: 18, lineTotal: 117.99 });
  });

  it('rounds the GST to 2 decimals', () => {
    expect(lineAmounts({ quantity: 1, rate: 999.99, gstRate: 18 }, 'WITH_GST')).toEqual({ grossTaxable: 999.99, discountAllocated: 0, taxableAmount: 999.99, gstAmount: 180, lineTotal: 1179.99 });
  });

  /** Exactly half a paisa of tax goes up, never silently down. */
  it('rounds exactly half a paisa of GST up', () => {
    expect(lineAmounts({ quantity: 1, rate: 1, gstRate: 0.5 }, 'WITH_GST')).toEqual({ grossTaxable: 1, discountAllocated: 0, taxableAmount: 1, gstAmount: 0.01, lineTotal: 1.01 });
  });

  it('rounds exactly half a paisa of taxable value up', () => {
    expect(lineAmounts({ quantity: 0.5, rate: 0.01, gstRate: 18 }, 'WITH_GST')).toEqual({ grossTaxable: 0.01, discountAllocated: 0, taxableAmount: 0.01, gstAmount: 0, lineTotal: 0.01 });
  });

  it('bills a fractional quantity against a fractional rate', () => {
    expect(lineAmounts({ quantity: 2.5, rate: 199.99, gstRate: 12 }, 'WITH_GST')).toEqual({ grossTaxable: 499.98, discountAllocated: 0, taxableAmount: 499.98, gstAmount: 60, lineTotal: 559.98 });
  });

  /** 0.1 * 0.2 is 0.020000000000000004 in binary floating point. It must never reach an amount. */
  it('keeps binary floating-point error out of the amounts', () => {
    expect(lineAmounts({ quantity: 0.1, rate: 0.2, gstRate: 0 }, 'WITH_GST').taxableAmount).toBe(0.02);
  });

  it('charges nothing on a 0% GST item', () => {
    expect(lineAmounts({ quantity: 4, rate: 25, gstRate: 0 }, 'WITH_GST')).toEqual({ grossTaxable: 100, discountAllocated: 0, taxableAmount: 100, gstAmount: 0, lineTotal: 100 });
  });

  /** A complimentary line is a real line: it prints, it just costs nothing. */
  it('bills a zero rate as a zero line', () => {
    expect(lineAmounts({ quantity: 2, rate: 0, gstRate: 18 }, 'WITH_GST')).toEqual({ grossTaxable: 0, discountAllocated: 0, taxableAmount: 0, gstAmount: 0, lineTotal: 0 });
  });

  /**
   * The largest line the schema's limits allow — the point where the hundredths arithmetic is
   * closest to losing integer precision, computed exactly.
   */
  it('stays exact at the largest quantity and rate the limits allow', () => {
    // 9999.99 x 999999.99 = 9,999,989,900.0001 -> 9,999,989,900.00, and 18% of that is exact.
    expect(lineAmounts({ quantity: BILL_QUANTITY_MAX, rate: BILL_RATE_MAX, gstRate: 18 }, 'WITH_GST')).toEqual({
      grossTaxable: 9999989900,
      discountAllocated: 0,
      taxableAmount: 9999989900,
      gstAmount: 1799998182,
      lineTotal: 11799988082,
    });
  });
});

describe('lineAmounts (one line of a WITHOUT_GST bill)', () => {
  it('charges no tax, so the line total is the taxable value alone', () => {
    expect(lineAmounts({ quantity: 3, rate: 250, gstRate: 18 }, 'WITHOUT_GST')).toEqual({ grossTaxable: 750, discountAllocated: 0, taxableAmount: 750, gstAmount: 0, lineTotal: 750 });
  });

  it('charges no tax however high the item GST rate is', () => {
    expect(lineAmounts({ quantity: 1, rate: 100, gstRate: 28 }, 'WITHOUT_GST').gstAmount).toBe(0);
  });
});

describe('billTotals and calculateBill (the bill money)', () => {
  it('adds the lines up into the header totals', () => {
    expect(calculateBill([{ quantity: 1, rate: 100, gstRate: 18 }, { quantity: 2, rate: 50, gstRate: 18 }], 'WITH_GST').totals).toEqual({
      subTotal: 200,
      discountAmount: 0,
      netTaxable: 200,
      gstAmount: 36,
      grandTotal: 236,
    });
  });

  it('taxes each line at its own item rate when the rates differ', () => {
    const { lines, totals } = calculateBill(
      [
        { quantity: 1, rate: 100, gstRate: 18 },
        { quantity: 2, rate: 50, gstRate: 5 },
        { quantity: 1, rate: 10, gstRate: 0 },
      ],
      'WITH_GST',
    );
    expect(lines.map((l) => l.gstAmount)).toEqual([18, 5, 0]);
    expect(totals).toEqual({ subTotal: 210, discountAmount: 0, netTaxable: 210, gstAmount: 23, grandTotal: 233 });
  });

  /**
   * The total is the sum of the ALREADY ROUNDED lines, not the tax on the summed taxable
   * value: taxing 2.00 at 0.5% would give 0.01, but the invoice prints 0.01 twice, so the
   * bottom of the invoice has to say 0.02 or the document does not add up.
   */
  it('sums the rounded lines rather than re-taxing their total', () => {
    expect(calculateBill([{ quantity: 1, rate: 1, gstRate: 0.5 }, { quantity: 1, rate: 1, gstRate: 0.5 }], 'WITH_GST').totals).toEqual({
      subTotal: 2,
      discountAmount: 0,
      netTaxable: 2,
      gstAmount: 0.02,
      grandTotal: 2.02,
    });
  });

  it('makes the grand total the sum of the printed line totals', () => {
    const { lines, totals } = calculateBill([{ quantity: 3, rate: 33.33, gstRate: 18 }, { quantity: 2.5, rate: 199.99, gstRate: 12 }], 'WITH_GST');
    expect(lines.map((l) => l.lineTotal)).toEqual([117.99, 559.98]);
    expect(totals).toEqual({ subTotal: 599.97, discountAmount: 0, netTaxable: 599.97, gstAmount: 78, grandTotal: 677.97 });
  });

  it('charges a WITHOUT_GST bill no tax at all', () => {
    expect(calculateBill([{ quantity: 1, rate: 100, gstRate: 18 }, { quantity: 2, rate: 50, gstRate: 5 }], 'WITHOUT_GST').totals).toEqual({
      subTotal: 200,
      discountAmount: 0,
      netTaxable: 200,
      gstAmount: 0,
      grandTotal: 200,
    });
  });

  it('gives the same taxable value in both tax modes, so only the tax differs', () => {
    const lines = [{ quantity: 2.5, rate: 199.99, gstRate: 12 }];
    expect(calculateBill(lines, 'WITHOUT_GST').totals.subTotal).toBe(calculateBill(lines, 'WITH_GST').totals.subTotal);
  });

  it('adds ten already-rounded lines without drifting a paisa', () => {
    expect(billTotals(Array.from({ length: 10 }, () => ({ grossTaxable: 0.07, discountAllocated: 0, taxableAmount: 0.07, gstAmount: 0.01, lineTotal: 0.08 })))).toEqual({
      subTotal: 0.7,
      discountAmount: 0,
      netTaxable: 0.7,
      gstAmount: 0.1,
      grandTotal: 0.8,
    });
  });
});

/* --------------------------------------- A1b. the bill-level discount math -- */

/**
 * The discount, and the property the whole model rests on: it comes off the TAXABLE value
 * before any tax is worked out, and it is spread across the lines first, so a bill that mixes
 * GST slabs is still taxed correctly slab by slab.
 */
describe('calculateBill with a bill-level discount', () => {
  const amount = (value: number) => ({ type: 'AMOUNT' as const, value });
  const percent = (value: number) => ({ type: 'PERCENT' as const, value });

  it('charges the full taxable value when there is no discount', () => {
    expect(calculateBill([{ quantity: 1, rate: 1000, gstRate: 18 }], 'WITH_GST', { type: 'NONE', value: 0 }).totals).toEqual({
      subTotal: 1000,
      discountAmount: 0,
      netTaxable: 1000,
      gstAmount: 180,
      grandTotal: 1180,
    });
  });

  /** Omitting the discount entirely must calculate exactly as Phase 1 did. */
  it('treats a missing discount as no discount', () => {
    const lines = [{ quantity: 2, rate: 250.5, gstRate: 12 }];
    expect(calculateBill(lines, 'WITH_GST')).toEqual(calculateBill(lines, 'WITH_GST', { type: 'NONE', value: 0 }));
  });

  it('takes a fixed discount off the taxable value before GST', () => {
    const { lines, totals } = calculateBill([{ quantity: 1, rate: 1000, gstRate: 18 }], 'WITH_GST', amount(100));
    expect(lines[0]).toEqual({ grossTaxable: 1000, discountAllocated: 100, taxableAmount: 900, gstAmount: 162, lineTotal: 1062 });
    expect(totals).toEqual({ subTotal: 1000, discountAmount: 100, netTaxable: 900, gstAmount: 162, grandTotal: 1062 });
  });

  /**
   * The vector the requirement spells out. Taxing the undiscounted lines and subtracting the
   * 300 at the very bottom would give a different grand total AND a rate-wise summary that
   * does not add up — which is exactly why it is not done that way.
   */
  it('allocates a discount across mixed GST slabs before taxing each of them', () => {
    const { lines, totals, gstSummary: summary } = calculateBill(
      [
        { quantity: 1, rate: 1000, gstRate: 5 },
        { quantity: 1, rate: 2000, gstRate: 18 },
      ],
      'WITH_GST',
      amount(300),
    );
    expect(lines[0]).toEqual({ grossTaxable: 1000, discountAllocated: 100, taxableAmount: 900, gstAmount: 45, lineTotal: 945 });
    expect(lines[1]).toEqual({ grossTaxable: 2000, discountAllocated: 200, taxableAmount: 1800, gstAmount: 324, lineTotal: 2124 });
    expect(totals).toEqual({ subTotal: 3000, discountAmount: 300, netTaxable: 2700, gstAmount: 369, grandTotal: 3069 });
    expect(summary).toEqual([
      { gstRate: 5, taxableAmount: 900, gstAmount: 45 },
      { gstRate: 18, taxableAmount: 1800, gstAmount: 324 },
    ]);
  });

  it('reads a percentage against the sub total, not against the grand total', () => {
    const { totals } = calculateBill(
      [
        { quantity: 4, rate: 1000, gstRate: 18 },
        { quantity: 2, rate: 3000, gstRate: 18 },
      ],
      'WITH_GST',
      percent(10),
    );
    // 10% of the 10,000 taxable — NOT 10% of the 11,800 the bill would otherwise come to.
    expect(totals).toMatchObject({ subTotal: 10000, discountAmount: 1000, netTaxable: 9000, gstAmount: 1620, grandTotal: 10620 });
  });

  it('rounds a fractional percentage half-up', () => {
    // 12.5% of 1,000.05 is 125.00625 -> 125.01.
    expect(calculateBill([{ quantity: 1, rate: 1000.05, gstRate: 0 }], 'WITH_GST', percent(12.5)).totals.discountAmount).toBe(125.01);
  });

  it('gives the same answer for an amount and for the percentage that comes to it', () => {
    const lines = [{ quantity: 3, rate: 700, gstRate: 12 }];
    expect(calculateBill(lines, 'WITH_GST', percent(10)).totals).toEqual(calculateBill(lines, 'WITH_GST', amount(210)).totals);
  });

  /* ------------------------------------------------- the allocation itself -- */

  describe('allocating the discount across the lines', () => {
    /** The invariant everything else depends on: not a paisa is invented or lost. */
    const allocationSums = (lines: { quantity: number; rate: number; gstRate: number }[], discount: { type: 'AMOUNT' | 'PERCENT'; value: number }) => {
      const { lines: amounts, totals } = calculateBill(lines, 'WITH_GST', discount);
      const allocated = amounts.reduce((t, l) => t + Math.round(l.discountAllocated * 100), 0);
      expect(allocated).toBe(Math.round(totals.discountAmount * 100));
      expect(totals.netTaxable).toBe(Number((totals.subTotal - totals.discountAmount).toFixed(2)));
      return totals;
    };

    it('gives the whole discount to the only line there is', () => {
      expect(calculateBill([{ quantity: 1, rate: 500, gstRate: 18 }], 'WITH_GST', amount(123.45)).lines[0].discountAllocated).toBe(123.45);
    });

    it('splits a discount in proportion to each line, to the paisa', () => {
      const { lines } = calculateBill(
        [
          { quantity: 1, rate: 100, gstRate: 18 },
          { quantity: 1, rate: 300, gstRate: 18 },
        ],
        'WITH_GST',
        amount(40),
      );
      expect(lines.map((l) => l.discountAllocated)).toEqual([10, 30]);
    });

    /**
     * Three equal lines and a discount that does not divide by three: each exact share is
     * 33.3333, so the floors drop a paisa and the largest-remainder pass hands it back. The
     * answer is 33.34 + 33.33 + 33.33, never 33.33 three times, which would total 99.99.
     */
    it('hands the rounding remainder to a deterministic line rather than losing it', () => {
      const lines = Array.from({ length: 3 }, () => ({ quantity: 1, rate: 100, gstRate: 18 }));
      expect(calculateBill(lines, 'WITH_GST', amount(100)).lines.map((l) => l.discountAllocated)).toEqual([33.34, 33.33, 33.33]);
      allocationSums(lines, amount(100));
    });

    it('allocates the same way every time it is asked', () => {
      const lines = [
        { quantity: 1, rate: 33.33, gstRate: 5 },
        { quantity: 3, rate: 11.11, gstRate: 12 },
        { quantity: 2, rate: 49.99, gstRate: 18 },
      ];
      const once = calculateBill(lines, 'WITH_GST', amount(37.77)).lines.map((l) => l.discountAllocated);
      expect(calculateBill(lines, 'WITH_GST', amount(37.77)).lines.map((l) => l.discountAllocated)).toEqual(once);
    });

    it.each([
      ['an awkward amount over three equal lines', [100, 100, 100], amount(0.01)],
      ['a discount smaller than the line count', [10, 20, 30, 40, 50], amount(0.03)],
      ['odd quantities at fractional rates', [33.33, 66.67, 0.01, 999.99], percent(7.77)],
      ['a percentage that cannot divide evenly', [1, 1, 1, 1, 1, 1, 1], percent(33.33)],
      ['a single paisa line among large ones', [0.01, 5000, 12345.67], amount(999.99)],
    ])('allocates exactly, with %s', (_case, rates, discount) => {
      allocationSums(
        (rates as number[]).map((rate, i) => ({ quantity: 1, rate, gstRate: [0, 5, 12, 18][i % 4] })),
        discount as { type: 'AMOUNT' | 'PERCENT'; value: number },
      );
    });

    /** A line worth nothing cannot absorb a discount, and must not be pushed below zero. */
    it('never allocates to a zero-value line', () => {
      const { lines } = calculateBill(
        [
          { quantity: 1, rate: 0, gstRate: 18 },
          { quantity: 1, rate: 100, gstRate: 18 },
        ],
        'WITH_GST',
        amount(100),
      );
      expect(lines[0]).toMatchObject({ grossTaxable: 0, discountAllocated: 0, taxableAmount: 0 });
      expect(lines[1].discountAllocated).toBe(100);
    });

    /** Nothing to discount: no division by zero, and no discount conjured out of nothing. */
    it('discounts nothing on a bill whose lines are all worth nothing', () => {
      const lines = [{ quantity: 2, rate: 0, gstRate: 18 }];
      expect(calculateBill(lines, 'WITH_GST', amount(50)).totals).toMatchObject({ subTotal: 0, discountAmount: 0, netTaxable: 0, grandTotal: 0 });
      expect(calculateBill(lines, 'WITH_GST', percent(10)).totals).toMatchObject({ subTotal: 0, discountAmount: 0, grandTotal: 0 });
    });

    it('takes a bill to exactly zero at 100%, and no further', () => {
      const { lines, totals } = calculateBill(
        [
          { quantity: 1, rate: 1000, gstRate: 18 },
          { quantity: 2, rate: 33.33, gstRate: 5 },
        ],
        'WITH_GST',
        percent(100),
      );
      expect(lines.every((l) => l.taxableAmount === 0 && l.gstAmount === 0 && l.lineTotal === 0)).toBe(true);
      expect(totals).toEqual({ subTotal: 1066.66, discountAmount: 1066.66, netTaxable: 0, gstAmount: 0, grandTotal: 0 });
    });

    /**
     * A defensive clamp, not a business rule: `billSchema` refuses both of these with a field
     * error rather than shrinking them. What is pinned here is only that the calculation
     * could never produce a negative bill if one ever reached it.
     */
    it('cannot be driven past zero by an impossible discount', () => {
      expect(calculateBill([{ quantity: 1, rate: 100, gstRate: 18 }], 'WITH_GST', amount(5000)).totals).toMatchObject({ discountAmount: 100, netTaxable: 0, grandTotal: 0 });
      expect(calculateBill([{ quantity: 1, rate: 100, gstRate: 18 }], 'WITH_GST', percent(150)).totals).toMatchObject({ discountAmount: 100, netTaxable: 0, grandTotal: 0 });
    });

    /** The point where the arithmetic would drift if any of it were done in floating point. */
    it('stays exact on a full bill of the largest lines the limits allow', () => {
      const lines = Array.from({ length: BILL_LIMITS.maxLines }, () => ({ quantity: BILL_QUANTITY_MAX, rate: BILL_RATE_MAX, gstRate: 18 }));
      const totals = allocationSums(lines, percent(33.33));
      expect(totals.subTotal).toBe(999998990000);
    });
  });

  /* ---------------------------------------------------- the two tax modes -- */

  it('discounts a WITHOUT_GST bill normally and still charges no tax', () => {
    const { lines, totals } = calculateBill(
      [
        { quantity: 1, rate: 1000, gstRate: 18 },
        { quantity: 1, rate: 1000, gstRate: 5 },
      ],
      'WITHOUT_GST',
      amount(200),
    );
    expect(lines.map((l) => l.gstAmount)).toEqual([0, 0]);
    expect(lines.map((l) => l.taxableAmount)).toEqual([900, 900]);
    expect(totals).toEqual({ subTotal: 2000, discountAmount: 200, netTaxable: 1800, gstAmount: 0, grandTotal: 1800 });
  });

  /** Switching the mode changes the tax charged and nothing else about the bill. */
  it('leaves the taxable side of a bill identical in both tax modes', () => {
    const lines = [{ quantity: 1, rate: 1000, gstRate: 18 }];
    const withGst = calculateBill(lines, 'WITH_GST', amount(100));
    const withoutGst = calculateBill(lines, 'WITHOUT_GST', amount(100));
    expect(withoutGst.totals).toMatchObject({ subTotal: withGst.totals.subTotal, discountAmount: withGst.totals.discountAmount, netTaxable: withGst.totals.netTaxable });
    expect(withGst.totals.grandTotal).toBe(1062);
    expect(withoutGst.totals.grandTotal).toBe(900);
  });
});

/* ------------------------------------------- A1c. the rate-wise GST detail -- */

describe('gstSummary (the rate-wise GST detail)', () => {
  it('groups the lines by their GST rate and adds each group up', () => {
    const { gstSummary: summary } = calculateBill(
      [
        { quantity: 1, rate: 1000, gstRate: 5 },
        { quantity: 1, rate: 2000, gstRate: 12 },
        { quantity: 1, rate: 3000, gstRate: 18 },
        { quantity: 1, rate: 500, gstRate: 12 },
      ],
      'WITH_GST',
    );
    expect(summary).toEqual([
      { gstRate: 5, taxableAmount: 1000, gstAmount: 50 },
      { gstRate: 12, taxableAmount: 2500, gstAmount: 300 },
      { gstRate: 18, taxableAmount: 3000, gstAmount: 540 },
    ]);
  });

  it('adds up to the bill totals it was grouped from', () => {
    const { totals, gstSummary: summary } = calculateBill(
      [
        { quantity: 2, rate: 333.33, gstRate: 5 },
        { quantity: 3, rate: 111.11, gstRate: 18 },
        { quantity: 1, rate: 99.99, gstRate: 0 },
      ],
      'WITH_GST',
      { type: 'AMOUNT', value: 250 },
    );
    expect(summary.reduce((t, r) => t + r.taxableAmount, 0)).toBe(totals.netTaxable);
    expect(summary.reduce((t, r) => t + r.gstAmount, 0)).toBe(totals.gstAmount);
  });

  /** The figure a GST return needs is the base tax was charged on, i.e. after the discount. */
  it('reports the taxable value AFTER the discount', () => {
    expect(calculateBill([{ quantity: 1, rate: 1000, gstRate: 18 }], 'WITH_GST', { type: 'AMOUNT', value: 200 }).gstSummary).toEqual([
      { gstRate: 18, taxableAmount: 800, gstAmount: 144 },
    ]);
  });

  it('keeps a 0% group rather than dropping its taxable value', () => {
    const { gstSummary: summary } = calculateBill(
      [
        { quantity: 1, rate: 500, gstRate: 0 },
        { quantity: 1, rate: 500, gstRate: 18 },
      ],
      'WITH_GST',
    );
    expect(summary).toEqual([
      { gstRate: 0, taxableAmount: 500, gstAmount: 0 },
      { gstRate: 18, taxableAmount: 500, gstAmount: 90 },
    ]);
  });

  it('sorts the rates the same way on every bill', () => {
    const { gstSummary: summary } = calculateBill(
      [
        { quantity: 1, rate: 100, gstRate: 28 },
        { quantity: 1, rate: 100, gstRate: 5 },
        { quantity: 1, rate: 100, gstRate: 12 },
      ],
      'WITH_GST',
    );
    expect(summary.map((r) => r.gstRate)).toEqual([5, 12, 28]);
  });

  /** WITHOUT_GST still groups — the rates are the lines' snapshots, and nothing was charged. */
  it('shows zero tax in every group of a WITHOUT_GST bill while keeping its rates', () => {
    const { gstSummary: summary } = calculateBill(
      [
        { quantity: 1, rate: 1000, gstRate: 18 },
        { quantity: 1, rate: 500, gstRate: 5 },
      ],
      'WITHOUT_GST',
    );
    expect(summary).toEqual([
      { gstRate: 5, taxableAmount: 500, gstAmount: 0 },
      { gstRate: 18, taxableAmount: 1000, gstAmount: 0 },
    ]);
  });

  it('has nothing to say about a bill with no lines', () => {
    expect(gstSummary([])).toEqual([]);
  });
});

/* -------------------------------------------------- A2. the create payload -- */

describe('billSchema (create payload)', () => {
  it('accepts a minimal bill and leaves every optional field empty', () => {
    expect(parseBill(makeBill())).toEqual({
      bookId: BOOK_ID,
      appointmentId: null,
      billDate: '2026-09-23',
      deliveryDate: null,
      customerName: 'Ramesh Patel',
      mobileNumber: '9876543210',
      babyName: null,
      hasBirthDate: false,
      birthDate: null,
      remark: null,
      nextVisitDate: null,
      discountType: 'NONE',
      discountValue: 0,
      items: [{ itemId: ITEM_ID, subItemId: SUB_ITEM_ID, quantity: 1, rate: 100, remark: null }],
      // Create-only: no money received with it, no idempotency id.
      advance: null,
      requestId: null,
    });
  });

  it('accepts a full bill', () => {
    expect(
      parseBill(
        makeBill({
          appointmentId: APPOINTMENT_ID,
          deliveryDate: '2026-10-02',
          babyName: 'Aarav',
          hasBirthDate: true,
          birthDate: '2025-04-11',
          remark: 'Album delivery by Diwali',
          taxMode: 'WITHOUT_GST',
        }),
      ),
    ).toMatchObject({
      appointmentId: APPOINTMENT_ID,
      deliveryDate: '2026-10-02',
      babyName: 'Aarav',
      hasBirthDate: true,
      birthDate: '2025-04-11',
      remark: 'Album delivery by Diwali',
      taxMode: 'WITHOUT_GST',
    });
  });

  /**
   * The number, the search key, the line snapshots and every amount belong to the server.
   * zod strips unknown keys, so a payload that carries them loses them before any route code
   * runs — the route never has to remember to ignore them.
   */
  it.each(['billNumber', 'mobileSearch', 'subTotal', 'gstAmount', 'grandTotal'])('drops a client-supplied %s from the header', (field) => {
    expect(parseBill(makeBill({ [field]: 9999 }))).not.toHaveProperty(field);
  });

  it.each(['itemNameSnapshot', 'subItemNameSnapshot', 'hsnCodeSnapshot', 'gstRateSnapshot', 'taxableAmount', 'gstAmount', 'lineTotal', 'lineNumber'])(
    'drops a client-supplied %s from a line',
    (field) => {
      expect(parseBill(makeBill({ items: [makeLine({ [field]: 'forged' })] })).items[0]).not.toHaveProperty(field);
    },
  );

  describe('items', () => {
    it('rejects a bill with no lines, because a document with nothing on it is not a bill', () => {
      expect(issuesFor(makeBill({ items: [] }))).toContainEqual({ path: 'items', message: 'Add at least one item' });
    });

    it('rejects a bill with no items field at all', () => {
      const body = makeBill();
      delete (body as Record<string, unknown>).items;
      expect(issuesFor(body).map((i) => i.path)).toContain('items');
    });

    it(`accepts a bill of exactly ${BILL_LIMITS.maxLines} lines`, () => {
      expect(parseBill(makeBill({ items: Array.from({ length: BILL_LIMITS.maxLines }, () => makeLine()) })).items).toHaveLength(BILL_LIMITS.maxLines);
    });

    it('rejects a runaway payload of more lines than the limit', () => {
      expect(issuesFor(makeBill({ items: Array.from({ length: BILL_LIMITS.maxLines + 1 }, () => makeLine()) }))).toContainEqual({
        path: 'items',
        message: `A bill cannot have more than ${BILL_LIMITS.maxLines} items`,
      });
    });

    /** The operator has to be told WHICH line is wrong, so the issue path names its position. */
    it('reports a bad line against that line position', () => {
      expect(issuesFor(makeBill({ items: [makeLine(), makeLine({ quantity: 0 })] }))).toContainEqual({
        path: 'items.1.quantity',
        message: 'Qty must be greater than 0',
      });
    });
  });

  describe('the birthdate checkbox and its date', () => {
    it('drops a birth date left behind when the checkbox is unticked', () => {
      expect(parseBill(makeBill({ hasBirthDate: false, birthDate: '2025-04-11' }))).toMatchObject({ hasBirthDate: false, birthDate: null });
    });

    it('requires the date once the checkbox is ticked', () => {
      expect(issuesFor(makeBill({ hasBirthDate: true }))).toContainEqual({ path: 'birthDate', message: 'Birth date is required' });
    });

    it('rejects a ticked checkbox with a blank date', () => {
      expect(issuesFor(makeBill({ hasBirthDate: true, birthDate: '   ' }))).toContainEqual({ path: 'birthDate', message: 'Birth date is required' });
    });

    it('keeps the date when the checkbox is ticked', () => {
      expect(parseBill(makeBill({ hasBirthDate: true, birthDate: '2025-04-11' }))).toMatchObject({ hasBirthDate: true, birthDate: '2025-04-11' });
    });

    it('defaults the checkbox to unticked', () => {
      expect(parseBill(makeBill())).toMatchObject({ hasBirthDate: false });
    });

    it.each(['2025-02-30', '2025-13-01', '11-04-2025'])('rejects the impossible birth date %p', (d) => {
      expect(issuesFor(makeBill({ hasBirthDate: true, birthDate: d }))).toContainEqual({ path: 'birthDate', message: 'Enter a valid birth date' });
    });
  });

  describe('billDate', () => {
    it('is required', () => {
      const body = makeBill();
      delete (body as Record<string, unknown>).billDate;
      expect(issuesFor(body)).toContainEqual({ path: 'billDate', message: 'Bill date is required' });
    });

    it.each(['23-09-2026', '2026/09/23', '2026-9-3', 'today'])('rejects %p, which is not an ISO calendar date', (d) => {
      expect(issuesFor(makeBill({ billDate: d }))).toContainEqual({ path: 'billDate', message: 'Enter a valid bill date' });
    });

    /** A date that does not exist must be refused, never rolled over into the next month. */
    it.each(['2026-02-30', '2026-13-01', '2026-04-31', '2026-00-10', '2027-02-29'])('rejects the impossible date %p', (d) => {
      expect(issuesFor(makeBill({ billDate: d }))).toContainEqual({ path: 'billDate', message: 'Enter a valid bill date' });
    });

    it('accepts 29 February in a leap year', () => {
      expect(parseBill(makeBill({ billDate: '2028-02-29' }))).toMatchObject({ billDate: '2028-02-29' });
    });
  });

  describe('deliveryDate', () => {
    it.each([undefined, null, '', '   '])('treats %p as no promised date rather than as an error', (d) => {
      expect(parseBill(makeBill({ deliveryDate: d }))).toMatchObject({ deliveryDate: null });
    });

    it('rejects an impossible delivery date', () => {
      expect(issuesFor(makeBill({ deliveryDate: '2026-11-31' }))).toContainEqual({ path: 'deliveryDate', message: 'Enter a valid delivery date' });
    });

    /** Nothing in this phase says delivery must follow the bill; billing a delivered job is real. */
    it('accepts a delivery date before the bill date', () => {
      expect(parseBill(makeBill({ billDate: '2026-09-23', deliveryDate: '2026-09-01' }))).toMatchObject({ deliveryDate: '2026-09-01' });
    });
  });

  describe('bookId', () => {
    it('is required, because the book is the number series', () => {
      const body = makeBill();
      delete (body as Record<string, unknown>).bookId;
      expect(issuesFor(body)).toContainEqual({ path: 'bookId', message: 'Book is required' });
    });

    it('must be a uuid', () => {
      expect(issuesFor(makeBill({ bookId: 'book-2026-27' }))).toContainEqual({ path: 'bookId', message: 'Select a valid book' });
    });
  });

  describe('appointmentId', () => {
    it.each([undefined, null, '', '   '])('treats %p as a walk-in customer with no booking', (a) => {
      expect(parseBill(makeBill({ appointmentId: a }))).toMatchObject({ appointmentId: null });
    });

    it('must be a uuid when it is given', () => {
      expect(issuesFor(makeBill({ appointmentId: '42' }))).toContainEqual({ path: 'appointmentId', message: 'Select a valid appointment' });
    });
  });

  describe('customerName', () => {
    it('is required', () => {
      const body = makeBill();
      delete (body as Record<string, unknown>).customerName;
      expect(issuesFor(body)).toContainEqual({ path: 'customerName', message: 'Customer name is required' });
    });

    it('rejects a whitespace-only name, because it is trimmed before it is measured', () => {
      expect(issuesFor(makeBill({ customerName: '   ' }))).toContainEqual({ path: 'customerName', message: 'Customer name is required' });
    });

    it('trims the stored name', () => {
      expect(parseBill(makeBill({ customerName: '  Ramesh Patel  ' }))).toMatchObject({ customerName: 'Ramesh Patel' });
    });

    it(`accepts a name of exactly ${BILL_LIMITS.customerName} characters`, () => {
      expect(parseBill(makeBill({ customerName: 'a'.repeat(BILL_LIMITS.customerName) }))).toMatchObject({ customerName: 'a'.repeat(BILL_LIMITS.customerName) });
    });

    it('rejects a longer name', () => {
      expect(issuesFor(makeBill({ customerName: 'a'.repeat(BILL_LIMITS.customerName + 1) }))).toContainEqual({
        path: 'customerName',
        message: `Customer name cannot exceed ${BILL_LIMITS.customerName} characters`,
      });
    });
  });

  describe('mobileNumber', () => {
    it('is required', () => {
      const body = makeBill();
      delete (body as Record<string, unknown>).mobileNumber;
      expect(issuesFor(body)).toContainEqual({ path: 'mobileNumber', message: 'Mobile no. is required' });
    });

    /** Billing's rule: exactly ten digits, nothing else (Appointment keeps its own looser rule). */
    it.each(['9876543210', '0123456789', ' 9876543210 '])('accepts %p as ten digits', (m) => {
      expect(parseBill(makeBill({ mobileNumber: m }))).toMatchObject({ mobileNumber: m.trim() });
    });

    it('rejects nine digits', () => {
      expect(issuesFor(makeBill({ mobileNumber: '987654321' }))).toContainEqual({ path: 'mobileNumber', message: `Mobile no. must be exactly ${BILL_MOBILE_DIGITS} digits` });
    });

    it('rejects eleven digits', () => {
      expect(issuesFor(makeBill({ mobileNumber: '98765432101' }))).toContainEqual({ path: 'mobileNumber', message: `Mobile no. must be exactly ${BILL_MOBILE_DIGITS} digits` });
    });

    it.each(['98765abc10', '98765 4321', '+919876543', '98765-4321', 'call studio'])('rejects %p — letters, spaces or symbols', (m) => {
      expect(issuesFor(makeBill({ mobileNumber: m }))).toContainEqual({ path: 'mobileNumber', message: 'Mobile no. can contain digits only' });
    });
  });

  describe('update payload mobile (legacy bills)', () => {
    /** The shape check is loose on edit; `updateBill` then insists on ten digits unless the key is unchanged. */
    it.each(['+91 98765 43210', '98765-4321', '9876543210'])('the update schema lets %p through to the server rule', (m) => {
      const { bookId: _b, ...body } = makeBill({ mobileNumber: m });
      expect(billUpdateSchema.safeParse(body).success).toBe(true);
      expect(billSchema.safeParse(makeBill({ mobileNumber: m })).success).toBe(m === '9876543210');
    });

    it('still refuses a mobile with no digit at all on edit', () => {
      const { bookId: _b, ...body } = makeBill({ mobileNumber: 'call the studio' });
      expect(billUpdateSchema.safeParse(body).success).toBe(false);
    });
  });

  describe('sanitizeMobileInput (what the form keeps while typing or pasting)', () => {
    it.each([
      ['9876543210', '9876543210'],
      ['98765432101', '9876543210'],
      ['98765abc43210', '9876543210'],
      ['+91 98765 43210', '9876543210'],
      ['098765 43210', '9876543210'],
      ['98765-43210', '9876543210'],
      ['abc', ''],
      ['', ''],
      ['987', '987'],
    ])('%p -> %p', (raw, kept) => {
      expect(sanitizeMobileInput(raw)).toBe(kept);
    });
  });

  describe('babyName and remark', () => {
    it.each(['babyName', 'remark'])('%s is optional and stores blank as null', (field) => {
      expect(parseBill(makeBill({ [field]: '  ' }))).toMatchObject({ [field]: null });
    });

    it('rejects a remark longer than the limit', () => {
      expect(issuesFor(makeBill({ remark: 'a'.repeat(BILL_LIMITS.remark + 1) }))).toContainEqual({ path: 'remark', message: `Remark cannot exceed ${BILL_LIMITS.remark} characters` });
    });
  });

  describe('taxMode', () => {
    it('is optional — the book decides it, the server derives it', () => {
      expect(parseBill(makeBill()).taxMode).toBeUndefined();
    });

    it.each(['WITH_GST', 'WITHOUT_GST'])('accepts %p', (m) => {
      expect(parseBill(makeBill({ taxMode: m }))).toMatchObject({ taxMode: m });
    });

    it.each(['IGST', 'with_gst', ''])('rejects %p', (m) => {
      expect(issuesFor(makeBill({ taxMode: m }))).toContainEqual({ path: 'taxMode', message: 'Select a valid tax mode' });
    });
  });

  /**
   * The discount a client is allowed to send: the TYPE and the VALUE, never the money. The
   * two real limits are refused with a field message rather than quietly clamped — an
   * operator who typed 101% has made a mistake, and a bill that silently became 100% off
   * would hide it.
   */
  describe('the bill discount', () => {
    /** Every bill in this block has one line at 1 x 100, so its sub total is 100.00. */
    const withDiscount = (discountType: string, discountValue?: unknown) => makeBill({ discountType, discountValue });

    it('defaults to no discount at all', () => {
      expect(parseBill(makeBill())).toMatchObject({ discountType: 'NONE', discountValue: 0 });
    });

    it('reads a cleared value as no discount rather than as an error', () => {
      expect(parseBill(withDiscount('AMOUNT', ''))).toMatchObject({ discountType: 'AMOUNT', discountValue: 0 });
    });

    it.each([
      ['AMOUNT', 25, 25],
      ['AMOUNT', '99.99', 99.99],
      ['PERCENT', 10, 10],
      ['PERCENT', 12.5, 12.5],
      ['PERCENT', 100, 100],
      ['AMOUNT', 100, 100],
    ])('accepts a %s discount of %p', (type, value, expected) => {
      expect(parseBill(withDiscount(type, value))).toMatchObject({ discountType: type, discountValue: expected });
    });

    /** NONE is the statement that there is no discount, so a leftover value is dropped. */
    it('drops a value left behind by switching the discount off', () => {
      expect(parseBill(withDiscount('NONE', 50))).toMatchObject({ discountType: 'NONE', discountValue: 0 });
    });

    it.each(['FLAT', 'percent', ''])('rejects the discount type %p', (t) => {
      expect(issuesFor(withDiscount(t, 1))).toContainEqual({ path: 'discountType', message: 'Select a valid discount type' });
    });

    it('refuses a negative discount', () => {
      expect(issuesFor(withDiscount('AMOUNT', -1))).toContainEqual({ path: 'discountValue', message: 'Discount cannot be negative' });
    });

    it('refuses more precision than the money columns hold', () => {
      expect(issuesFor(withDiscount('AMOUNT', 10.005))).toContainEqual({ path: 'discountValue', message: 'Discount can have at most 2 decimal places' });
    });

    it('refuses a percentage above 100 instead of clamping it', () => {
      expect(issuesFor(withDiscount('PERCENT', 101))).toContainEqual({ path: 'discountValue', message: 'Discount cannot be more than 100%' });
    });

    it('refuses an amount larger than the bill it is being given on', () => {
      expect(issuesFor(withDiscount('AMOUNT', 100.01))).toContainEqual({ path: 'discountValue', message: 'Discount cannot be more than the sub total (100.00)' });
    });

    /** Nothing to discount, so any amount is too much — and no division by zero happens. */
    it('refuses an amount on a bill whose lines are all worth nothing', () => {
      const free = makeBill({ discountType: 'AMOUNT', discountValue: 1, items: [makeLine({ rate: 0 })] });
      expect(issuesFor(free)).toContainEqual({ path: 'discountValue', message: 'Discount cannot be more than the sub total (0.00)' });
    });

    it('accepts a percentage on a bill worth nothing, because it comes to nothing', () => {
      expect(parseBill(makeBill({ discountType: 'PERCENT', discountValue: 10, items: [makeLine({ rate: 0 })] }))).toMatchObject({ discountValue: 10 });
    });

    it('measures an amount against the WHOLE bill, not against one line', () => {
      const twoLines = { items: [makeLine({ quantity: 1, rate: 100 }), makeLine({ quantity: 1, rate: 100 })] };
      expect(parseBill(makeBill({ ...twoLines, discountType: 'AMOUNT', discountValue: 150 }))).toMatchObject({ discountValue: 150 });
    });

    it('applies the same rules to an update', () => {
      expect(issuesFor(makeUpdate({ discountType: 'PERCENT', discountValue: 101 }), billUpdateSchema)).toContainEqual({
        path: 'discountValue',
        message: 'Discount cannot be more than 100%',
      });
    });

    /** The money is never the client's to state — the fields simply do not exist here. */
    it('strips a discount amount a client tries to state for itself', () => {
      expect(parseBill(withDiscount('PERCENT', 10) as Record<string, unknown>)).not.toHaveProperty('discountAmount');
      expect(parseBill(makeBill({ discountType: 'PERCENT', discountValue: 10, discountAmount: 999, netTaxable: 1 }))).not.toHaveProperty('netTaxable');
    });
  });
});

/* ---------------------------------------------------------- A3. one line -- */

describe('billItemSchema (one line)', () => {
  it('accepts a line and leaves its remark empty', () => {
    expect(billItemSchema.parse(makeLine())).toEqual({ itemId: ITEM_ID, subItemId: SUB_ITEM_ID, quantity: 1, rate: 100, remark: null });
  });

  describe('itemId and subItemId', () => {
    it('requires the item', () => {
      const line = makeLine();
      delete (line as Record<string, unknown>).itemId;
      expect(issuesFor(line, billItemSchema)).toContainEqual({ path: 'itemId', message: 'Item is required' });
    });

    /** A line bills a Product under an Item — there is no item-only line with no rate of its own. */
    it('requires the product', () => {
      const line = makeLine();
      delete (line as Record<string, unknown>).subItemId;
      expect(issuesFor(line, billItemSchema)).toContainEqual({ path: 'subItemId', message: 'Product is required' });
    });

    it('rejects an item id that is not a uuid', () => {
      expect(issuesFor(makeLine({ itemId: 'album' }), billItemSchema)).toContainEqual({ path: 'itemId', message: 'Select a valid item' });
    });

    it('rejects a product id that is not a uuid', () => {
      expect(issuesFor(makeLine({ subItemId: '17' }), billItemSchema)).toContainEqual({ path: 'subItemId', message: 'Select a valid product' });
    });
  });

  describe('quantity', () => {
    it('is required', () => {
      const line = makeLine();
      delete (line as Record<string, unknown>).quantity;
      expect(issuesFor(line, billItemSchema)).toContainEqual({ path: 'quantity', message: 'Qty is required' });
    });

    /** Blank must never coerce to 0 — a zero-quantity line is a free line nobody asked for. */
    it.each([null, '', '   '])('treats %p as missing rather than as zero', (q) => {
      expect(issuesFor(makeLine({ quantity: q }), billItemSchema)).toContainEqual({ path: 'quantity', message: 'Qty is required' });
    });

    it('rejects a quantity of 0', () => {
      expect(issuesFor(makeLine({ quantity: 0 }), billItemSchema)).toContainEqual({ path: 'quantity', message: 'Qty must be greater than 0' });
    });

    it('rejects a negative quantity', () => {
      expect(issuesFor(makeLine({ quantity: -1 }), billItemSchema)).toContainEqual({ path: 'quantity', message: 'Qty must be greater than 0' });
    });

    it('accepts a fractional quantity', () => {
      expect(billItemSchema.parse(makeLine({ quantity: 0.5 }))).toMatchObject({ quantity: 0.5 });
    });

    /** A form posts strings; "2.50" is the operator typing two and a half, not a type error. */
    it('reads a numeric string from the form', () => {
      expect(billItemSchema.parse(makeLine({ quantity: '2.50' }))).toMatchObject({ quantity: 2.5 });
    });

    /** A silently rounded quantity is a changed bill, so a third decimal is refused, not dropped. */
    it('rejects a quantity with three decimals', () => {
      expect(issuesFor(makeLine({ quantity: 1.005 }), billItemSchema)).toContainEqual({ path: 'quantity', message: 'Qty can have at most 2 decimal places' });
    });

    it(`accepts the largest quantity the column holds (${BILL_QUANTITY_MAX})`, () => {
      expect(billItemSchema.parse(makeLine({ quantity: BILL_QUANTITY_MAX }))).toMatchObject({ quantity: BILL_QUANTITY_MAX });
    });

    it('rejects a quantity past the column ceiling', () => {
      expect(issuesFor(makeLine({ quantity: BILL_QUANTITY_MAX + 0.01 }), billItemSchema)).toContainEqual({ path: 'quantity', message: 'Qty is too large' });
    });

    it.each([Infinity, NaN])('rejects %p', (q) => {
      expect(issuesFor(makeLine({ quantity: q }), billItemSchema).map((i) => i.path)).toContain('quantity');
    });
  });

  describe('rate', () => {
    it('is required', () => {
      const line = makeLine();
      delete (line as Record<string, unknown>).rate;
      expect(issuesFor(line, billItemSchema)).toContainEqual({ path: 'rate', message: 'Rate is required' });
    });

    it.each([null, '', '   '])('treats %p as missing rather than as free', (r) => {
      expect(issuesFor(makeLine({ rate: r }), billItemSchema)).toContainEqual({ path: 'rate', message: 'Rate is required' });
    });

    /** Unlike quantity, 0 is legitimate: a complimentary line still prints. */
    it('accepts a rate of 0', () => {
      expect(billItemSchema.parse(makeLine({ rate: 0 }))).toMatchObject({ rate: 0 });
    });

    it('rejects a negative rate', () => {
      expect(issuesFor(makeLine({ rate: -100 }), billItemSchema)).toContainEqual({ path: 'rate', message: 'Rate cannot be negative' });
    });

    it('rejects a rate with three decimals', () => {
      expect(issuesFor(makeLine({ rate: 33.333 }), billItemSchema)).toContainEqual({ path: 'rate', message: 'Rate can have at most 2 decimal places' });
    });

    it(`accepts the largest rate the column holds (${BILL_RATE_MAX})`, () => {
      expect(billItemSchema.parse(makeLine({ rate: BILL_RATE_MAX }))).toMatchObject({ rate: BILL_RATE_MAX });
    });

    it('rejects a rate past the column ceiling', () => {
      expect(issuesFor(makeLine({ rate: BILL_RATE_MAX + 0.01 }), billItemSchema)).toContainEqual({ path: 'rate', message: 'Rate is too large' });
    });
  });

  describe('remark', () => {
    it('stores a blank line remark as null', () => {
      expect(billItemSchema.parse(makeLine({ remark: '   ' }))).toMatchObject({ remark: null });
    });

    it('trims the line remark', () => {
      expect(billItemSchema.parse(makeLine({ remark: '  Matte finish  ' }))).toMatchObject({ remark: 'Matte finish' });
    });

    it('rejects a line remark longer than the limit', () => {
      expect(issuesFor(makeLine({ remark: 'a'.repeat(BILL_LIMITS.lineRemark + 1) }), billItemSchema)).toContainEqual({
        path: 'remark',
        message: `Remark cannot exceed ${BILL_LIMITS.lineRemark} characters`,
      });
    });
  });
});

/* ------------------------------------------------- A4. the update payload -- */

describe('billUpdateSchema (update payload)', () => {
  it('accepts the full document without a book', () => {
    expect(parseBill(makeUpdate(), billUpdateSchema)).toMatchObject({ billDate: '2026-09-23', customerName: 'Ramesh Patel' });
  });

  /**
   * The book decides the number series and therefore the document's identity. The field is
   * ABSENT from this schema rather than merely ignored, so a payload carrying it loses it in
   * validation and no edit can move a bill into another series.
   */
  it('has no book field at all, so a bookId in the payload is dropped', () => {
    expect(parseBill(makeUpdate({ bookId: BOOK_ID }), billUpdateSchema)).not.toHaveProperty('bookId');
  });

  it('does not require a book', () => {
    expect(billUpdateSchema.safeParse(makeUpdate()).success).toBe(true);
  });

  it('drops a client-supplied billNumber, so no edit can renumber a bill', () => {
    expect(parseBill(makeUpdate({ billNumber: 1 }), billUpdateSchema)).not.toHaveProperty('billNumber');
  });

  it.each(['mobileSearch', 'subTotal', 'gstAmount', 'grandTotal'])('drops a client-supplied %s', (field) => {
    expect(parseBill(makeUpdate({ [field]: 1 }), billUpdateSchema)).not.toHaveProperty(field);
  });

  /** An update carries the FULL line set — the lines are replaced, never patched. */
  it('still requires at least one line', () => {
    expect(issuesFor(makeUpdate({ items: [] }), billUpdateSchema)).toContainEqual({ path: 'items', message: 'Add at least one item' });
  });

  it('applies the same birthdate rule as a create', () => {
    expect(issuesFor(makeUpdate({ hasBirthDate: true }), billUpdateSchema)).toContainEqual({ path: 'birthDate', message: 'Birth date is required' });
  });

  it('drops a birth date left behind by unticking the checkbox', () => {
    expect(parseBill(makeUpdate({ hasBirthDate: false, birthDate: '2025-04-11' }), billUpdateSchema)).toMatchObject({ birthDate: null });
  });
});

/* ------------------------------------------ B. database-backed behaviour -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

/**
 * The bill number series, the master snapshots a bill freezes, tenant isolation, permission
 * enforcement and the transactions that keep all of it honest can only be proved against a
 * real database, so this suite is SKIPPED unless TEST_DATABASE_URL is set.
 *
 * Point it at a THROWAWAY database only. It creates and deletes tenants, roles, users, books,
 * items, sub items, appointments and bills, and must never run against the shared hosted
 * DATABASE_URL in apps/api/.env.
 *
 *   TEST_DATABASE_URL=postgres://... pnpm --filter @erp/api test
 */
describe.skipIf(!TEST_DB)('Bills API (integration, needs TEST_DATABASE_URL)', () => {
  type App = Awaited<ReturnType<typeof import('../server').buildApp>>;
  let app: App;
  let db: typeof import('../db/client').db;
  let sqlClient: typeof import('../db/client').sql;
  let schema: typeof import('../db/client').schema;
  let and: typeof import('drizzle-orm').and;
  let asc: typeof import('drizzle-orm').asc;
  let eq: typeof import('drizzle-orm').eq;
  let inArray: typeof import('drizzle-orm').inArray;
  let allocateBillNumber: typeof import('../services/billNumbers').allocateBillNumber;

  /** Everything seeded here is deleted in afterAll, tenant by tenant. */
  const tenantIds: string[] = [];
  const FULL = { operations_billing: ['read', 'create', 'update', 'delete'] };

  /* ------------------------------------------------------ HTTP shorthand -- */

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (token: string, payload: unknown) => app.inject({ method: 'POST', url: '/api/bills', headers: auth(token), payload: payload as object });
  const put = (token: string, id: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/bills/${id}`, headers: auth(token), payload: payload as object });
  const del = (token: string, id: string) => app.inject({ method: 'DELETE', url: `/api/bills/${id}`, headers: auth(token) });
  const get = (token: string, path = '') => app.inject({ method: 'GET', url: `/api/bills${path}`, headers: auth(token) });

  interface Line {
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
    grossTaxable: number;
    discountAllocated: number;
    taxableAmount: number;
    gstAmount: number;
    lineTotal: number;
    remark: string | null;
  }
  interface Bill {
    id: string;
    bookId: string;
    bookNumber: string;
    billNumber: number;
    appointmentId: string | null;
    appointmentNumber: number | null;
    billDate: string;
    customerName: string;
    mobileNumber: string;
    babyName: string | null;
    taxMode: string;
    discountType: string;
    discountValue: number;
    discountAmount: number;
    subTotal: number;
    netTaxable: number;
    gstAmount: number;
    grandTotal: number;
    items: Line[];
    gstSummary: { gstRate: number; taxableAmount: number; gstAmount: number }[];
  }

  const created = async (token: string, payload: unknown) => (await post(token, payload)).json().data as Bill;
  const detail = async (token: string, id: string) => (await get(token, `/${id}`)).json().data as Bill;
  const rowsOf = (res: Awaited<ReturnType<typeof get>>) => res.json().data.rows as Bill[];
  const numbersOf = (res: Awaited<ReturnType<typeof get>>) => rowsOf(res).map((r) => r.billNumber);

  /* ---------------------------------------------------------- fixtures -- */

  /** Unique per test, so one test's rows never satisfy another's search. */
  const uniqueName = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  /** Letters only — used where a digit in the value would also match a bill-number search. */
  const uniqueWord = (prefix: string) => `${prefix}${Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('')}`;

  /** One tenant + one role with the given grants + one user; returns a signed access token. */
  async function seedTenant(name: string, grants: Record<string, string[]> = FULL) {
    const [tenant] = await db.insert(schema.tenants).values({ name, slug: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }).returning();
    tenantIds.push(tenant.id);
    return { tenantId: tenant.id, token: await seedUser(tenant.id, name, grants) };
  }

  /** Another user of an EXISTING tenant, with its own grants — how the read-only tests get one. */
  async function seedUser(tenantId: string, name: string, grants: Record<string, string[]>) {
    const [role] = await db.insert(schema.roles).values({ tenantId, name: `${name} role ${Math.random().toString(36).slice(2, 6)}`, permissions: grants }).returning();
    const [user] = await db
      .insert(schema.users)
      .values({ tenantId, roleId: role.id, firstName: name, lastName: 'Tester', email: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`, passwordHash: 'not-a-real-hash' })
      .returning();
    return app.jwt.sign({ sub: user.id, tenantId });
  }

  async function seedBook(tenantId: string, overrides: { bookNumber?: string; seriesStartsAt?: number; isActive?: boolean; seriesType?: 'WITH_GST' | 'WITHOUT_GST' } = {}) {
    const seriesStartsAt = overrides.seriesStartsAt ?? 1;
    const [book] = await db
      .insert(schema.books)
      .values({ tenantId, bookNumber: overrides.bookNumber ?? uniqueWord('BK'), seriesStartsAt, nextBillNumber: seriesStartsAt, isActive: overrides.isActive ?? true, seriesType: overrides.seriesType ?? 'WITH_GST' })
      .returning();
    return book;
  }

  /** An Item and one of its Sub Items — the pair every bill line needs. */
  async function seedProduct(
    tenantId: string,
    overrides: { itemName?: string; hsnCode?: string; gstRate?: string; productName?: string; rate?: string; itemActive?: boolean; productActive?: boolean } = {},
  ) {
    const [item] = await db
      .insert(schema.items)
      .values({ tenantId, itemName: overrides.itemName ?? uniqueName('Item'), hsnCode: overrides.hsnCode ?? '9983', gstRate: overrides.gstRate ?? '18.00', isActive: overrides.itemActive ?? true })
      .returning();
    const [subItem] = await db
      .insert(schema.subItems)
      .values({ tenantId, itemId: item.id, productName: overrides.productName ?? uniqueName('Product'), rate: overrides.rate ?? '100.00', isActive: overrides.productActive ?? true })
      .returning();
    return { item, subItem };
  }
  type Product = Awaited<ReturnType<typeof seedProduct>>;

  let appointmentSeq = 0;
  async function seedAppointment(tenantId: string, overrides: { customerName?: string; mobileNumber?: string; appointmentDate?: string } = {}) {
    const mobileNumber = overrides.mobileNumber ?? '9876500000';
    const [appointment] = await db
      .insert(schema.appointments)
      .values({
        tenantId,
        appointmentNumber: ++appointmentSeq,
        appointmentDate: overrides.appointmentDate ?? '2026-09-20',
        customerName: overrides.customerName ?? 'Booking Customer',
        mobileNumber,
        mobileSearch: normalizeMobile(mobileNumber),
      })
      .returning();
    return appointment;
  }

  /* ------------------------------------------------------ payload shapes -- */

  const lineOf = (product: Product, quantity: number, rate: number, overrides: Record<string, unknown> = {}) => ({
    itemId: product.item.id,
    subItemId: product.subItem.id,
    quantity,
    rate,
    ...overrides,
  });
  const billOf = (bookId: string, items: unknown[], overrides: Record<string, unknown> = {}) => ({
    bookId,
    billDate: '2026-09-23',
    customerName: 'Ramesh Patel',
    mobileNumber: '9876543210',
    items,
    ...overrides,
  });
  const updateOf = (items: unknown[], overrides: Record<string, unknown> = {}) => {
    const body = billOf('unused', items, overrides) as Record<string, unknown>;
    delete body.bookId;
    return body;
  };

  /* ---------------------------------------------------------- DB probes -- */

  /** The number the book will hand out next — the counter no read and no edit may move. */
  const nextNumberOf = async (bookId: string) => {
    const [row] = await db.select({ next: schema.books.nextBillNumber }).from(schema.books).where(eq(schema.books.id, bookId));
    return row?.next ?? null;
  };
  /** The lines as POSTGRES holds them, so the stored decimal representation can be asserted. */
  const storedLines = async (billId: string) => db.select().from(schema.billItems).where(eq(schema.billItems.billId, billId)).orderBy(asc(schema.billItems.lineNumber));
  const storedBill = async (billId: string) => (await db.select().from(schema.bills).where(eq(schema.bills.id, billId)))[0];

  /* ------------------------------------------------------------- state -- */

  let tenantAId = '';
  let tokenA = '';
  let tokenAReadOnly = '';
  let bookA: Awaited<ReturnType<typeof seedBook>>;
  /** 18% GST, HSN 9983, master rate 100.00. */
  let productA: Product;
  let tenantBId = '';
  let tokenB = '';
  let bookB: Awaited<ReturnType<typeof seedBook>>;
  let productB: Product;
  let billB: Bill;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.PORT = '0'; // server.ts boots a listener on import; keep it off a real port
    ({ and, asc, eq, inArray } = await import('drizzle-orm'));
    const client = await import('../db/client');
    // Fail closed before the first write: the pool must really be on the throwaway database.
    await (await import('../test-support/dbGuard')).assertTestDatabase(client, TEST_DB);
    db = client.db;
    sqlClient = client.sql;
    schema = client.schema;
    ({ allocateBillNumber } = await import('../services/billNumbers'));
    app = await (await import('../server')).buildApp();
    await app.ready();

    ({ tenantId: tenantAId, token: tokenA } = await seedTenant('bill-tenant-a'));
    tokenAReadOnly = await seedUser(tenantAId, 'bill-tenant-a-readonly', { operations_billing: ['read'] });
    bookA = await seedBook(tenantAId);
    productA = await seedProduct(tenantAId);

    ({ tenantId: tenantBId, token: tokenB } = await seedTenant('bill-tenant-b'));
    bookB = await seedBook(tenantBId);
    productB = await seedProduct(tenantBId);
    billB = await created(tokenB, billOf(bookB.id, [lineOf(productB, 1, 100)], { customerName: 'Tenant B Customer' }));
  });

  afterAll(async () => {
    if (tenantIds.length) {
      // Lines first, then the documents, then the masters they reference (those FKs are
      // RESTRICT on purpose), then the tenant's own rows.
      // A next-visit appointment points at its bill; detach before the bills go (deleteBill does the same).
      await db.update(schema.appointments).set({ sourceBillId: null }).where(inArray(schema.appointments.tenantId, tenantIds));
      await db.delete(schema.billItems).where(inArray(schema.billItems.tenantId, tenantIds));
      await db.delete(schema.bills).where(inArray(schema.bills.tenantId, tenantIds));
      await db.delete(schema.appointments).where(inArray(schema.appointments.tenantId, tenantIds));
      await db.delete(schema.subItems).where(inArray(schema.subItems.tenantId, tenantIds));
      await db.delete(schema.items).where(inArray(schema.items.tenantId, tenantIds));
      await db.delete(schema.books).where(inArray(schema.books.tenantId, tenantIds));
      await db.delete(schema.documentCounters).where(inArray(schema.documentCounters.tenantId, tenantIds));
      await db.delete(schema.activityLogs).where(inArray(schema.activityLogs.tenantId, tenantIds));
      await db.delete(schema.users).where(inArray(schema.users.tenantId, tenantIds));
      await db.delete(schema.roles).where(inArray(schema.roles.tenantId, tenantIds));
      await db.delete(schema.tenants).where(inArray(schema.tenants.id, tenantIds));
    }
    await app?.close();
    await sqlClient?.end();
  });

  /* ------------------------------------------------------------ numbering -- */

  describe('the bill number series', () => {
    it('starts a book at the number its series was configured to start from', async () => {
      const book = await seedBook(tenantAId, { seriesStartsAt: 501 });
      expect((await created(tokenA, billOf(book.id, [lineOf(productA, 1, 100)]))).billNumber).toBe(501);
    });

    it('numbers the next bill in the same book one higher', async () => {
      const book = await seedBook(tenantAId, { seriesStartsAt: 501 });
      const first = await created(tokenA, billOf(book.id, [lineOf(productA, 1, 100)]));
      const second = await created(tokenA, billOf(book.id, [lineOf(productA, 1, 100)]));
      expect([first.billNumber, second.billNumber]).toEqual([501, 502]);
    });

    /** A Book IS the series, so two books of the same tenant each hold their own Bill No. 1. */
    it('lets two books each hold a Bill No. 1', async () => {
      const one = await seedBook(tenantAId);
      const two = await seedBook(tenantAId);
      const billOne = await created(tokenA, billOf(one.id, [lineOf(productA, 1, 100)]));
      const billTwo = await created(tokenA, billOf(two.id, [lineOf(productA, 1, 100)]));
      expect([billOne.billNumber, billTwo.billNumber]).toEqual([1, 1]);
      expect(billOne.id).not.toBe(billTwo.id);
      expect((await detail(tokenA, billOne.id)).bookNumber).toBe(one.bookNumber);
      expect((await detail(tokenA, billTwo.id)).bookNumber).toBe(two.bookNumber);
    });

    /** The counter is a document identity, not a hint: 25 at once still means 1..25 exactly once. */
    it('gives 25 simultaneous creates 25 distinct gapless numbers', async () => {
      const book = await seedBook(tenantAId);
      const bills = await Promise.all(
        Array.from({ length: 25 }, (_, i) => created(tokenA, billOf(book.id, [lineOf(productA, 1, 100)], { customerName: `Race ${i}` }))),
      );
      const numbers = bills.map((b) => b.billNumber).sort((a, b) => a - b);
      expect(new Set(numbers).size).toBe(25);
      expect(numbers).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      expect(await nextNumberOf(book.id)).toBe(26);
    });

    /**
     * The allocator runs inside the caller's transaction, so a bill that fails after taking a
     * number rolls the counter back with it instead of burning one.
     */
    it('does not consume a number when the surrounding transaction fails', async () => {
      const book = await seedBook(tenantAId, { seriesStartsAt: 10 });
      await expect(
        db.transaction(async (tx) => {
          await allocateBillNumber(tx, tenantAId, book.id);
          throw new Error('rolled back on purpose');
        }),
      ).rejects.toThrow('rolled back on purpose');
      expect(await nextNumberOf(book.id)).toBe(10);
    });

    it('does not consume a number when the bill is rejected', async () => {
      const book = await seedBook(tenantAId);
      const foreign = await seedProduct(tenantAId);
      // A product that hangs off a different item — refused before the number is taken.
      const res = await post(tokenA, billOf(book.id, [{ itemId: productA.item.id, subItemId: foreign.subItem.id, quantity: 1, rate: 100 }]));
      expect(res.statusCode).toBe(400);
      expect(await nextNumberOf(book.id)).toBe(1);
    });

    /** Opening the list or a bill must never spend a number — nothing previews one. */
    it('allocates nothing when bills are merely read', async () => {
      const book = await seedBook(tenantAId);
      const bill = await created(tokenA, billOf(book.id, [lineOf(productA, 1, 100)]));
      const before = await nextNumberOf(book.id);
      await get(tokenA);
      await get(tokenA, `/${bill.id}`);
      expect(await nextNumberOf(book.id)).toBe(before);
    });

    it('allocates no second number when a bill is updated', async () => {
      const book = await seedBook(tenantAId);
      const bill = await created(tokenA, billOf(book.id, [lineOf(productA, 1, 100)]));
      const before = await nextNumberOf(book.id);
      const res = await put(tokenA, bill.id, updateOf([lineOf(productA, 2, 100)], { customerName: 'Edited' }));
      expect(res.statusCode).toBe(200);
      expect((res.json().data as Bill).billNumber).toBe(bill.billNumber);
      expect(await nextNumberOf(book.id)).toBe(before);
    });

    /**
     * An issued number is spent. If Bill No. 2 is deleted the next bill is still 3 — reusing 2
     * would give a second document the identity of one that may already have been printed.
     */
    it('never rewinds the counter when a bill is deleted', async () => {
      const book = await seedBook(tenantAId);
      const first = await created(tokenA, billOf(book.id, [lineOf(productA, 1, 100)]));
      const second = await created(tokenA, billOf(book.id, [lineOf(productA, 1, 100)]));
      expect((await del(tokenA, second.id)).statusCode).toBe(200);
      const third = await created(tokenA, billOf(book.id, [lineOf(productA, 1, 100)]));
      expect([first.billNumber, second.billNumber, third.billNumber]).toEqual([1, 2, 3]);
      expect(await nextNumberOf(book.id)).toBe(4);
    });
  });

  /* ----------------------------------------------------------------- book -- */

  describe('the book a bill is numbered under', () => {
    /** Deactivating a book is how the studio closes a series, so nothing new may go into it. */
    it('refuses an inactive book for a new bill', async () => {
      const book = await seedBook(tenantAId, { isActive: false });
      const res = await post(tokenA, billOf(book.id, [lineOf(productA, 1, 100)]));
      expect(res.statusCode).toBe(400);
      expect(await nextNumberOf(book.id)).toBe(1);
    });

    it('refuses a book belonging to another tenant', async () => {
      const before = await nextNumberOf(bookB.id);
      expect((await post(tokenA, billOf(bookB.id, [lineOf(productA, 1, 100)]))).statusCode).toBe(400);
      expect(await nextNumberOf(bookB.id)).toBe(before);
    });

    /**
     * Changing the book would move the bill into another series and make it another document.
     * The update schema has no such field, so the payload loses it in validation.
     */
    it('ignores a bookId sent in an update payload', async () => {
      const other = await seedBook(tenantAId);
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 100)]));
      const res = await put(tokenA, bill.id, { ...updateOf([lineOf(productA, 1, 100)]), bookId: other.id });
      expect(res.statusCode).toBe(200);
      const reloaded = await detail(tokenA, bill.id);
      expect(reloaded.bookId).toBe(bill.bookId);
      expect(reloaded.billNumber).toBe(bill.billNumber);
      expect(reloaded.bookNumber).toBe(bookA.bookNumber);
      expect(await nextNumberOf(other.id)).toBe(1);
    });

    /** An edit does not re-check the book: a series closed later must not make its own history unsaveable. */
    it('still lets an existing bill be edited after its book is deactivated', async () => {
      const book = await seedBook(tenantAId);
      const bill = await created(tokenA, billOf(book.id, [lineOf(productA, 1, 100)]));
      await db.update(schema.books).set({ isActive: false }).where(eq(schema.books.id, book.id));
      expect((await put(tokenA, bill.id, updateOf([lineOf(productA, 1, 150)], { customerName: 'Corrected' }))).statusCode).toBe(200);
    });
  });

  /* ---------------------------------------------------------- appointment -- */

  describe('the booking a bill came from', () => {
    it('creates a walk-in bill with no appointment at all', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 100)]));
      expect(bill.appointmentId).toBeNull();
      expect(bill.appointmentNumber).toBeNull();
    });

    it('links a booking of the same tenant and reports its number', async () => {
      const appointment = await seedAppointment(tenantAId);
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 100)], { appointmentId: appointment.id }));
      expect(bill.appointmentId).toBe(appointment.id);
      expect((await detail(tokenA, bill.id)).appointmentNumber).toBe(appointment.appointmentNumber);
    });

    it('refuses a booking belonging to another tenant', async () => {
      const foreign = await seedAppointment(tenantBId);
      expect((await post(tokenA, billOf(bookA.id, [lineOf(productA, 1, 100)], { appointmentId: foreign.id }))).statusCode).toBe(400);
    });

    /** A bill is history: its customer fields are its own snapshot, not a view of the booking. */
    describe('the customer snapshot', () => {
      let appointment: Awaited<ReturnType<typeof seedAppointment>>;
      let bill: Bill;

      beforeAll(async () => {
        appointment = await seedAppointment(tenantAId, { customerName: 'Booking Name', mobileNumber: '9800000001' });
        bill = await created(
          tokenA,
          billOf(bookA.id, [lineOf(productA, 1, 100)], { appointmentId: appointment.id, customerName: 'Bill Name', mobileNumber: '9811111111', babyName: 'Aarav' }),
        );
      });

      it('stores what the operator confirmed on the bill, not what the booking says', async () => {
        expect(bill).toMatchObject({ customerName: 'Bill Name', mobileNumber: '9811111111', babyName: 'Aarav' });
      });

      it('leaves the saved bill untouched when the booking is edited afterwards', async () => {
        await db.update(schema.appointments).set({ customerName: 'Renamed Later', mobileNumber: '9999999999' }).where(eq(schema.appointments.id, appointment.id));
        expect(await detail(tokenA, bill.id)).toMatchObject({ customerName: 'Bill Name', mobileNumber: '9811111111' });
      });
    });
  });

  /* ------------------------------------------------- items and snapshots -- */

  describe('the masters a line is built from', () => {
    it('accepts an item together with one of its own products', async () => {
      const res = await post(tokenA, billOf(bookA.id, [lineOf(productA, 1, 100)]));
      expect(res.statusCode).toBe(200);
    });

    /** Only the database knows which item a product hangs off; the browser is never trusted with it. */
    it('refuses a product that belongs to a different item', async () => {
      const other = await seedProduct(tenantAId);
      const res = await post(tokenA, billOf(bookA.id, [{ itemId: productA.item.id, subItemId: other.subItem.id, quantity: 1, rate: 100 }]));
      expect(res.statusCode).toBe(400);
    });

    it('refuses an item belonging to another tenant', async () => {
      expect((await post(tokenA, billOf(bookA.id, [lineOf(productB, 1, 100)]))).statusCode).toBe(400);
    });

    it('refuses a product belonging to another tenant', async () => {
      const res = await post(tokenA, billOf(bookA.id, [{ itemId: productA.item.id, subItemId: productB.subItem.id, quantity: 1, rate: 100 }]));
      expect(res.statusCode).toBe(400);
    });

    it('refuses an inactive item on a new line', async () => {
      const retired = await seedProduct(tenantAId, { itemActive: false });
      expect((await post(tokenA, billOf(bookA.id, [lineOf(retired, 1, 100)]))).statusCode).toBe(400);
    });

    it('refuses an inactive product on a new line', async () => {
      const retired = await seedProduct(tenantAId, { productActive: false });
      expect((await post(tokenA, billOf(bookA.id, [lineOf(retired, 1, 100)]))).statusCode).toBe(400);
    });

    it('snapshots the item name, product name, HSN and GST rate, and stores what was typed', async () => {
      const product = await seedProduct(tenantAId, { itemName: uniqueName('Album'), hsnCode: '9989', gstRate: '12.00', productName: uniqueName('Premium'), rate: '250.00' });
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(product, 2, 300, { remark: 'Matte finish' })]));
      expect(bill.items[0]).toMatchObject({
        itemNameSnapshot: product.item.itemName,
        subItemNameSnapshot: product.subItem.productName,
        hsnCodeSnapshot: '9989',
        gstRateSnapshot: 12,
        quantity: 2,
        // The master's 250.00 is only a default; the bill charges what was saved on the line.
        rate: 300,
        remark: 'Matte finish',
      });
    });

    describe('after Item Master changes', () => {
      let product: Product;
      let bill: Bill;

      beforeAll(async () => {
        product = await seedProduct(tenantAId, { itemName: uniqueName('Before'), hsnCode: '9983', gstRate: '12.00' });
        bill = await created(tokenA, billOf(bookA.id, [lineOf(product, 1, 100)]));
        await db.update(schema.items).set({ itemName: uniqueName('After'), hsnCode: '0000', gstRate: '28.00' }).where(eq(schema.items.id, product.item.id));
      });

      it('leaves an issued bill reading exactly as it was issued', async () => {
        const reloaded = await detail(tokenA, bill.id);
        expect(reloaded.items[0]).toMatchObject({ itemNameSnapshot: product.item.itemName, hsnCodeSnapshot: '9983', gstRateSnapshot: 12, gstAmount: 12, lineTotal: 112 });
        expect(reloaded.grandTotal).toBe(112);
      });

      /** Re-saving a bill is an edit of that document, not a repricing of it. */
      it('keeps the original snapshot when the bill is re-saved', async () => {
        const res = await put(tokenA, bill.id, updateOf([lineOf(product, 2, 100)], { customerName: 'Edited' }));
        expect(res.statusCode).toBe(200);
        const reloaded = await detail(tokenA, bill.id);
        expect(reloaded.items[0]).toMatchObject({ gstRateSnapshot: 12, itemNameSnapshot: product.item.itemName, hsnCodeSnapshot: '9983' });
        expect(reloaded).toMatchObject({ subTotal: 200, gstAmount: 24, grandTotal: 224 });
      });

      /**
       * Changing what a line COSTS is not changing what it IS. The bill goes on charging the
       * tax its line was raised under, on the new rate.
       */
      it('taxes a re-rated line at its own snapshot, not at the master’s rate today', async () => {
        const own = await seedProduct(tenantAId, { gstRate: '12.00' });
        const raised = await created(tokenA, billOf(bookA.id, [lineOf(own, 1, 100)]));
        await db.update(schema.items).set({ gstRate: '18.00' }).where(eq(schema.items.id, own.item.id));

        await put(tokenA, raised.id, updateOf([lineOf(own, 1, 500)]));
        const reloaded = await detail(tokenA, raised.id);
        expect(reloaded.items[0]).toMatchObject({ rate: 500, gstRateSnapshot: 12, taxableAmount: 500, gstAmount: 60, lineTotal: 560 });
      });
    });

    /**
     * What happens on an edit when the masters have moved on. The rule is that a line the
     * bill ALREADY has keeps its snapshot, and anything genuinely new on the bill takes the
     * master as it stands today — so one edited bill may legitimately carry an old line at
     * 12% beside a new one at 18%.
     */
    describe('editing a bill after Item Master has changed', () => {
      it('gives a newly added product the master’s CURRENT values, and leaves the old line alone', async () => {
        const original = await seedProduct(tenantAId, { gstRate: '12.00', hsnCode: '9983' });
        const bill = await created(tokenA, billOf(bookA.id, [lineOf(original, 1, 100)]));
        // Both masters move after the bill exists.
        await db.update(schema.items).set({ gstRate: '28.00' }).where(eq(schema.items.id, original.item.id));
        const added = await seedProduct(tenantAId, { gstRate: '18.00', hsnCode: '9989' });

        await put(tokenA, bill.id, updateOf([lineOf(original, 1, 100), lineOf(added, 1, 100)]));
        const reloaded = await detail(tokenA, bill.id);
        expect(reloaded.items.map((l) => l.gstRateSnapshot)).toEqual([12, 18]);
        expect(reloaded.items.map((l) => l.gstAmount)).toEqual([12, 18]);
        expect(reloaded).toMatchObject({ subTotal: 200, gstAmount: 30, grandTotal: 230 });
      });

      /** Changing which PRODUCT a line bills makes it a different commercial line. */
      it('takes a fresh snapshot when a line’s product is changed for another', async () => {
        const first = await seedProduct(tenantAId, { itemName: uniqueName('First'), gstRate: '12.00', hsnCode: '9983' });
        const second = await seedProduct(tenantAId, { itemName: uniqueName('Second'), gstRate: '5.00', hsnCode: '9971' });
        const bill = await created(tokenA, billOf(bookA.id, [lineOf(first, 1, 100)]));

        await put(tokenA, bill.id, updateOf([lineOf(second, 1, 100)]));
        const reloaded = await detail(tokenA, bill.id);
        expect(reloaded.items).toHaveLength(1);
        expect(reloaded.items[0]).toMatchObject({
          subItemId: second.subItem.id,
          itemNameSnapshot: second.item.itemName,
          hsnCodeSnapshot: '9971',
          gstRateSnapshot: 5,
          gstAmount: 5,
        });
      });

      /**
       * A second line for a product the bill ALREADY carries takes that bill's own rate, not
       * today's — deliberately, so one invoice can never print two different GST rates for
       * the same product. The cost is documented in `resolveLines`; the benefit is a document
       * that adds up on paper.
       */
      it('keeps one rate per product on a bill, even for a line added later', async () => {
        const product = await seedProduct(tenantAId, { gstRate: '12.00' });
        const bill = await created(tokenA, billOf(bookA.id, [lineOf(product, 1, 100)]));
        await db.update(schema.items).set({ gstRate: '18.00' }).where(eq(schema.items.id, product.item.id));

        await put(tokenA, bill.id, updateOf([lineOf(product, 1, 100), lineOf(product, 1, 200)]));
        expect((await detail(tokenA, bill.id)).items.map((l) => l.gstRateSnapshot)).toEqual([12, 12]);
      });

      /** A discount changes what is CHARGED, never what the line is a record of. */
      it('leaves every snapshot alone when only the discount changes', async () => {
        const product = await seedProduct(tenantAId, { gstRate: '12.00', hsnCode: '9983' });
        const bill = await created(tokenA, billOf(bookA.id, [lineOf(product, 1, 1000)]));
        await db.update(schema.items).set({ gstRate: '28.00', hsnCode: '0000' }).where(eq(schema.items.id, product.item.id));

        await put(tokenA, bill.id, updateOf([lineOf(product, 1, 1000)], { discountType: 'PERCENT', discountValue: 10 }));
        const reloaded = await detail(tokenA, bill.id);
        expect(reloaded.items[0]).toMatchObject({ gstRateSnapshot: 12, hsnCodeSnapshot: '9983', discountAllocated: 100, taxableAmount: 900, gstAmount: 108 });
        expect(reloaded).toMatchObject({ discountAmount: 100, netTaxable: 900, grandTotal: 1008 });
      });
    });

    it('numbers the lines 1..n in payload order and keeps that order on reload', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 10), lineOf(productA, 1, 20), lineOf(productA, 1, 30)]));
      expect(bill.items.map((l) => [l.lineNumber, l.rate])).toEqual([
        [1, 10],
        [2, 20],
        [3, 30],
      ]);
      const reloaded = await detail(tokenA, bill.id);
      expect(reloaded.items.map((l) => l.lineNumber)).toEqual([1, 2, 3]);
      expect(reloaded.items.map((l) => l.rate)).toEqual([10, 20, 30]);
    });

    /** The client sends identifiers and typed values. Everything else it sends is noise. */
    it('ignores client-sent snapshots and amounts and stores the server values', async () => {
      const bill = await created(
        tokenA,
        billOf(
          bookA.id,
          [
            lineOf(productA, 2, 100, {
              itemNameSnapshot: 'Forged Item',
              subItemNameSnapshot: 'Forged Product',
              hsnCodeSnapshot: '0000',
              gstRateSnapshot: 0,
              taxableAmount: 1,
              gstAmount: 1,
              lineTotal: 1,
            }),
          ],
          { billNumber: 9999, subTotal: 1, gstAmount: 1, grandTotal: 1 },
        ),
      );
      expect(bill.items[0]).toMatchObject({
        itemNameSnapshot: productA.item.itemName,
        subItemNameSnapshot: productA.subItem.productName,
        hsnCodeSnapshot: productA.item.hsnCode,
        gstRateSnapshot: 18,
        taxableAmount: 200,
        gstAmount: 36,
        lineTotal: 236,
      });
      expect(bill).toMatchObject({ subTotal: 200, gstAmount: 36, grandTotal: 236 });
      expect(bill.billNumber).not.toBe(9999);
      expect(await storedBill(bill.id)).toMatchObject({ subTotal: '200.00', gstAmount: '36.00', grandTotal: '236.00' });
    });
  });

  /* ------------------------------------------------------ what is stored -- */

  describe('the money a bill stores', () => {
    it('stores quantity x rate and its GST at the scale the columns hold', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 5, 100)]));
      const [stored] = await storedLines(bill.id);
      expect(stored).toMatchObject({ quantity: '5.00', rate: '100.00', gstRateSnapshot: '18.00', taxableAmount: '500.00', gstAmount: '90.00', lineTotal: '590.00' });
      expect(await storedBill(bill.id)).toMatchObject({ subTotal: '500.00', gstAmount: '90.00', grandTotal: '590.00' });
    });

    it('taxes each line at its own item rate when a bill mixes GST slabs', async () => {
      const at5 = await seedProduct(tenantAId, { gstRate: '5.00' });
      const at0 = await seedProduct(tenantAId, { gstRate: '0.00' });
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 100), lineOf(at5, 2, 50), lineOf(at0, 1, 10)]));
      expect(bill.items.map((l) => l.gstAmount)).toEqual([18, 5, 0]);
      expect(bill).toMatchObject({ subTotal: 210, gstAmount: 23, grandTotal: 233 });
    });

    it('charges no tax on a 0% GST item but still records its 0 rate', async () => {
      const exempt = await seedProduct(tenantAId, { gstRate: '0.00' });
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(exempt, 3, 75)]));
      expect(bill.items[0]).toMatchObject({ gstRateSnapshot: 0, taxableAmount: 225, gstAmount: 0, lineTotal: 225 });
      expect(bill.grandTotal).toBe(225);
    });

    it('rounds a fractional line half-up before it is stored', async () => {
      const at12 = await seedProduct(tenantAId, { gstRate: '12.00' });
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(at12, 2.5, 199.99)]));
      const [stored] = await storedLines(bill.id);
      expect(stored).toMatchObject({ quantity: '2.50', rate: '199.99', taxableAmount: '499.98', gstAmount: '60.00', lineTotal: '559.98' });
      expect(bill.grandTotal).toBe(559.98);
    });

    it.each([
      ['quantity', { quantity: 1.005, rate: 100 }],
      ['rate', { quantity: 1, rate: 33.333 }],
    ])('refuses a %s with three decimals', async (_field, values) => {
      expect((await post(tokenA, billOf(bookA.id, [{ itemId: productA.item.id, subItemId: productA.subItem.id, ...values }]))).statusCode).toBe(400);
    });

    /** WITHOUT_GST charges nothing, but the line keeps the Item Master rate it was built from. */
    it('charges a WITHOUT_GST bill no tax while keeping the GST snapshot on its lines', async () => {
      // The book decides the tax mode: a Without GST series issues Without GST bills.
      const bill = await created(tokenA, billOf((await seedBook(tenantAId, { seriesType: 'WITHOUT_GST' })).id, [lineOf(productA, 2, 100)]));
      expect(bill.items[0]).toMatchObject({ gstRateSnapshot: 18, taxableAmount: 200, gstAmount: 0, lineTotal: 200 });
      expect(bill).toMatchObject({ taxMode: 'WITHOUT_GST', subTotal: 200, gstAmount: 0, grandTotal: 200 });
    });

    it('makes the header totals the sum of the stored lines', async () => {
      const at5 = await seedProduct(tenantAId, { gstRate: '5.00' });
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 100), lineOf(at5, 2, 50), lineOf(productA, 3, 33.33)]));
      const lines = await storedLines(bill.id);
      expect(bill.subTotal).toBe(lines.reduce((t, l) => t + Number(l.taxableAmount), 0));
      expect(bill.gstAmount).toBe(lines.reduce((t, l) => t + Number(l.gstAmount), 0));
      expect(bill.grandTotal).toBe(lines.reduce((t, l) => t + Number(l.lineTotal), 0));
    });
  });

  /* -------------------------------------------------------- the discount -- */

  /**
   * The discount end to end: what the API accepts, what it works out, what it writes, and
   * what it refuses to take from a client. The arithmetic itself is pinned in section A —
   * what is proved here is that the stored bill really is the answer that calculation gives.
   */
  describe('the discount a bill stores', () => {
    it('stores a fixed discount as chosen, and what it came to', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 1000)], { discountType: 'AMOUNT', discountValue: 100 }));
      expect(bill).toMatchObject({ discountType: 'AMOUNT', discountValue: 100, discountAmount: 100, subTotal: 1000, netTaxable: 900, gstAmount: 162, grandTotal: 1062 });
      expect(await storedBill(bill.id)).toMatchObject({ discountType: 'AMOUNT', discountValue: '100.00', discountAmount: '100.00', subTotal: '1000.00', grandTotal: '1062.00' });
      const [stored] = await storedLines(bill.id);
      expect(stored).toMatchObject({ discountAllocated: '100.00', taxableAmount: '900.00', gstAmount: '162.00', lineTotal: '1062.00' });
    });

    it('keeps the percentage that was chosen as well as the money it came to', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 4, 1000), lineOf(productA, 2, 3000)], { discountType: 'PERCENT', discountValue: 10 }));
      expect(bill).toMatchObject({ discountType: 'PERCENT', discountValue: 10, discountAmount: 1000, subTotal: 10000, netTaxable: 9000, gstAmount: 1620, grandTotal: 10620 });
    });

    /** The requirement's own worked example, end to end. */
    it('allocates a discount across mixed GST slabs before taxing them', async () => {
      const at5 = await seedProduct(tenantAId, { gstRate: '5.00' });
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(at5, 1, 1000), lineOf(productA, 1, 2000)], { discountType: 'AMOUNT', discountValue: 300 }));
      expect(bill.items.map((l) => [l.grossTaxable, l.discountAllocated, l.taxableAmount, l.gstAmount, l.lineTotal])).toEqual([
        [1000, 100, 900, 45, 945],
        [2000, 200, 1800, 324, 2124],
      ]);
      expect(bill).toMatchObject({ subTotal: 3000, discountAmount: 300, netTaxable: 2700, gstAmount: 369, grandTotal: 3069 });
    });

    /** The property the allocation exists to guarantee, asserted against real stored rows. */
    it('allocates exactly the bill discount across the lines, to the paisa', async () => {
      const bill = await created(
        tokenA,
        billOf(bookA.id, [lineOf(productA, 1, 100), lineOf(productA, 1, 100), lineOf(productA, 1, 100)], { discountType: 'AMOUNT', discountValue: 100 }),
      );
      const lines = await storedLines(bill.id);
      expect(lines.map((l) => l.discountAllocated)).toEqual(['33.34', '33.33', '33.33']);
      expect(lines.reduce((t, l) => t + Math.round(Number(l.discountAllocated) * 100), 0)).toBe(Math.round(bill.discountAmount * 100));
    });

    it('reports a net taxable value that is exactly the sub total less the discount', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 3, 33.33)], { discountType: 'PERCENT', discountValue: 7.77 }));
      expect(bill.netTaxable).toBe(Number((bill.subTotal - bill.discountAmount).toFixed(2)));
      expect(bill.items.reduce((t, l) => t + l.taxableAmount, 0)).toBe(bill.netTaxable);
      expect(bill.items.every((l) => l.grossTaxable === Number((l.taxableAmount + l.discountAllocated).toFixed(2)))).toBe(true);
    });

    it('returns a rate-wise GST summary grouped off the bill’s own lines', async () => {
      const at5 = await seedProduct(tenantAId, { gstRate: '5.00' });
      const at0 = await seedProduct(tenantAId, { gstRate: '0.00' });
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(at5, 1, 1000), lineOf(productA, 1, 2000), lineOf(at0, 1, 500)], { discountType: 'AMOUNT', discountValue: 350 }));
      expect(bill.gstSummary.map((r) => r.gstRate)).toEqual([0, 5, 18]);
      expect(bill.gstSummary.reduce((t, r) => t + r.taxableAmount, 0)).toBe(bill.netTaxable);
      expect(bill.gstSummary.reduce((t, r) => t + r.gstAmount, 0)).toBe(bill.gstAmount);
      // Reloading regroups from the stored lines and must say exactly the same thing.
      expect((await detail(tokenA, bill.id)).gstSummary).toEqual(bill.gstSummary);
    });

    it('discounts a WITHOUT_GST bill while still charging no tax', async () => {
      const bill = await created(tokenA, billOf((await seedBook(tenantAId, { seriesType: 'WITHOUT_GST' })).id, [lineOf(productA, 1, 1000)], { discountType: 'AMOUNT', discountValue: 100 }));
      expect(bill).toMatchObject({ subTotal: 1000, discountAmount: 100, netTaxable: 900, gstAmount: 0, grandTotal: 900 });
      // The snapshot survives: it records the item, not a tax that was charged.
      expect(bill.items[0]).toMatchObject({ gstRateSnapshot: 18, gstAmount: 0, lineTotal: 900 });
    });

    it('takes a bill to zero at 100% without going negative', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 1000)], { discountType: 'PERCENT', discountValue: 100 }));
      expect(bill).toMatchObject({ discountAmount: 1000, netTaxable: 0, gstAmount: 0, grandTotal: 0 });
      // Still a real document: it took a number and it reloads.
      expect((await detail(tokenA, bill.id)).billNumber).toBe(bill.billNumber);
    });

    it.each([
      ['a percentage above 100', { discountType: 'PERCENT', discountValue: 101 }],
      ['an amount larger than the bill', { discountType: 'AMOUNT', discountValue: 1000.01 }],
      ['a negative discount', { discountType: 'AMOUNT', discountValue: -1 }],
      ['a discount with three decimals', { discountType: 'AMOUNT', discountValue: 10.005 }],
      ['an unknown discount type', { discountType: 'FLAT', discountValue: 10 }],
    ])('refuses %s', async (_case, discount) => {
      expect((await post(tokenA, billOf(bookA.id, [lineOf(productA, 1, 1000)], discount))).statusCode).toBe(400);
    });

    /** A refused discount must not have cost the book a number on its way to being refused. */
    it('does not burn a bill number on a refused discount', async () => {
      const book = await seedBook(tenantAId, { seriesStartsAt: 700 });
      expect((await post(tokenA, billOf(book.id, [lineOf(productA, 1, 100)], { discountType: 'PERCENT', discountValue: 101 }))).statusCode).toBe(400);
      expect(await nextNumberOf(book.id)).toBe(700);
    });

    /** The client states the KIND and the NUMBER. Everything the money depends on is ours. */
    it('ignores a discount amount, a net taxable and a line allocation sent by a client', async () => {
      const bill = await created(
        tokenA,
        billOf(bookA.id, [lineOf(productA, 1, 1000, { discountAllocated: 999, taxableAmount: 1, grossTaxable: 5 })], {
          discountType: 'AMOUNT',
          discountValue: 100,
          discountAmount: 999,
          netTaxable: 1,
          grandTotal: 1,
        }),
      );
      expect(bill).toMatchObject({ discountAmount: 100, netTaxable: 900, grandTotal: 1062 });
      expect(bill.items[0]).toMatchObject({ discountAllocated: 100, taxableAmount: 900 });
    });

    /** A bill saved before this phase existed, and one saved now without a discount, agree. */
    it('stores no discount when a payload carries none, leaving the totals untouched', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 2, 100)]));
      expect(bill).toMatchObject({ discountType: 'NONE', discountValue: 0, discountAmount: 0, subTotal: 200, netTaxable: 200, gstAmount: 36, grandTotal: 236 });
      expect((await storedLines(bill.id))[0]).toMatchObject({ discountAllocated: '0.00', taxableAmount: '200.00' });
    });

    it('recalculates the whole bill when a discount is added by an edit, without renumbering it', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 1000)]));
      const res = await put(tokenA, bill.id, updateOf([lineOf(productA, 1, 1000)], { discountType: 'AMOUNT', discountValue: 250 }));
      expect(res.statusCode).toBe(200);
      const reloaded = await detail(tokenA, bill.id);
      expect(reloaded).toMatchObject({ billNumber: bill.billNumber, discountAmount: 250, netTaxable: 750, gstAmount: 135, grandTotal: 885 });
    });

    it('restores the full totals when a discount is taken off again', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 1000)], { discountType: 'PERCENT', discountValue: 20 }));
      await put(tokenA, bill.id, updateOf([lineOf(productA, 1, 1000)], { discountType: 'NONE' }));
      const reloaded = await detail(tokenA, bill.id);
      expect(reloaded).toMatchObject({ discountType: 'NONE', discountValue: 0, discountAmount: 0, netTaxable: 1000, grandTotal: 1180 });
      expect((await storedLines(bill.id))[0].discountAllocated).toBe('0.00');
    });
  });

  /* ------------------------------------------------ create, read, update -- */

  describe('creating, reading, updating and deleting a bill', () => {
    it('creates a bill and returns it with its book number and its lines', async () => {
      const res = await post(tokenA, billOf(bookA.id, [lineOf(productA, 1, 100)]));
      expect(res.statusCode).toBe(200);
      const bill = res.json().data as Bill;
      expect(bill.bookNumber).toBe(bookA.bookNumber);
      expect(bill.items).toHaveLength(1);
    });

    it('reads a bill back with its lines in print order', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 10), lineOf(productA, 2, 20)]));
      const reloaded = await detail(tokenA, bill.id);
      expect(reloaded.id).toBe(bill.id);
      expect(reloaded.items.map((l) => l.lineNumber)).toEqual([1, 2]);
    });

    it('returns 404 for a bill that does not exist', async () => {
      expect((await get(tokenA, '/11111111-2222-4333-8444-555555555555')).statusCode).toBe(404);
    });

    /** The lines are replaced as a SET, so removing one really removes it and the totals follow. */
    it('replaces the whole line set and recomputes the totals on update', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 100), lineOf(productA, 1, 200)]));
      expect((await put(tokenA, bill.id, updateOf([lineOf(productA, 3, 50)], { customerName: 'Edited' }))).statusCode).toBe(200);
      const reloaded = await detail(tokenA, bill.id);
      expect(reloaded.items).toHaveLength(1);
      expect(reloaded.items[0]).toMatchObject({ lineNumber: 1, quantity: 3, rate: 50, taxableAmount: 150, gstAmount: 27, lineTotal: 177 });
      expect(reloaded).toMatchObject({ customerName: 'Edited', subTotal: 150, gstAmount: 27, grandTotal: 177 });
    });

    /** One transaction: a rejected edit must not leave the bill half-rewritten. */
    it('leaves the old lines and totals intact when an update is rejected', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 2, 100)]));
      const foreign = await seedProduct(tenantAId);
      const res = await put(tokenA, bill.id, updateOf([lineOf(productA, 1, 10), { itemId: productA.item.id, subItemId: foreign.subItem.id, quantity: 1, rate: 500 }]));
      expect(res.statusCode).toBe(400);
      const reloaded = await detail(tokenA, bill.id);
      expect(reloaded.items).toHaveLength(1);
      expect(reloaded.items[0]).toMatchObject({ quantity: 2, rate: 100 });
      expect(reloaded.grandTotal).toBe(bill.grandTotal);
    });

    it('deletes a bill and its lines with it', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 100), lineOf(productA, 2, 50)]));
      expect((await del(tokenA, bill.id)).statusCode).toBe(200);
      expect((await get(tokenA, `/${bill.id}`)).statusCode).toBe(404);
      expect(await storedLines(bill.id)).toEqual([]);
    });
  });

  /* -------------------------------------------------------------- the list -- */

  describe('the list', () => {
    let token = '';
    let book: Awaited<ReturnType<typeof seedBook>>;
    let product: Product;
    let customer = '';
    let byName: Bill;
    let byMobile: Bill;
    let first: Bill;
    let second: Bill;

    beforeAll(async () => {
      let tenantId = '';
      ({ tenantId, token } = await seedTenant('bill-tenant-list'));
      // A letters-only book number, so a digit search can only be reading a bill number.
      book = await seedBook(tenantId, { bookNumber: uniqueWord('BOOK') });
      product = await seedProduct(tenantId);
      customer = uniqueWord('Customer');
      first = await created(token, billOf(book.id, [lineOf(product, 1, 100)], { billDate: '2030-03-15', customerName: uniqueWord('First') }));
      byName = await created(token, billOf(book.id, [lineOf(product, 1, 100)], { billDate: '2030-04-20', customerName: customer }));
      byMobile = await created(token, billOf(book.id, [lineOf(product, 1, 100)], { billDate: '2030-05-25', customerName: uniqueWord('Mobile'), mobileNumber: '9876543277' }));
      second = await created(token, billOf(book.id, [lineOf(product, 1, 100)], { billDate: '2030-05-25', customerName: uniqueWord('Same') }));
    });

    it('finds a bill by its exact number', async () => {
      expect(numbersOf(await get(token, `?search=${byName.billNumber}`))).toEqual([byName.billNumber]);
    });

    it('finds a bill by customer name', async () => {
      expect(numbersOf(await get(token, `?search=${customer}`))).toEqual([byName.billNumber]);
    });

    /** However the number is searched for. */
    it.each(['9876543277', '+91 98765 43277', '98765-43277'])('finds a bill searching its mobile as %p', async (term) => {
      expect(numbersOf(await get(token, `?search=${encodeURIComponent(term)}`))).toContain(byMobile.billNumber);
    });

    /**
     * Regression guard: a twelve-digit mobile typed into the search box is all digits, but
     * comparing it to the `integer` bill number would ask Postgres to cast out of range and
     * fail the whole request. It has to be read as a phone number instead.
     */
    it('survives a digit string larger than the bill number column holds', async () => {
      const res = await get(token, '?search=919876543277');
      expect(res.statusCode).toBe(200);
      expect(numbersOf(res)).toContain(byMobile.billNumber);
    });

    it('finds every bill of a book by the book number', async () => {
      expect(numbersOf(await get(token, `?search=${book.bookNumber}`)).sort((a, b) => a - b)).toEqual([first, byName, byMobile, second].map((b) => b.billNumber).sort((a, b) => a - b));
    });

    it('filters by bill date', async () => {
      const filters = encodeURIComponent(JSON.stringify([{ field: 'billDate', op: 'equals', value: '2030-03-15' }]));
      expect(numbersOf(await get(token, `?filters=${filters}`))).toEqual([first.billNumber]);
    });

    it('filters by a date range', async () => {
      const filters = encodeURIComponent(JSON.stringify([{ field: 'billDate', op: 'between', value: ['2030-03-01', '2030-04-30'] }]));
      const found = numbersOf(await get(token, `?filters=${filters}`));
      expect(found.sort((a, b) => a - b)).toEqual([first.billNumber, byName.billNumber].sort((a, b) => a - b));
      expect(found).not.toContain(byMobile.billNumber);
    });

    /** Billing work reads newest first, with the bill number as the stable tie-breaker. */
    it('defaults to the latest bill date first, newest number first within a date', async () => {
      expect(numbersOf(await get(token))).toEqual([second.billNumber, byMobile.billNumber, byName.billNumber, first.billNumber]);
    });

    it('paginates without repeating or dropping a row', async () => {
      const page1 = numbersOf(await get(token, '?page=1&limit=2'));
      const page2 = numbersOf(await get(token, '?page=2&limit=2'));
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(new Set([...page1, ...page2]).size).toBe(4);
    });

    it('reports the total independently of the page size', async () => {
      expect((await get(token, '?page=1&limit=2')).json().data.total).toBe(4);
    });
  });

  /* ------------------------------------------------------ tenant isolation -- */

  describe('tenant isolation', () => {
    it("never lists another tenant's bill", async () => {
      expect(rowsOf(await get(tokenA)).map((r) => r.id)).not.toContain(billB.id);
    });

    it("returns 404 for another tenant's bill", async () => {
      expect((await get(tokenA, `/${billB.id}`)).statusCode).toBe(404);
    });

    it("cannot update another tenant's bill", async () => {
      expect((await put(tokenA, billB.id, updateOf([lineOf(productA, 1, 1)], { customerName: 'Hijacked' }))).statusCode).toBe(404);
    });

    it("cannot delete another tenant's bill", async () => {
      expect((await del(tokenA, billB.id)).statusCode).toBe(404);
    });

    it("leaves the other tenant's bill intact after those attempts", async () => {
      expect(await detail(tokenB, billB.id)).toMatchObject({ id: billB.id, customerName: 'Tenant B Customer' });
    });
  });

  /* ------------------------------------------------------------ permissions -- */

  describe('permissions', () => {
    it('lets a read-only user list bills', async () => {
      expect((await get(tokenAReadOnly)).statusCode).toBe(200);
    });

    it('refuses a create without the create action', async () => {
      expect((await post(tokenAReadOnly, billOf(bookA.id, [lineOf(productA, 1, 100)]))).statusCode).toBe(403);
    });

    it('refuses an update without the update action', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 100)]));
      expect((await put(tokenAReadOnly, bill.id, updateOf([lineOf(productA, 1, 100)]))).statusCode).toBe(403);
    });

    it('refuses a delete without the delete action', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 100)]));
      expect((await del(tokenAReadOnly, bill.id)).statusCode).toBe(403);
    });

    it('refuses a user with no billing grant at all', async () => {
      const token = await seedUser(tenantAId, 'bill-tenant-a-nogrant', { masters_books: ['read'] });
      expect((await get(token)).statusCode).toBe(403);
    });

    it('refuses an unauthenticated list', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/bills' })).statusCode).toBe(401);
    });

    it('refuses an unauthenticated create', async () => {
      expect((await app.inject({ method: 'POST', url: '/api/bills', payload: billOf(bookA.id, [lineOf(productA, 1, 100)]) })).statusCode).toBe(401);
    });

    /** A refused create must not have moved the series on its way to the 403. */
    it('spends no bill number on a refused create', async () => {
      const book = await seedBook(tenantAId);
      await post(tokenAReadOnly, billOf(book.id, [lineOf(productA, 1, 100)]));
      expect(await nextNumberOf(book.id)).toBe(1);
    });
  });

  /* ============================================ Book series → tax mode -- */

  describe('the book decides the tax mode', () => {
    it('a With GST book issues a With GST bill without being told', async () => {
      const book = await seedBook(tenantAId, { seriesType: 'WITH_GST' });
      const bill = await created(tokenA, billOf(book.id, [lineOf(productA, 1, 1000)]));
      expect(bill).toMatchObject({ taxMode: 'WITH_GST', subTotal: 1000, gstAmount: 180, grandTotal: 1180 });
    });

    it('a Without GST book issues a Without GST bill — same formula, no tax', async () => {
      const book = await seedBook(tenantAId, { seriesType: 'WITHOUT_GST' });
      const bill = await created(tokenA, billOf(book.id, [lineOf(productA, 1, 1000)], { discountType: 'PERCENT', discountValue: 10 }));
      expect(bill).toMatchObject({ taxMode: 'WITHOUT_GST', subTotal: 1000, discountAmount: 100, netTaxable: 900, gstAmount: 0, grandTotal: 900 });
      expect(bill.items[0]).toMatchObject({ gstRateSnapshot: 18, gstAmount: 0 });
    });

    it('refuses a payload whose tax mode contradicts the book, and takes no number', async () => {
      const book = await seedBook(tenantAId, { seriesType: 'WITH_GST' });
      const res = await post(tokenA, billOf(book.id, [lineOf(productA, 1, 100)], { taxMode: 'WITHOUT_GST' }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details[0].path).toEqual(['taxMode']);
      expect(await nextNumberOf(book.id)).toBe(1);
    });

    it('accepts a payload that names the same tax mode as the book', async () => {
      const book = await seedBook(tenantAId, { seriesType: 'WITHOUT_GST' });
      expect((await post(tokenA, billOf(book.id, [lineOf(productA, 1, 100)], { taxMode: 'WITHOUT_GST' }))).statusCode).toBe(200);
    });

    it('an edit keeps the saved tax mode and refuses another one', async () => {
      const book = await seedBook(tenantAId, { seriesType: 'WITH_GST' });
      const bill = await created(tokenA, billOf(book.id, [lineOf(productA, 1, 100)]));
      expect((await put(tokenA, bill.id, updateOf([lineOf(productA, 1, 100)], { taxMode: 'WITHOUT_GST' }))).statusCode).toBe(400);
      const kept = (await put(tokenA, bill.id, updateOf([lineOf(productA, 2, 100)]))).json().data as Bill;
      expect(kept).toMatchObject({ taxMode: 'WITH_GST', grandTotal: 236 });
    });

    it('a historical bill whose tax mode differs from its book keeps its own on re-save', async () => {
      const book = await seedBook(tenantAId, { seriesType: 'WITH_GST' });
      const bill = await created(tokenA, billOf(book.id, [lineOf(productA, 1, 100)]));
      // A bill issued before books had a series type.
      await db.update(schema.bills).set({ taxMode: 'WITHOUT_GST' }).where(eq(schema.bills.id, bill.id));
      const res = await put(tokenA, bill.id, updateOf([lineOf(productA, 1, 100)]));
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ taxMode: 'WITHOUT_GST', gstAmount: 0, grandTotal: 100 });
    });

    it('a With GST and a Without GST book number independently: each runs 1, 2, 3', async () => {
      const gst = await seedBook(tenantAId, { seriesType: 'WITH_GST' });
      const noGst = await seedBook(tenantAId, { seriesType: 'WITHOUT_GST' });
      const numbers: [number, number][] = [];
      for (let i = 0; i < 3; i++) {
        const a = await created(tokenA, billOf(gst.id, [lineOf(productA, 1, 100)]));
        const b = await created(tokenA, billOf(noGst.id, [lineOf(productA, 1, 100)]));
        numbers.push([a.billNumber, b.billNumber]);
      }
      expect(numbers).toEqual([[1, 1], [2, 2], [3, 3]]);
    });

    it('concurrent bills on two books: each book hands out 1..10 exactly once', async () => {
      const gst = await seedBook(tenantAId, { seriesType: 'WITH_GST' });
      const noGst = await seedBook(tenantAId, { seriesType: 'WITHOUT_GST' });
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => post(tokenA, billOf(i % 2 ? noGst.id : gst.id, [lineOf(productA, 1, 100)]))));
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      const byBook = (id: string) =>
        results
          .map((r) => r.json().data as Bill)
          .filter((b) => b.bookId === id)
          .map((b) => b.billNumber)
          .sort((x, y) => x - y);
      const oneToTen = Array.from({ length: 10 }, (_, i) => i + 1);
      expect(byBook(gst.id)).toEqual(oneToTen);
      expect(byBook(noGst.id)).toEqual(oneToTen);
      expect(await nextNumberOf(gst.id)).toBe(11);
      expect(await nextNumberOf(noGst.id)).toBe(11);
    });
  });

  /* ====================================================== legacy mobile -- */

  /**
   * Bills saved before the ten-digit rule keep their mobile as typed. They stay editable with their
   * own customer key; any real change of mobile must be ten digits.
   */
  describe('a legacy mobile on edit', () => {
    const legacy = async (mobileNumber: string) => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 100)]));
      await db.update(schema.bills).set({ mobileNumber, mobileSearch: normalizeMobile(mobileNumber) }).where(eq(schema.bills.id, bill.id));
      return bill;
    };

    it('a formatted legacy mobile re-saves as its ten-digit key, same customer', async () => {
      const bill = await legacy('+91 98765 43299');
      const res = await put(tokenA, bill.id, updateOf([lineOf(productA, 1, 100)], { mobileNumber: '9876543299' }));
      expect(res.statusCode).toBe(200);
      expect(await storedBill(bill.id)).toMatchObject({ mobileNumber: '9876543299', mobileSearch: '9876543299' });
    });

    it('a nine-digit legacy mobile may be saved back unchanged, but not changed to another non-ten-digit value', async () => {
      const bill = await legacy('98765-4321');
      expect((await put(tokenA, bill.id, updateOf([lineOf(productA, 1, 100)], { mobileNumber: '987654321' }))).statusCode).toBe(200);
      const changed = await put(tokenA, bill.id, updateOf([lineOf(productA, 1, 100)], { mobileNumber: '98765432' }));
      expect(changed.statusCode).toBe(400);
      expect(changed.json().error.details[0].path).toEqual(['mobileNumber']);
      expect((await put(tokenA, bill.id, updateOf([lineOf(productA, 1, 100)], { mobileNumber: '9876543219' }))).statusCode).toBe(200);
    });

    it('a ten-digit bill cannot be edited to a formatted or short mobile', async () => {
      const bill = await created(tokenA, billOf(bookA.id, [lineOf(productA, 1, 100)], { mobileNumber: '9876543288' }));
      expect((await put(tokenA, bill.id, updateOf([lineOf(productA, 1, 100)], { mobileNumber: '98765 43288' }))).statusCode).toBe(400);
      expect((await put(tokenA, bill.id, updateOf([lineOf(productA, 1, 100)], { mobileNumber: '987654328' }))).statusCode).toBe(400);
    });
  });

  /* ============================================== default book for new -- */

  describe('the default book for a new bill', () => {
    const defaultBook = async (token: string) => (await get(token, '/default-book')).json().data as { bookId: string | null; reason: string };
    const WITH_SETTINGS = { ...FULL, settings_general: ['read', 'update'] };
    const setDefault = (token: string, bookId: string | null) => app.inject({ method: 'PUT', url: '/api/settings', headers: auth(token), payload: { defaultBillingBookId: bookId } });

    it('no active book → none; exactly one active book → that book, with no configuration', async () => {
      const { tenantId, token } = await seedTenant('bill-default-one', WITH_SETTINGS);
      expect(await defaultBook(token)).toEqual({ bookId: null, reason: 'NONE' });
      await seedBook(tenantId, { isActive: false });
      const only = await seedBook(tenantId, { seriesType: 'WITHOUT_GST' });
      expect(await defaultBook(token)).toEqual({ bookId: only.id, reason: 'ONLY_ACTIVE' });
    });

    it('several active books: stable first → last used → configured; stale choices are ignored', async () => {
      const { tenantId, token } = await seedTenant('bill-default-many', WITH_SETTINGS);
      const product = await seedProduct(tenantId);
      const a = await seedBook(tenantId, { bookNumber: 'AAA-GST', seriesType: 'WITH_GST' });
      const b = await seedBook(tenantId, { bookNumber: 'BBB-NOGST', seriesType: 'WITHOUT_GST' });
      const c = await seedBook(tenantId, { bookNumber: 'CCC-GST', seriesType: 'WITH_GST' });

      // Nothing used yet: deterministic, and the same on every call.
      expect(await defaultBook(token)).toEqual({ bookId: a.id, reason: 'FIRST_ACTIVE' });
      expect(await defaultBook(token)).toEqual({ bookId: a.id, reason: 'FIRST_ACTIVE' });

      // Saving a bill makes its book the last used.
      await created(token, billOf(c.id, [lineOf(product, 1, 100)]));
      expect(await defaultBook(token)).toEqual({ bookId: c.id, reason: 'LAST_USED' });
      await created(token, billOf(b.id, [lineOf(product, 1, 100)]));
      expect(await defaultBook(token)).toEqual({ bookId: b.id, reason: 'LAST_USED' });

      // The last used book goes inactive → skipped, back to the most recent ACTIVE one.
      await db.update(schema.books).set({ isActive: false }).where(eq(schema.books.id, b.id));
      expect(await defaultBook(token)).toEqual({ bookId: c.id, reason: 'LAST_USED' });

      // An explicit default wins over last used while it is active…
      expect((await setDefault(token, a.id)).statusCode).toBe(200);
      expect(await defaultBook(token)).toEqual({ bookId: a.id, reason: 'CONFIGURED' });
      // …and Automatic (null) goes back to last used.
      expect((await setDefault(token, null)).statusCode).toBe(200);
      expect(await defaultBook(token)).toEqual({ bookId: c.id, reason: 'LAST_USED' });
      // A configured book that goes inactive is ignored — here only c is left active.
      await setDefault(token, a.id);
      await db.update(schema.books).set({ isActive: false }).where(eq(schema.books.id, a.id));
      expect(await defaultBook(token)).toEqual({ bookId: c.id, reason: 'ONLY_ACTIVE' });
    });

    it('never offers another tenant’s book, even if configured', async () => {
      const { tenantId, token } = await seedTenant('bill-default-iso', WITH_SETTINGS);
      await seedBook(tenantId);
      await seedBook(tenantId);
      await setDefault(token, bookB.id);
      expect((await defaultBook(token)).bookId).not.toBe(bookB.id);
    });

    it('reading the default takes no number from any book', async () => {
      const { tenantId, token } = await seedTenant('bill-default-nonum');
      const book = await seedBook(tenantId);
      await defaultBook(token);
      await defaultBook(token);
      expect(await nextNumberOf(book.id)).toBe(1);
    });
  });

  /* ======================================================= next visit -- */

  describe('next visit → one linked appointment', () => {
    const linked = async (billId: string) => db.select().from(schema.appointments).where(eq(schema.appointments.sourceBillId, billId));
    const appointmentCounter = async (tenantId: string) =>
      (await db.select().from(schema.documentCounters).where(and(eq(schema.documentCounters.tenantId, tenantId), eq(schema.documentCounters.documentType, 'appointment'))))[0]?.nextNumber ?? 1;
    const countAppointments = async (tenantId: string) => (await db.select({ id: schema.appointments.id }).from(schema.appointments).where(eq(schema.appointments.tenantId, tenantId))).length;
    const countBills = async (tenantId: string) => (await db.select({ id: schema.bills.id }).from(schema.bills).where(eq(schema.bills.tenantId, tenantId))).length;
    const lookup = async (token: string, mobile: string) =>
      (await app.inject({ method: 'GET', url: `/api/common/lookups/appointments?mobile=${mobile}`, headers: auth(token) })).json().data as { id: string }[] | undefined;

    let tenantId = '';
    let token = '';
    let book: Awaited<ReturnType<typeof seedBook>>;
    let product: Product;
    beforeAll(async () => {
      ({ tenantId, token } = await seedTenant('bill-next-visit', { ...FULL, operations_appointments: ['read'] }));
      book = await seedBook(tenantId);
      product = await seedProduct(tenantId);
    });

    it('no next visit date → no appointment, no appointment number used', async () => {
      const before = await appointmentCounter(tenantId);
      const bill = await created(token, billOf(book.id, [lineOf(product, 1, 100)]));
      expect(await linked(bill.id)).toHaveLength(0);
      expect(await appointmentCounter(tenantId)).toBe(before);
      expect(await detail(token, bill.id)).toMatchObject({ nextVisitDate: null, nextAppointmentNumber: null });
    });

    it('a next visit date creates exactly one appointment with the customer, baby and date — no time', async () => {
      const before = await appointmentCounter(tenantId);
      const bill = await created(token, billOf(book.id, [lineOf(product, 1, 100)], { customerName: 'Visit Customer', mobileNumber: '9812345678', babyName: 'Aarav', nextVisitDate: '2026-10-23' }));
      const rows = await linked(bill.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId,
        appointmentNumber: before,
        appointmentDate: '2026-10-23',
        appointmentTime: null,
        customerName: 'Visit Customer',
        mobileNumber: '9812345678',
        mobileSearch: '9812345678',
        babyName: 'Aarav',
      });
      expect(await appointmentCounter(tenantId)).toBe(before + 1);
      expect(bill).toMatchObject({ nextVisitDate: '2026-10-23', nextAppointmentNumber: before, nextAppointmentId: rows[0].id });
      expect(await detail(token, bill.id)).toMatchObject({ nextAppointmentNumber: before });
      // Billing's mobile lookup finds it like any other booking.
      expect((await lookup(token, '9812345678'))?.map((a) => a.id)).toContain(rows[0].id);
    });

    it('repeated saves never create a second appointment', async () => {
      const bill = await created(token, billOf(book.id, [lineOf(product, 1, 100)], { nextVisitDate: '2026-11-01' }));
      const counter = await appointmentCounter(tenantId);
      for (let i = 0; i < 3; i++) expect((await put(token, bill.id, updateOf([lineOf(product, 1, 100 + i)], { nextVisitDate: '2026-11-01' }))).statusCode).toBe(200);
      expect(await linked(bill.id)).toHaveLength(1);
      expect(await appointmentCounter(tenantId)).toBe(counter);
    });

    it('concurrent saves of one bill still leave exactly one appointment', async () => {
      const bill = await created(token, billOf(book.id, [lineOf(product, 1, 100)]));
      const results = await Promise.all(Array.from({ length: 8 }, () => put(token, bill.id, updateOf([lineOf(product, 1, 100)], { nextVisitDate: '2026-12-05' }))));
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect(await linked(bill.id)).toHaveLength(1);
    });

    it('changing the date moves the same appointment; clearing it detaches — and keeps — the appointment', async () => {
      const bill = await created(token, billOf(book.id, [lineOf(product, 1, 100)], { nextVisitDate: '2026-10-10' }));
      const [first] = await linked(bill.id);
      const moved = (await put(token, bill.id, updateOf([lineOf(product, 1, 100)], { nextVisitDate: '2026-10-20' }))).json().data;
      const [after] = await linked(bill.id);
      expect(after).toMatchObject({ id: first.id, appointmentNumber: first.appointmentNumber, appointmentDate: '2026-10-20' });
      expect(moved.nextAppointmentNumber).toBe(first.appointmentNumber);

      const cleared = (await put(token, bill.id, updateOf([lineOf(product, 1, 100)], { nextVisitDate: null }))).json().data;
      expect(cleared).toMatchObject({ nextVisitDate: null, nextAppointmentNumber: null });
      expect(await linked(bill.id)).toHaveLength(0);
      const [kept] = await db.select().from(schema.appointments).where(eq(schema.appointments.id, first.id));
      expect(kept).toMatchObject({ sourceBillId: null, appointmentDate: '2026-10-20' });
    });

    it('an unrelated re-save does not resurrect an appointment the studio deleted', async () => {
      const bill = await created(token, billOf(book.id, [lineOf(product, 1, 100)], { nextVisitDate: '2026-10-15' }));
      const [appt] = await linked(bill.id);
      await db.delete(schema.appointments).where(eq(schema.appointments.id, appt.id));
      expect((await put(token, bill.id, updateOf([lineOf(product, 2, 100)], { nextVisitDate: '2026-10-15' }))).statusCode).toBe(200);
      expect(await linked(bill.id)).toHaveLength(0);
      // Choosing a different date is a new decision, and books a new visit.
      expect((await put(token, bill.id, updateOf([lineOf(product, 2, 100)], { nextVisitDate: '2026-10-16' }))).statusCode).toBe(200);
      expect(await linked(bill.id)).toHaveLength(1);
    });

    it('an appointment that has itself been billed is never moved', async () => {
      const bill = await created(token, billOf(book.id, [lineOf(product, 1, 100)], { nextVisitDate: '2026-10-12' }));
      const [appt] = await linked(bill.id);
      expect((await post(token, billOf(book.id, [lineOf(product, 1, 100)], { appointmentId: appt.id, billDate: '2026-10-12' }))).statusCode).toBe(200);
      const res = await put(token, bill.id, updateOf([lineOf(product, 1, 100)], { nextVisitDate: '2026-10-30' }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details[0].path).toEqual(['nextVisitDate']);
      expect((await linked(bill.id))[0].appointmentDate).toBe('2026-10-12');
    });

    it('an unrelated re-save never undoes a reschedule made in Appointments — even once that visit is billed', async () => {
      const bill = await created(token, billOf(book.id, [lineOf(product, 1, 100)], { nextVisitDate: '2026-10-10' }));
      const [appt] = await linked(bill.id);
      // The studio moves the booking by hand; nothing writes that back to the bill.
      await db.update(schema.appointments).set({ appointmentDate: '2026-10-15' }).where(eq(schema.appointments.id, appt.id));
      expect((await put(token, bill.id, updateOf([lineOf(product, 1, 100)], { nextVisitDate: '2026-10-10', remark: 'typo fixed' }))).statusCode).toBe(200);
      expect((await linked(bill.id))[0].appointmentDate).toBe('2026-10-15');
      // The rescheduled visit happens and is billed; the original bill must still be editable.
      expect((await post(token, billOf(book.id, [lineOf(product, 1, 100)], { appointmentId: appt.id, billDate: '2026-10-15' }))).statusCode).toBe(200);
      expect((await put(token, bill.id, updateOf([lineOf(product, 2, 100)], { nextVisitDate: '2026-10-10' }))).statusCode).toBe(200);
    });

    it('a bill cannot name its own next-visit appointment as the booking it came from', async () => {
      const bill = await created(token, billOf(book.id, [lineOf(product, 1, 100)], { nextVisitDate: '2026-10-19' }));
      const [appt] = await linked(bill.id);
      const res = await put(token, bill.id, updateOf([lineOf(product, 1, 100)], { nextVisitDate: '2026-10-19', appointmentId: appt.id }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details[0].path).toEqual(['appointmentId']);
    });

    it('deleting the bill keeps its next-visit appointment', async () => {
      const bill = await created(token, billOf(book.id, [lineOf(product, 1, 100)], { nextVisitDate: '2026-10-18' }));
      const [appt] = await linked(bill.id);
      expect((await del(token, bill.id)).statusCode).toBe(200);
      const [kept] = await db.select().from(schema.appointments).where(eq(schema.appointments.id, appt.id));
      expect(kept).toMatchObject({ sourceBillId: null, appointmentDate: '2026-10-18' });
    });

    it('a next visit before the bill date is refused on the field', async () => {
      const res = await post(token, billOf(book.id, [lineOf(product, 1, 100)], { billDate: '2026-09-23', nextVisitDate: '2026-09-22' }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details[0].path).toEqual(['nextVisitDate']);
    });

    it('a refused bill creates no appointment and uses no number', async () => {
      const [bills, appts, counter, next] = [await countBills(tenantId), await countAppointments(tenantId), await appointmentCounter(tenantId), await nextNumberOf(book.id)];
      const res = await post(token, billOf(book.id, [lineOf(product, 0, 100)], { nextVisitDate: '2026-10-25' }));
      expect(res.statusCode).toBe(400);
      expect(await countBills(tenantId)).toBe(bills);
      expect(await countAppointments(tenantId)).toBe(appts);
      expect(await appointmentCounter(tenantId)).toBe(counter);
      expect(await nextNumberOf(book.id)).toBe(next);
    });

    /**
     * An appointment that cannot be written takes the whole bill back with it. A temporary check
     * constraint on the THROWAWAY database (the suite's guard proved which one) makes the
     * appointment insert fail for one baby name.
     */
    it('a failed appointment rolls back the bill, its number and the appointment number', async () => {
      const [bills, appts, counter, next] = [await countBills(tenantId), await countAppointments(tenantId), await appointmentCounter(tenantId), await nextNumberOf(book.id)];
      await sqlClient`alter table appointments add constraint zz_test_block_next_visit check (baby_name is distinct from 'FAIL-NEXT-VISIT')`;
      try {
        const res = await post(token, billOf(book.id, [lineOf(product, 1, 100)], { babyName: 'FAIL-NEXT-VISIT', nextVisitDate: '2026-10-25' }));
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
      } finally {
        await sqlClient`alter table appointments drop constraint zz_test_block_next_visit`;
      }
      expect(await countBills(tenantId)).toBe(bills);
      expect(await countAppointments(tenantId)).toBe(appts);
      expect(await appointmentCounter(tenantId)).toBe(counter);
      expect(await nextNumberOf(book.id)).toBe(next);
    });

    it('stays inside the tenant: another tenant never sees the appointment', async () => {
      const bill = await created(token, billOf(book.id, [lineOf(product, 1, 100)], { mobileNumber: '9870001111', nextVisitDate: '2026-10-28' }));
      const [appt] = await linked(bill.id);
      expect(appt.tenantId).toBe(tenantId);
      const tokenBAppointments = await seedUser(tenantBId, 'bill-tenant-b-appts', { operations_appointments: ['read'] });
      expect((await lookup(tokenBAppointments, '9870001111'))?.map((a) => a.id) ?? []).not.toContain(appt.id);
    });
  });
});
