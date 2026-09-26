import { pgTable, uuid, text, date, timestamp, unique, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, ts, tenantRef, users } from './core';
import { bills } from './bills';

/**
 * Bill Work Stage — one recorded milestone of a studio job (docs/STUDIO_WORKFLOW.md).
 *
 * A job is its bill. Its stages are SELECTION, EDITING, WHATSAPP and DELIVERY (`WORK_STAGES`). A row
 * here means that stage is recorded — DONE, or SKIPPED when the studio did not need it; no row means
 * it has not happened yet. Nothing stores a "current status": the next stage follows from which rows
 * exist (`workPosition`), so there is nothing that could drift from the milestones themselves.
 *
 * One row per stage per bill (the unique key), so a double click or two staff members at once
 * cannot record a stage twice. Reopening a stage deletes its row; the activity log keeps the trail.
 *
 * DELIVERY's `completed_on` is the delivered date. The bill's own `delivery_date` stays what it
 * always was — the date the studio PROMISED (the planned delivery).
 */
export const billWorkStages = pgTable(
  'bill_work_stages',
  {
    id: id(),
    tenantId: tenantRef(),
    billId: uuid('bill_id').notNull(),
    /** SELECTION | EDITING | WHATSAPP | DELIVERY — `WORK_STAGES` in `@erp/shared`. */
    stage: text('stage').notNull(),
    /** DONE | SKIPPED. */
    outcome: text('outcome').notNull().default('DONE'),
    /** The business date it was recorded, in the company's time zone — never a browser's. */
    completedOn: date('completed_on', { mode: 'string' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).defaultNow().notNull(),
    /** Written from the signed-in user, never from a payload. SET NULL keeps the milestone if the user goes. */
    completedBy: uuid('completed_by').references(() => users.id, { onDelete: 'set null' }),
    ...ts,
  },
  (t) => [
    /** Part of the bill: deleting a bill deletes its progress (the activity log keeps what happened). */
    foreignKey({ columns: [t.billId, t.tenantId], foreignColumns: [bills.id, bills.tenantId], name: 'bill_work_stages_bill_tenant_fk' }).onDelete('cascade'),
    unique('bill_work_stages_bill_stage_uk').on(t.tenantId, t.billId, t.stage),
    /** The Delivery report's delivered-date order and the queue's per-stage grouping. */
    index('bill_work_stages_tenant_stage_idx').on(t.tenantId, t.stage, t.completedOn),
    check('bill_work_stages_stage_check', sql`${t.stage} IN ('SELECTION', 'EDITING', 'WHATSAPP', 'DELIVERY')`),
    check('bill_work_stages_outcome_check', sql`${t.outcome} IN ('DONE', 'SKIPPED')`),
  ],
);
