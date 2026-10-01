import { z } from 'zod';
import { isIsoDate } from './dates.js';
import type { WorkPosition } from './workflow.js';

/**
 * The Dashboard (docs/DASHBOARD.md): the studio's figures at a glance — inquiries (appointments),
 * orders (bills) and where each order is in the workflow, and money. Read-only and derived: every
 * figure is the SAME definition the module or report behind it uses, never a second formula.
 *
 * A period is resolved on the SERVER from the tenant's business date (`periodRange`), so the browser
 * never decides what "this month" is.
 */
export const DASHBOARD_PERIODS = ['TODAY', 'THIS_MONTH', 'LAST_MONTH', 'THIS_FY', 'CUSTOM'] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
export const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriod, string> = { TODAY: 'Today', THIS_MONTH: 'This month', LAST_MONTH: 'Last month', THIS_FY: 'This financial year', CUSTOM: 'Custom' };

const isoDate = z.string().refine(isIsoDate, 'Enter a valid date');

export const dashboardQuerySchema = z
  .object({
    period: z.enum(DASHBOARD_PERIODS, { errorMap: () => ({ message: 'Unknown period' }) }).default('THIS_MONTH'),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .superRefine((q, ctx) => {
    if (q.period !== 'CUSTOM') return;
    if (!q.from || !q.to) ctx.addIssue({ code: 'custom', path: ['from'], message: 'Choose both dates of the custom period' });
    else if (q.from > q.to) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The end date cannot be before the start date' });
  });
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
/** Days in a month (1-12), leap years included. */
const monthDays = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * The inclusive date range of a period, from the business date `today` (YYYY-MM-DD). The financial
 * year is Indian: 1 April – 31 March. CUSTOM returns the given dates (validated by the schema).
 */
export function periodRange(period: DashboardPeriod, today: string, custom?: { from?: string; to?: string }): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number);
  switch (period) {
    case 'TODAY':
      return { from: today, to: today };
    case 'THIS_MONTH':
      return { from: iso(y, m, 1), to: iso(y, m, monthDays(y, m)) };
    case 'LAST_MONTH': {
      const [ly, lm] = m === 1 ? [y - 1, 12] : [y, m - 1];
      return { from: iso(ly, lm, 1), to: iso(ly, lm, monthDays(ly, lm)) };
    }
    case 'THIS_FY': {
      const start = m >= 4 ? y : y - 1;
      return { from: iso(start, 4, 1), to: iso(start + 1, 3, 31) };
    }
    case 'CUSTOM':
      return { from: custom?.from ?? today, to: custom?.to ?? today };
  }
}

export interface DashboardSummary {
  period: DashboardPeriod;
  from: string;
  to: string;
  /** The tenant's business date the period and "today" figures were resolved against. */
  today: string;
  /** Appointments (the studio's inquiries) — only for someone who may see Appointments. */
  inquiries?: {
    /** Dated in the period: all, still pending, done. */
    total: number;
    pending: number;
    done: number;
    /** Pending appointments for today, and pending ones dated before today (any period). */
    pendingToday: number;
    overdue: number;
  };
  /** Bills as studio orders — only for someone who may see Billing or Studio Work. */
  orders?: {
    /** Bills dated in the period; completed = Delivery recorded; pending = the rest. */
    total: number;
    completed: number;
    pending: number;
    /** Where the period's orders are now (the derived workflow position). Sums to `total`. */
    byPosition: Record<WorkPosition, number>;
    /** Not delivered, promised for today / promised before today (any period). */
    dueToday: number;
    overdue: number;
  };
  /** Money — only for someone who may see Billing, Receipts or Receivables. Same figures as Reports → Receivables. */
  money?: {
    /** Bills dated in the period, as of today: billed, received against them, still outstanding. */
    billed: number;
    received: number;
    outstanding: number;
    /** Every bill, as of today. */
    totalOutstanding: number;
    billsWithOutstanding: number;
    customersWithOutstanding: number;
  };
}
