import { z } from 'zod';
import { ACCOUNT_DETAIL_KINDS, ACCOUNT_OPENING_SIDES, type AccountDetailKind } from '../enums.js';

/**
 * Account Master — the accounts a studio keeps, each filed under exactly one Account Group
 * (HEAD GROUP -> ACCOUNT GROUP -> ACCOUNT). The group's name decides which extra detail block
 * the form shows; the common fields below are always present.
 *
 * Foundation only. The opening balance is master opening information: nothing here posts a
 * ledger or journal entry, calculates interest, distributes profit or maintains a running
 * balance. Those belong to a later phase.
 */

/** Single source of truth for the field limits — the form reuses these, never its own literals. */
export const ACCOUNT_LIMITS = {
  accountName: 120,
  remark: 500,
  /** default for short free-text detail fields (names, branches, designations, ...) */
  text: 120,
  address: 250,
  contact: 30,
  accountNumber: 40,
  gst: 20,
  pan: 20,
  email: 160,
} as const;

/** Ceiling of the `numeric(14, 2)` money columns — a larger value is a database error, not a validation one. */
export const ACCOUNT_AMOUNT_MAX = 999999999999.99;

/* ------------------------------------------------------------- primitives -- */

/**
 * "500.50" -> 500.5 for form posts. Blank stays blank rather than becoming 0: `z.coerce.number()`
 * turns '', null and [] into 0, and 0 is a legitimate amount, so a blank field would silently
 * be stored as zero.
 */
const toNumber = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined);
const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
/** The column stores 2 decimals. Refuse a third rather than rounding it away behind the user's back. */
const twoDecimals = (v: number) => /^\d+(\.\d{1,2})?$/.test(String(v));

/** Optional money: blank is stored as NULL, never as 0. */
const optionalAmount = (label: string) =>
  z.preprocess(
    (v) => (isBlank(v) ? null : toNumber(v)),
    z
      .number({ invalid_type_error: label + ' must be a number' })
      .min(0, label + ' cannot be negative')
      .max(ACCOUNT_AMOUNT_MAX, label + ' is too large')
      .refine(twoDecimals, label + ' can have at most 2 decimal places')
      .nullable(),
  );

/** Optional percentage, 0-100 with 2 decimals. Nothing calculates with it in this phase. */
const optionalPercent = (label: string) =>
  z.preprocess(
    (v) => (isBlank(v) ? null : toNumber(v)),
    z
      .number({ invalid_type_error: label + ' must be a number' })
      .min(0, label + ' cannot be negative')
      .max(100, label + ' cannot exceed 100')
      .refine(twoDecimals, label + ' can have at most 2 decimal places')
      .nullable(),
  );

/** Optional free text: trimmed, and blank is stored as NULL, never as ''. */
const optionalText = (label: string, max: number = ACCOUNT_LIMITS.text) =>
  z.preprocess((v) => (isBlank(v) ? null : v), z.string().trim().max(max, label + ' cannot exceed ' + max + ' characters').nullable());

/* ----------------------------------------------------------- common fields -- */

export const accountSchema = z.object({
  /** The Account Group this account is filed under. The API additionally proves it is the caller's own. */
  accountGroupId: z
    .string({ required_error: 'Account group is required', invalid_type_error: 'Account group is required' })
    .min(1, 'Account group is required')
    .uuid('Select a valid account group'),
  accountName: z.string().trim().min(1, 'Account name is required').max(ACCOUNT_LIMITS.accountName, `Account name cannot exceed ${ACCOUNT_LIMITS.accountName} characters`),
  /**
   * Always positive. A Credit opening balance is expressed by `openingSide`, never by a
   * negative amount. An empty field means "no opening balance", which is 0.
   */
  openingAmount: z.preprocess(
    (v) => (isBlank(v) ? 0 : toNumber(v)),
    z
      .number({ invalid_type_error: 'Opening amount must be a number' })
      .min(0, 'Opening amount cannot be negative')
      .max(ACCOUNT_AMOUNT_MAX, 'Opening amount is too large')
      .refine(twoDecimals, 'Opening amount can have at most 2 decimal places'),
  ),
  /** An unselected dropdown posts '' — treated as the default side rather than as a bad value. */
  openingSide: z.preprocess(
    (v) => (isBlank(v) ? 'DEBIT' : v),
    z.enum(ACCOUNT_OPENING_SIDES, {
      errorMap: () => ({ message: `Opening side must be one of ${ACCOUNT_OPENING_SIDES.join(', ')}` }),
    }),
  ),
  /** Free-form note. Blank is stored as NULL, never as ''. */
  remark: optionalText('Remark', ACCOUNT_LIMITS.remark),
  isActive: z.boolean().default(true),
});
export type AccountInput = z.infer<typeof accountSchema>;

/* ---------------------------------------------------------- detail blocks -- */

/**
 * One schema per detail block. Every field is optional: the legacy screens mark none of them
 * mandatory, and inventing a requirement would block real data entry.
 *
 * Deliberately NOT modelled: Account Type, Salary Type and Designation are free text because
 * no option set is established in this repo or in the legacy screens. Commission, Rate and GST
 * are stored as given — their calculation meaning is not established, so nothing computes
 * with them.
 */
export const accountDetailSchemas = {
  bank: z.object({
    /** "Our Bank Name" on the legacy screen. */
    bankName: optionalText('Bank name'),
    accountType: optionalText('Account type'),
    branch: optionalText('Branch'),
    /** Text, never numeric: account numbers are identifiers and leading zeros are significant. */
    accountNumber: optionalText('Account number', ACCOUNT_LIMITS.accountNumber),
  }),
  employee: z.object({
    employeeName: optionalText('Employee name'),
    address: optionalText('Address', ACCOUNT_LIMITS.address),
    /** Text, never numeric: a contact number may carry +, spaces and leading zeros. */
    contactNumber: optionalText('Contact number', ACCOUNT_LIMITS.contact),
    salaryType: optionalText('Salary type'),
    salary: optionalAmount('Salary'),
    designation: optionalText('Designation'),
    /** Stored as given. Percentage or fixed amount is not established, so nothing calculates with it. */
    commission: optionalAmount('Commission'),
  }),
  loan: z.object({
    interestRate: optionalPercent('Interest rate'),
  }),
  partner: z.object({
    mobileNumber: optionalText('Mobile number', ACCOUNT_LIMITS.contact),
    /** Profit and loss shares are stored, never allocated. No rule says the two must total 100. */
    profitPercent: optionalPercent('Profit %'),
    lossPercent: optionalPercent('Loss %'),
  }),
  /** Serves CLIENT and EXPOSER/PARTY alike — the legacy screens show identical fields for both. */
  party: z.object({
    partyName: optionalText('Name'),
    address: optionalText('Address', ACCOUNT_LIMITS.address),
    contactNumber: optionalText('Contact number', ACCOUNT_LIMITS.contact),
    /** Not Item Master's GST %: this is the party's own registration detail, stored as text. */
    gst: optionalText('GST', ACCOUNT_LIMITS.gst),
    panNo: optionalText('PAN No', ACCOUNT_LIMITS.pan),
    rate: optionalAmount('Rate'),
    email: z.preprocess(
      (v) => (isBlank(v) ? null : v),
      z.string().trim().email('Enter a valid email address').max(ACCOUNT_LIMITS.email, `Email cannot exceed ${ACCOUNT_LIMITS.email} characters`).nullable(),
    ),
    /** An Item Master row, never copied item text. The API proves it is the caller's own item. */
    itemId: z.preprocess((v) => (isBlank(v) ? null : v), z.string().uuid('Select a valid item').nullable()),
  }),
} satisfies Record<AccountDetailKind, z.ZodObject<z.ZodRawShape>>;

export type AccountDetailInput = { [K in AccountDetailKind]: z.infer<(typeof accountDetailSchemas)[K]> };

/** The field names a detail block owns — the form submits exactly these, and nothing else. */
export const accountDetailKeys = (kind: AccountDetailKind) => Object.keys(accountDetailSchemas[kind].shape);

/** Every detail field name across all blocks, for building an empty form state. */
export const ALL_ACCOUNT_DETAIL_KEYS = Array.from(new Set(ACCOUNT_DETAIL_KINDS.flatMap((k) => accountDetailKeys(k))));
