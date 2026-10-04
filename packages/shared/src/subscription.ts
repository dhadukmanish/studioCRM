import { z } from 'zod';
import { isIsoDate } from './dates.js';

/*
 * SaaS subscriptions — the platform (the company that sells StudioCRM) grants each studio
 * (tenant) subscription periods. Every feature is available on every plan; a plan only buys time.
 * docs/SUBSCRIPTIONS.md is the contract.
 */

/** TRIAL = once per studio · DAYS = price per day × days chosen · MONTHLY / YEARLY = fixed length. */
export const PLAN_KINDS = ['TRIAL', 'DAYS', 'MONTHLY', 'YEARLY'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
export const PLAN_KIND_LABELS: Record<PlanKind, string> = { TRIAL: 'Trial', DAYS: 'Day-wise', MONTHLY: 'Monthly', YEARLY: 'Yearly' };

export const SUBSCRIPTION_PAYMENT_MODES = ['CASH', 'UPI', 'BANK', 'CHEQUE', 'OTHER'] as const;
export type SubscriptionPaymentMode = (typeof SUBSCRIPTION_PAYMENT_MODES)[number];

/** Full access continues this many days after the last paid day, then the studio turns read-only. */
export const SUBSCRIPTION_GRACE_DAYS = 3;
/** The banner starts warning when this many days (or fewer) are left. */
export const SUBSCRIPTION_WARN_DAYS = 7;
export const MAX_PERIOD_DAYS = 3660;

/**
 * UNMANAGED = the studio has never been given a subscription (pre-SaaS studios) → unrestricted
 * until the platform assigns one. Every studio created from the panel starts with a period.
 */
export const SUBSCRIPTION_STATUSES = ['UNMANAGED', 'TRIAL', 'ACTIVE', 'GRACE', 'EXPIRED', 'SUSPENDED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  UNMANAGED: 'No plan',
  TRIAL: 'Trial',
  ACTIVE: 'Active',
  GRACE: 'Grace period',
  EXPIRED: 'Expired',
  SUSPENDED: 'Suspended',
};

export interface SubscriptionAccess {
  status: SubscriptionStatus;
  /** Last paid day (inclusive), or null when unmanaged. */
  endsOn: string | null;
  /** Days of access left including today; negative once past endsOn. Null when unmanaged. */
  daysLeft: number | null;
  /** Writes refused (EXPIRED) — reading and printing still work. */
  readOnly: boolean;
  /** Nothing works, not even sign-in (SUSPENDED). */
  blocked: boolean;
}

const dayNumber = (v: string) => Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10)) / 86_400_000;
const fromDayNumber = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** "YYYY-MM-DD" plus n calendar days. */
export function addDays(ymd: string, n: number): string {
  return fromDayNumber(dayNumber(ymd) + n);
}
/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/**
 * The one definition of a studio's subscription status. `endsOn` = the latest ends_on over its
 * ACTIVE periods; `isTrial` = that latest period is a trial; `managed` = it has ever had a period.
 */
export function deriveSubscriptionAccess(input: { isActive: boolean; managed: boolean; endsOn: string | null; isTrial: boolean; today: string }): SubscriptionAccess {
  const { isActive, managed, endsOn, isTrial, today } = input;
  const daysLeft = endsOn ? daysBetween(today, endsOn) + 1 : null;
  if (!isActive) return { status: 'SUSPENDED', endsOn, daysLeft, readOnly: true, blocked: true };
  if (!managed) return { status: 'UNMANAGED', endsOn: null, daysLeft: null, readOnly: false, blocked: false };
  if (endsOn && daysLeft! >= 1) return { status: isTrial ? 'TRIAL' : 'ACTIVE', endsOn, daysLeft, readOnly: false, blocked: false };
  // A trial gets no grace — it simply ends.
  if (endsOn && !isTrial && daysLeft! > -SUBSCRIPTION_GRACE_DAYS) return { status: 'GRACE', endsOn, daysLeft, readOnly: false, blocked: false };
  return { status: 'EXPIRED', endsOn, daysLeft, readOnly: true, blocked: false };
}

/**
 * A new period starts the day after the current one ends — renewing early never wastes paid days —
 * or today, when nothing is running.
 */
export function nextPeriod(currentEndsOn: string | null, today: string, days: number): { startsOn: string; endsOn: string } {
  const startsOn = currentEndsOn && currentEndsOn >= today ? addDays(currentEndsOn, 1) : today;
  return { startsOn, endsOn: addDays(startsOn, days - 1) };
}

/** How many days a plan grants; DAYS plans take the number chosen when granting. */
export function planDays(plan: { kind: PlanKind; durationDays: number | null }, chosenDays?: number | null): number | null {
  if (plan.kind === 'DAYS') return chosenDays && chosenDays > 0 ? chosenDays : null;
  return plan.durationDays;
}

/** List price of a grant in paise-safe string form: DAYS = per-day price × days, others = plan price. */
export function planAmount(plan: { kind: PlanKind; price: string }, days: number): string {
  const paise = Math.round(Number(plan.price) * 100);
  return ((plan.kind === 'DAYS' ? paise * days : paise) / 100).toFixed(2);
}

/* ---------------------------------------------------------------- schemas -- */

const money = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,10}(\.\d{1,2})?$/.test(v), 'Enter an amount with at most 2 decimals');
const isoDate = z.string().refine(isIsoDate, 'Enter a valid date');
const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => v || null);
const password = z.string().min(8, 'Password must be at least 8 characters').max(200);

export const platformLoginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
});

export const platformChangePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: password });

export const planSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(80),
    kind: z.enum(PLAN_KINDS),
    durationDays: z.coerce.number().int().min(1).max(MAX_PERIOD_DAYS).optional().nullable(),
    price: money,
    isActive: z.boolean().default(true),
    sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  })
  .superRefine((v, ctx) => {
    if (v.kind !== 'DAYS' && !v.durationDays) ctx.addIssue({ code: 'custom', path: ['durationDays'], message: 'Enter the number of days this plan gives' });
  })
  .transform((v) => ({ ...v, durationDays: v.kind === 'DAYS' ? null : v.durationDays ?? null }));
export type PlanInput = z.infer<typeof planSchema>;

/** One grant: a trial or a paid period, with the payment received for it. */
export const grantSubscriptionSchema = z.object({
  planId: z.string().uuid('Choose a plan'),
  /** Only for a Day-wise plan. */
  days: z.coerce.number().int().min(1).max(MAX_PERIOD_DAYS).optional().nullable(),
  /** Omit to charge the plan's list price. */
  amount: money.optional().nullable(),
  paymentMode: z.enum(SUBSCRIPTION_PAYMENT_MODES).optional().nullable(),
  paymentRef: optText(100),
  paidOn: isoDate.optional().nullable(),
  notes: optText(500),
});
export type GrantSubscriptionInput = z.infer<typeof grantSubscriptionSchema>;

export const cancelSubscriptionSchema = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(300) });

export const createStudioSchema = z.object({
  studioName: z.string().trim().min(1, 'Studio name is required').max(120),
  ownerFirstName: z.string().trim().min(1, 'Owner name is required').max(60),
  ownerLastName: z.string().trim().max(60).default(''),
  ownerEmail: z.string().trim().toLowerCase().email('Enter a valid email'),
  ownerMobile: z.string().trim().regex(/^\d{10}$/, 'Mobile must be exactly 10 digits'),
  ownerPassword: password,
  subscription: grantSubscriptionSchema,
});
export type CreateStudioInput = z.infer<typeof createStudioSchema>;

export const updateStudioSchema = z.object({ name: z.string().trim().min(1).max(120) });
export const studioStatusSchema = z.object({ isActive: z.boolean() });
export const ownerPasswordSchema = z.object({ password });
