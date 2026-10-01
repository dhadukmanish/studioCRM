import { eq, sql } from 'drizzle-orm';
import { WORK_POSITIONS, periodRange, type DashboardQuery, type DashboardSummary, type WorkPosition } from '@erp/shared';
import { db, schema } from '../db/client';
import { businessToday } from './company';
import { receivablesOverview } from './receivables';
import { workPositionSql, workSubquery } from './work';

/**
 * The Dashboard (docs/DASHBOARD.md). Read-only. Each section re-uses the definition its module owns:
 *   inquiries — an appointment is Pending until `completed_at` (services/appointments.ts);
 *   orders    — a bill's workflow position is `workPositionSql` (services/work.ts), Delivery recorded = completed;
 *   money     — `receivablesOverview` (services/receivables.ts), the same figures as Reports → Receivables.
 * A section the caller may not see is not queried at all. Every query carries the tenant predicate.
 */

const A = schema.appointments;
const B = schema.bills;
const n = (v: unknown) => Number(v ?? 0);

export interface DashboardAccess { inquiries: boolean; orders: boolean; money: boolean }

export async function dashboardSummary(tenantId: string, q: DashboardQuery, access: DashboardAccess): Promise<DashboardSummary> {
  const today = await businessToday(tenantId);
  const { from, to } = periodRange(q.period, today, q);
  const out: DashboardSummary = { period: q.period, from, to, today };
  const inPeriod = (col: typeof A.appointmentDate | typeof B.billDate) => sql`${col} between ${from} and ${to}`;
  // Orders stop at today, like the money figures (Receivables counts bills dated up to As of), so
  // Total orders and Billed in period always describe the same bills. Appointments may be booked ahead.
  const billsInPeriod = sql`${B.billDate} between ${from} and ${to < today ? to : today}`;

  const jobs = [];
  if (access.inquiries) {
    jobs.push(
      db
        .select({
          total: sql<number>`(count(*) filter (where ${inPeriod(A.appointmentDate)}))::int`,
          pending: sql<number>`(count(*) filter (where ${inPeriod(A.appointmentDate)} and ${A.completedAt} is null))::int`,
          pendingToday: sql<number>`(count(*) filter (where ${A.appointmentDate} = ${today} and ${A.completedAt} is null))::int`,
          overdue: sql<number>`(count(*) filter (where ${A.appointmentDate} < ${today} and ${A.completedAt} is null))::int`,
        })
        .from(A)
        .where(eq(A.tenantId, tenantId))
        .then(([r]) => {
          out.inquiries = { total: n(r.total), pending: n(r.pending), done: n(r.total) - n(r.pending), pendingToday: n(r.pendingToday), overdue: n(r.overdue) };
        }),
    );
  }
  if (access.orders) {
    const w = workSubquery(tenantId);
    const position = workPositionSql(w);
    const open = sql`${w.delivery} is null`;
    jobs.push(
      db
        .select({
          ...Object.fromEntries(WORK_POSITIONS.map((p) => [p, sql<number>`(count(*) filter (where ${billsInPeriod} and ${position} = ${p}))::int`])),
          dueToday: sql<number>`(count(*) filter (where ${B.deliveryDate} = ${today} and ${open}))::int`,
          overdue: sql<number>`(count(*) filter (where ${B.deliveryDate} < ${today} and ${open}))::int`,
        })
        .from(B)
        .leftJoin(w, eq(w.billId, B.id))
        .where(eq(B.tenantId, tenantId))
        .then(([r]) => {
          const row = r as Record<string, unknown>;
          const byPosition = Object.fromEntries(WORK_POSITIONS.map((p) => [p, n(row[p])])) as Record<WorkPosition, number>;
          const total = WORK_POSITIONS.reduce((t, p) => t + byPosition[p], 0);
          out.orders = { total, completed: byPosition.COMPLETE, pending: total - byPosition.COMPLETE, byPosition, dueToday: n(row.dueToday), overdue: n(row.overdue) };
        }),
    );
  }
  if (access.money) {
    jobs.push(
      Promise.all([receivablesOverview({ tenantId, asOf: today, from, to }), receivablesOverview({ tenantId, asOf: today })]).then(([period, all]) => {
        out.money = {
          billed: period.totalBilled,
          received: period.totalReceived,
          outstanding: period.totalOutstanding,
          totalOutstanding: all.totalOutstanding,
          billsWithOutstanding: all.pendingBills,
          customersWithOutstanding: all.customersWithOutstanding,
        };
      }),
    );
  }
  await Promise.all(jobs);
  return out;
}

