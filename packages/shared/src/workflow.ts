import { z } from 'zod';
import { isIsoDate } from './dates.js';
import type { BillPaymentStatus } from './receipts.js';

/**
 * The studio workflow (docs/STUDIO_WORKFLOW.md): what happens to a job after its bill is saved.
 *
 *   Selection -> Editing -> WhatsApp -> Delivery
 *
 * Selection: the customer chose their photos. Editing: PHOTO editing is finished — never "the bill
 * was edited". WhatsApp: WhatsApp was OPENED from the workflow to message the customer; the app
 * cannot know whether a message was sent, delivered or read, and never says so. Delivery: the work
 * was handed over.
 *
 * Nobody picks a status. A stage is either recorded (Done, or Skipped when the studio did not need
 * it) or it is not; the CURRENT stage — the next thing to do — follows from that. The order guides
 * the staff member; it does not block them: any stage can be recorded or reopened, and a job whose
 * Delivery is recorded is complete whatever happened before it.
 *
 * The workflow is operational only. Delivered never means Paid: payment stays the receipts' derived
 * position (docs/RECEIPTS_PAYMENTS.md).
 */

export const WORK_STAGES = ['SELECTION', 'EDITING', 'WHATSAPP', 'DELIVERY'] as const;
export type WorkStage = (typeof WORK_STAGES)[number];
export const WORK_STAGE_LABELS: Record<WorkStage, string> = { SELECTION: 'Selection', EDITING: 'Editing', WHATSAPP: 'WhatsApp', DELIVERY: 'Delivery' };

/**
 * The one button a pending stage offers — a plain verb, because the stage is always named beside it
 * ("Editing  [Done]"). `WORK_STAGE_ACTION_NAMES` is the button's full accessible name.
 */
export const WORK_STAGE_ACTIONS: Record<WorkStage, string> = { SELECTION: 'Done', EDITING: 'Done', WHATSAPP: 'Share', DELIVERY: 'Delivered' };
export const WORK_STAGE_ACTION_NAMES: Record<WorkStage, string> = {
  SELECTION: 'Selection done',
  EDITING: 'Editing done',
  WHATSAPP: 'Share on WhatsApp',
  DELIVERY: 'Mark delivered',
};

/** How a recorded stage reads. WhatsApp says only what the app knows: it was opened. */
export const WORK_STAGE_DONE_LABELS: Record<WorkStage, string> = {
  SELECTION: 'Selection done',
  EDITING: 'Editing done',
  WHATSAPP: 'WhatsApp opened',
  DELIVERY: 'Delivered',
};

/** DONE = the stage happened. SKIPPED = the studio did not need it for this job — never a fake completion. */
export const WORK_STAGE_OUTCOMES = ['DONE', 'SKIPPED'] as const;
export type WorkStageOutcome = (typeof WORK_STAGE_OUTCOMES)[number];

/** A job's position: the stage to do next, or COMPLETE. */
export const WORK_POSITIONS = [...WORK_STAGES, 'COMPLETE'] as const;
export type WorkPosition = (typeof WORK_POSITIONS)[number];
export const WORK_POSITION_LABELS: Record<WorkPosition, string> = { ...WORK_STAGE_LABELS, COMPLETE: 'Done' };

/**
 * The next thing to do: the stage AFTER the furthest one recorded (Selection when nothing is), and
 * COMPLETE once Delivery is recorded. Staff record what actually happened, in any order — marking
 * Editing done moves the job on to WhatsApp without anyone having to fake a Selection first; the
 * unrecorded Selection simply stays unrecorded. The SQL in `services/work.ts` (`workPositionSql`)
 * mirrors this exactly.
 */
export function workPosition(recorded: Partial<Record<WorkStage, WorkStageOutcome>>): WorkPosition {
  if (recorded.DELIVERY) return 'COMPLETE';
  const furthest = WORK_STAGES.reduce((at, s, i) => (recorded[s] ? i : at), -1);
  return WORK_STAGES[furthest + 1] ?? 'COMPLETE';
}

/**
 * Recording a stage by hand. WhatsApp can only be SKIPPED this way: it is marked done by actually
 * opening WhatsApp from the workflow (`share-opened` with `workStage`), so the app never claims
 * something it did not do.
 */
export const workStageRecordSchema = z
  .object({ outcome: z.enum(WORK_STAGE_OUTCOMES).default('DONE') })
  .default({ outcome: 'DONE' });
export type WorkStageRecordInput = z.infer<typeof workStageRecordSchema>;

/* ------------------------------------------------------------ API shapes -- */

export interface WorkStageRecord {
  stage: WorkStage;
  outcome: WorkStageOutcome;
  /** The business date it was recorded ("YYYY-MM-DD", the company's time zone) — for Delivery, the delivered date. */
  completedOn: string;
  completedAt: string;
  completedByName: string | null;
}

/** GET /api/work/bills/:id — one job's progress. */
export interface BillWorkStatus {
  billId: string;
  position: WorkPosition;
  /** Only the stages that have been recorded, in workflow order. */
  stages: WorkStageRecord[];
  /** The planned delivery date (the bill's Delivery Date), if one was promised. */
  plannedDelivery: string | null;
}

/* ---------------------------------------------------------- today's work -- */

/**
 * Today's Work (served by /api/work/queue): ONE list of what needs doing — appointments and jobs,
 * each at the one thing to do next. Four plain views, never a filter panel:
 *
 *   TODAY     what needs doing now, most urgent first:
 *               1 overdue — a missed appointment, or a promised delivery date that has passed
 *               2 today's appointments (by time)
 *               3 deliveries promised for today
 *               4 jobs under way (a step already recorded) and jobs billed today
 *   PENDING   everything not finished, in the same order — incl. jobs not started and not dated
 *   UPCOMING  appointments and promised deliveries after today, soonest first
 *   COMPLETED appointments Done and jobs delivered, most recent first
 *
 * A search on the Today view looks through everything not finished, so nobody has to guess which
 * view a customer is in.
 */
export const WORK_VIEWS = ['TODAY', 'PENDING', 'UPCOMING', 'COMPLETED'] as const;
export type WorkView = (typeof WORK_VIEWS)[number];
export const WORK_VIEW_LABELS: Record<WorkView, string> = { TODAY: 'Today', PENDING: 'Pending', UPCOMING: 'Upcoming', COMPLETED: 'Completed' };

export const workQueueQuerySchema = z.object({
  view: z.enum(WORK_VIEWS).default('TODAY'),
  search: z.string().trim().max(100).optional(),
});

export interface WorkQueueItem {
  kind: 'APPOINTMENT' | 'BILL';
  id: string;
  /** "#12" for an appointment, "2026-27/5" for a bill. */
  reference: string;
  customerName: string;
  mobileNumber: string;
  babyName: string | null;
  /** APPOINTMENT for a pending appointment, a job's current step, or COMPLETE once done. */
  next: 'APPOINTMENT' | WorkPosition;
  /** The date that matters: the appointment date, or the job's promised delivery (else its bill date). */
  dueDate: string;
  dueTime: string | null;
  /** True only against a real date: an appointment day, or a promised delivery date — never the bill date. */
  overdue: boolean;
  /** Bills only. */
  billDate: string | null;
  plannedDelivery: string | null;
  /** Bills: Delivery's recorded outcome — SKIPPED reads "Delivery not needed", never "Delivered". */
  deliveryOutcome: WorkStageOutcome | null;
  /** When it was finished (appointment Done / delivered), an ISO timestamp — Completed view. */
  completedAt: string | null;
  mobileSearch: string;
  paymentStatus: BillPaymentStatus | null;
  outstandingAmount: number | null;
  /** Due / payment / advance are null / 0 for someone without Billing or Receipts read. */
  /** The customer's advance not yet applied to any bill — derived, 0 when none. */
  availableAdvance: number;
  /** Bills: what Apply advance would propose — min(available advance, due); 0 when nothing to apply. */
  advanceToApply: number;
}

export interface WorkQueue {
  today: string;
  view: WorkView;
  /** A search on the Today view looked through everything not finished. */
  searchedAllPending: boolean;
  rows: WorkQueueItem[];
  total: number;
  page: number;
  pageSize: number;
  /** Rows per view with no search applied — the view chips' counts. */
  counts: Record<WorkView, number>;
}

/* -------------------------------------------------------- delivery report -- */

/**
 * Reports -> Delivery. PENDING (default) = Delivery not recorded. DUE_TODAY / OVERDUE are measured
 * against the bill's Delivery Date — the date the studio promised — and only bills that have one
 * can be due or overdue. DELIVERED = Delivery recorded as done.
 */
export const DELIVERY_VIEWS = ['PENDING', 'DUE_TODAY', 'OVERDUE', 'DELIVERED', 'ALL'] as const;
export type DeliveryView = (typeof DELIVERY_VIEWS)[number];
export const DELIVERY_VIEW_LABELS: Record<DeliveryView, string> = { PENDING: 'Pending', DUE_TODAY: 'Due today', OVERDUE: 'Overdue', DELIVERED: 'Delivered', ALL: 'All' };

const isoDate = (label: string) => z.string().refine(isIsoDate, `${label} must be a valid date (YYYY-MM-DD)`).optional();
const flag = z.preprocess((v) => v === true || v === '1' || v === 'true', z.boolean()).default(false);

/** `from` / `to` narrow the BILL date. */
export const deliveryReportQuerySchema = z
  .object({
    view: z.enum(DELIVERY_VIEWS).default('PENDING'),
    search: z.string().trim().max(100).optional(),
    from: isoDate('From'),
    to: isoDate('To'),
    full: flag,
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'From must not be after To', path: ['to'] });

export interface DeliveryReportRow {
  id: string;
  bookNumber: string;
  billNumber: number;
  billDate: string;
  customerName: string;
  mobileNumber: string;
  mobileSearch: string;
  babyName: string | null;
  plannedDelivery: string | null;
  position: WorkPosition;
  /** The delivered date when Delivery is recorded as done. */
  deliveredOn: string | null;
  deliveryOutcome: WorkStageOutcome | null;
  /** Money only for someone who may see it (Billing or Receipts view); null otherwise, as on Today's Work. */
  grandTotal: number | null;
  paymentStatus: BillPaymentStatus | null;
  outstandingAmount: number | null;
}

export interface DeliveryReport {
  today: string;
  rows: DeliveryReportRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<DeliveryView, number>;
}

/* ------------------------------------------------------------ appointments -- */

/**
 * An appointment is PENDING until someone marks it Done (one click); Done is history, never a
 * deletion. The views: TODAY / UPCOMING are pending appointments on / after today; PENDING is every
 * pending one, oldest first (a missed one stays visible until someone deals with it).
 */
export const APPOINTMENT_STATUSES = ['PENDING', 'DONE'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = { PENDING: 'Pending', DONE: 'Done' };

export const APPOINTMENT_VIEWS = ['TODAY', 'UPCOMING', 'PENDING', 'DONE', 'ALL'] as const;
export type AppointmentView = (typeof APPOINTMENT_VIEWS)[number];
export const APPOINTMENT_VIEW_LABELS: Record<AppointmentView, string> = { TODAY: 'Today', UPCOMING: 'Upcoming', PENDING: 'Pending', DONE: 'Done', ALL: 'All' };

/** The appointment list / report narrowing: a view plus an optional appointment-date range. */
export const appointmentViewQuerySchema = z
  .object({
    view: z.enum(APPOINTMENT_VIEWS).default('ALL'),
    from: isoDate('From'),
    to: isoDate('To'),
    full: flag,
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'From must not be after To', path: ['to'] });

/** The most rows one CSV or print carries. Past it the request is refused — never silently cut. */
export const WORK_EXPORT_MAX_ROWS = 20_000;
