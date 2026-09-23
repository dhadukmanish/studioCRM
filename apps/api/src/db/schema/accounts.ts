import { pgTable, uuid, text, numeric, boolean, unique, uniqueIndex, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, ts, tenantRef } from './core';
import { accountGroups } from './accountGroups';
import { items } from './items';

/**
 * Account Master — HEAD GROUP -> ACCOUNT GROUP -> ACCOUNT. Every account belongs to exactly
 * one Account Group; the group's head group is never copied here, because the group row is
 * the single source of truth and the list joins it.
 *
 * Accounting FOUNDATION only. The opening balance is opening information: there is
 * deliberately no mutable `currentBalance`, and nothing in this phase posts a ledger entry,
 * a journal or a voucher from it. Later transaction data will determine balances.
 *
 * Audited through `activity_logs`, like the other masters.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    tenantId: tenantRef(),
    accountGroupId: uuid('account_group_id').notNull(),
    accountName: text('account_name').notNull(),
    /**
     * Money — fixed scale, never a float. Always positive: a Credit opening balance is said
     * with `openingSide`, never with a negative amount.
     */
    openingAmount: numeric('opening_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    /** DEBIT | CREDIT — ACCOUNT_OPENING_SIDES in `packages/shared/src/enums.ts`. */
    openingSide: text('opening_side').notNull().default('DEBIT'),
    remark: text('remark'),
    isActive: boolean('is_active').notNull().default(true),
    ...ts,
  },
  (t) => [
    /**
     * The group reference carries the tenant, so an account can only ever point at an Account
     * Group of its own tenant — cross-tenant filing is impossible, not merely checked for.
     * RESTRICT: a group that has accounts must be deactivated, not deleted out from under them.
     */
    foreignKey({ columns: [t.accountGroupId, t.tenantId], foreignColumns: [accountGroups.id, accountGroups.tenantId], name: 'accounts_group_tenant_fk' }).onDelete('restrict'),
    // Business key: one account name per tenant, case-insensitive. Also the final guard against
    // two concurrent create requests racing past the application-level check.
    uniqueIndex('accounts_tenant_name_lower_idx').on(t.tenantId, sql`lower(${t.accountName})`),
    // List screen: tenant predicate + default "recently updated first" sort.
    index('accounts_tenant_updated_idx').on(t.tenantId, t.updatedAt),
    // The group quick filter, and the join back from a group.
    index('accounts_tenant_group_idx').on(t.tenantId, t.accountGroupId),
    /**
     * The target every detail table below references, and the one Payment/Voucher/Ledger will
     * reference later — (id, tenant_id) together, so a financial row can never attach to
     * another tenant's account. Those future foreign keys must be RESTRICT: a historically
     * used account is deactivated, never deleted.
     */
    unique('accounts_id_tenant_uk').on(t.id, t.tenantId),
    check('accounts_opening_side_check', sql`${t.openingSide} IN ('DEBIT', 'CREDIT')`),
    check('accounts_opening_amount_non_negative_check', sql`${t.openingAmount} >= 0`),
    check('accounts_account_name_not_blank_check', sql`length(btrim(${t.accountName})) > 0`),
  ],
);

/**
 * The detail tables below are 1:1 extensions of an account, one per kind of account the
 * legacy Account Master asks extra questions about. They hold only the extra fields — never a
 * second copy of the account's identity — and a row exists only while the account's group
 * actually drives that block, so changing the group removes the stale row rather than hiding
 * it. CASCADE: a detail row has no life of its own once its account is gone.
 *
 * Typed columns rather than a JSON blob, so the data stays queryable (every employee, every
 * bank account) and money keeps a real decimal column.
 */
/** The two columns and the one foreign key every detail table shares. */
const detailOwner = (table: string) => ({
  accountId: uuid('account_id').primaryKey(),
  tenantId: tenantRef(),
  fk: (t: { accountId: any; tenantId: any }) =>
    foreignKey({ columns: [t.accountId, t.tenantId], foreignColumns: [accounts.id, accounts.tenantId], name: `${table}_account_tenant_fk` }).onDelete('cascade'),
});

const bank = detailOwner('account_bank_details');
/** BANK. Account Number is text, never numeric — leading zeros and IFSC-style formatting matter. */
export const accountBankDetails = pgTable(
  'account_bank_details',
  { accountId: bank.accountId, tenantId: bank.tenantId, bankName: text('bank_name'), accountType: text('account_type'), branch: text('branch'), accountNumber: text('account_number'), ...ts },
  (t) => [bank.fk(t)],
);

const employee = detailOwner('account_employee_details');
/** EMPLOYEE. Commission is stored as given — no calculation rule for it is established. */
export const accountEmployeeDetails = pgTable(
  'account_employee_details',
  {
    accountId: employee.accountId,
    tenantId: employee.tenantId,
    employeeName: text('employee_name'),
    address: text('address'),
    /** Text, never numeric: a contact number may carry +, spaces and leading zeros. */
    contactNumber: text('contact_number'),
    /** Free text: no option set for salary type is established anywhere. */
    salaryType: text('salary_type'),
    salary: numeric('salary', { precision: 14, scale: 2 }),
    /** Free text: no designation list is established anywhere. */
    designation: text('designation'),
    commission: numeric('commission', { precision: 14, scale: 2 }),
    ...ts,
  },
  (t) => [
    employee.fk(t),
    check('account_employee_details_salary_non_negative_check', sql`${t.salary} IS NULL OR ${t.salary} >= 0`),
    check('account_employee_details_commission_non_negative_check', sql`${t.commission} IS NULL OR ${t.commission} >= 0`),
  ],
);

const loan = detailOwner('account_loan_details');
/** LOAN. The rate is stored only; no interest is calculated in this phase. */
export const accountLoanDetails = pgTable(
  'account_loan_details',
  { accountId: loan.accountId, tenantId: loan.tenantId, interestRate: numeric('interest_rate', { precision: 5, scale: 2 }), ...ts },
  (t) => [loan.fk(t), check('account_loan_details_interest_rate_range_check', sql`${t.interestRate} IS NULL OR (${t.interestRate} >= 0 AND ${t.interestRate} <= 100)`)],
);

const partner = detailOwner('account_partner_details');
/** PARTNER. Shares are recorded, never allocated — no rule says profit + loss must total 100. */
export const accountPartnerDetails = pgTable(
  'account_partner_details',
  {
    accountId: partner.accountId,
    tenantId: partner.tenantId,
    mobileNumber: text('mobile_number'),
    profitPercent: numeric('profit_percent', { precision: 5, scale: 2 }),
    lossPercent: numeric('loss_percent', { precision: 5, scale: 2 }),
    ...ts,
  },
  (t) => [
    partner.fk(t),
    check('account_partner_details_profit_percent_range_check', sql`${t.profitPercent} IS NULL OR (${t.profitPercent} >= 0 AND ${t.profitPercent} <= 100)`),
    check('account_partner_details_loss_percent_range_check', sql`${t.lossPercent} IS NULL OR (${t.lossPercent} >= 0 AND ${t.lossPercent} <= 100)`),
  ],
);

const party = detailOwner('account_party_details');
/**
 * CLIENT and EXPOSER/PARTY — one table for both, because the legacy screens ask for exactly
 * the same fields and only the heading differs.
 *
 * `gst` and `rate` are stored as entered: their accounting meaning here is not established, so
 * nothing computes with them. `gst` is NOT Item Master's GST % — it is the party's own
 * registration detail.
 */
export const accountPartyDetails = pgTable(
  'account_party_details',
  {
    accountId: party.accountId,
    tenantId: party.tenantId,
    partyName: text('party_name'),
    address: text('address'),
    contactNumber: text('contact_number'),
    gst: text('gst'),
    panNo: text('pan_no'),
    rate: numeric('rate', { precision: 14, scale: 2 }),
    email: text('email'),
    /** An Item Master row, never copied item text. Nullable — the legacy field is optional. */
    itemId: uuid('item_id'),
    ...ts,
  },
  (t) => [
    party.fk(t),
    /**
     * Tenant-safe like every other parent reference here: the pair (item_id, tenant_id) makes
     * pointing at another tenant's item impossible. RESTRICT — an item a party references is
     * deactivated, not deleted.
     */
    foreignKey({ columns: [t.itemId, t.tenantId], foreignColumns: [items.id, items.tenantId], name: 'account_party_details_item_tenant_fk' }).onDelete('restrict'),
    index('account_party_details_item_idx').on(t.itemId),
    check('account_party_details_rate_non_negative_check', sql`${t.rate} IS NULL OR ${t.rate} >= 0`),
  ],
);
