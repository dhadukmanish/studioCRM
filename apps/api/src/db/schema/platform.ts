import { pgTable, uuid, text, integer, numeric, date, timestamp, boolean, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, ts, tenantRef } from './core';

/*
 * Platform (SaaS) tables — owned by the company that sells StudioCRM, not by any studio.
 * These are the only tables without a tenant scope besides `tenants` itself; they are reached
 * only through `/api/platform/*`, which a studio's session can never open (docs/SUBSCRIPTIONS.md).
 */

/** A person who runs the platform panel. Signs in separately from every studio user. */
export const platformAdmins = pgTable('platform_admins', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  ...ts,
});

/** What the platform sells. A plan only buys time — every feature is on every plan. */
export const subscriptionPlans = pgTable(
  'subscription_plans',
  {
    id: id(),
    name: text('name').notNull().unique(),
    kind: text('kind').notNull(), // TRIAL | DAYS | MONTHLY | YEARLY
    /** Days granted; NULL for a Day-wise plan, whose days are chosen per grant. */
    durationDays: integer('duration_days'),
    /** List price; for a Day-wise plan this is the price of one day. */
    price: numeric('price', { precision: 12, scale: 2 }).notNull().default('0'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...ts,
  },
  (t) => [
    check('subscription_plans_kind_check', sql`${t.kind} IN ('TRIAL', 'DAYS', 'MONTHLY', 'YEARLY')`),
    check('subscription_plans_duration_check', sql`(${t.kind} = 'DAYS') = (${t.durationDays} IS NULL) AND (${t.durationDays} IS NULL OR ${t.durationDays} > 0)`),
    check('subscription_plans_price_check', sql`${t.price} >= 0`),
  ],
);

/**
 * One granted period of access for a studio, with the payment taken for it. A studio's expiry is
 * derived — the latest ends_on over its ACTIVE periods — never stored. Periods are cancelled,
 * never edited or deleted. Plan name and kind are snapshots so renaming a plan rewrites no history.
 */
export const tenantSubscriptions = pgTable(
  'tenant_subscriptions',
  {
    id: id(),
    tenantId: tenantRef(),
    planId: uuid('plan_id').notNull().references(() => subscriptionPlans.id, { onDelete: 'restrict' }),
    planName: text('plan_name').notNull(),
    kind: text('kind').notNull(),
    days: integer('days').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    /** Last day of access, inclusive. */
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull().default('0'),
    paymentMode: text('payment_mode'),
    paymentRef: text('payment_ref'),
    paidOn: date('paid_on', { mode: 'string' }),
    notes: text('notes'),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE | CANCELLED
    createdBy: uuid('created_by').references(() => platformAdmins.id, { onDelete: 'set null' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => platformAdmins.id, { onDelete: 'set null' }),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('tenant_subscriptions_tenant_idx').on(t.tenantId, t.status, t.endsOn),
    // A studio gets one trial, ever (a cancelled one may be re-granted).
    uniqueIndex('tenant_subscriptions_one_trial_idx').on(t.tenantId).where(sql`${t.kind} = 'TRIAL' AND ${t.status} = 'ACTIVE'`),
    check('tenant_subscriptions_kind_check', sql`${t.kind} IN ('TRIAL', 'DAYS', 'MONTHLY', 'YEARLY')`),
    check('tenant_subscriptions_status_check', sql`${t.status} IN ('ACTIVE', 'CANCELLED')`),
    check('tenant_subscriptions_dates_check', sql`${t.endsOn} >= ${t.startsOn} AND ${t.days} = ${t.endsOn} - ${t.startsOn} + 1`),
    check('tenant_subscriptions_amount_check', sql`${t.amount} >= 0`),
    check('tenant_subscriptions_payment_mode_check', sql`${t.paymentMode} IS NULL OR ${t.paymentMode} IN ('CASH', 'UPI', 'BANK', 'CHEQUE', 'OTHER')`),
    check('tenant_subscriptions_cancelled_check', sql`(${t.status} = 'CANCELLED') = (${t.cancelledAt} IS NOT NULL)`),
  ],
);
