import { z } from 'zod';
import { INVOICE_TAX_MODES, INVOICE_TAX_MODE_LABELS, type InvoiceTaxMode } from '../enums.js';

/**
 * Book Master — a Book is one independent BILL NUMBER SERIES, not a text master.
 *
 * Bills created under a book are numbered 1, 2, 3 ... and a NEW book starts its own series
 * again from its own `seriesStartsAt`. Two books may therefore both hold a Bill No. 1; future
 * bill identity is (tenant, book, billNumber), never a tenant-wide sequence. Nothing resets a
 * series by calendar year, financial year or date — creating a new Book is the only boundary.
 *
 * The running counter (`nextBillNumber`) is system-managed and deliberately absent from this
 * schema: zod strips unknown keys, so no client payload can ever move it.
 */
/** Single source of truth for the field limits — the form reuses these, never its own literals. */
export const BOOK_LIMITS = { bookNumber: 60 } as const;
/**
 * Ceiling of the starting number. Far below the `integer` column's limit so a long-lived book
 * can keep counting up from it without ever overflowing the column.
 */
export const BOOK_SERIES_START_MAX = 1_000_000_000;
/** The starting number a book gets when the payload does not ask for a different one. */
export const BOOK_SERIES_START_DEFAULT = 1;

/**
 * A Book's SERIES TYPE — whether the bills it numbers charge GST. The same two values as a bill's
 * tax mode, because the book decides it: a new bill's tax mode IS its book's series type (the
 * server derives it and refuses a payload that contradicts it). A business may run one book of
 * either type, or several of each, active at once. Frozen once the book has issued a number.
 */
export const BOOK_SERIES_TYPES = INVOICE_TAX_MODES;
export type BookSeriesType = InvoiceTaxMode;
export const BOOK_SERIES_TYPE_LABELS: Record<BookSeriesType, string> = INVOICE_TAX_MODE_LABELS;
export const BOOK_SERIES_TYPE_DEFAULT: BookSeriesType = 'WITH_GST';

export const bookSchema = z.object({
  /**
   * Free text on purpose. "2026-27" is what the studio uses today, but the naming convention
   * is the business's to change — the only rules are non-blank, bounded, and unique per tenant
   * (case-insensitively, enforced by the API and by a unique index).
   */
  bookNumber: z.string().trim().min(1, 'Book number is required').max(BOOK_LIMITS.bookNumber, `Book number cannot exceed ${BOOK_LIMITS.bookNumber} characters`),
  /**
   * The first bill number this book will hand out. Omitting it means 1; blanking it is a
   * mistake, not a choice, so '' / null / [] are rejected rather than coerced — plain
   * `z.coerce.number()` would turn all three into 0, which is not a valid bill number.
   */
  seriesStartsAt: z
    .preprocess(
      (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined),
      z
        .number({ required_error: 'Series starts at is required', invalid_type_error: 'Series starts at must be a number' })
        .int('Series starts at must be a whole number')
        .min(1, 'Series starts at must be at least 1')
        .max(BOOK_SERIES_START_MAX, 'Series starts at is too large'),
    )
    .default(BOOK_SERIES_START_DEFAULT),
  seriesType: z.enum(BOOK_SERIES_TYPES, { errorMap: () => ({ message: 'Select a valid series type' }) }).default(BOOK_SERIES_TYPE_DEFAULT),
  /** Active means the book can be picked for NEW bills. Inactive keeps all of its history. */
  isActive: z.boolean().default(true),
});
export type BookInput = z.infer<typeof bookSchema>;
