import { useState } from 'react';
import { Check, CheckCircle2, MessageCircle, MoreHorizontal, PackageCheck, RotateCcw, SkipForward } from 'lucide-react';
import { WORK_STAGES, WORK_STAGE_ACTIONS, WORK_STAGE_ACTION_NAMES, WORK_STAGE_LABELS, type WorkPosition, type WorkStage, type WorkStageOutcome } from '@erp/shared';
import { ConfirmDialog, Dropdown, Spinner, type MenuItem } from '@/components/ui';
import { useAuthStore } from '@/store/auth';
import { ShareInvoiceDialog } from '@/components/invoice/ShareInvoiceDialog';
import { cx } from '@/lib/format';
import { useWorkActions } from '@/lib/work';

/**
 * The studio workflow on screen (docs/STUDIO_WORKFLOW.md). The staff member sees the ONE thing to do
 * next and one button for it; nobody picks a status. Everything uncommon — skip a step, undo the
 * last one — sits in the ••• menu.
 */

export type Recorded = Partial<Record<WorkStage, WorkStageOutcome>>;

/**
 * A quiet one-line trail — "Selection ✓ · Editing ● · WhatsApp · Delivery" — secondary to the next
 * action. Every state is spelled out for screen readers, never carried by the mark alone.
 */
export function WorkSteps({ recorded, position, className }: { recorded: Recorded; position: WorkPosition; className?: string }) {
  return (
    <ol aria-label="Steps" className={cx('flex flex-wrap items-center gap-x-1.5 text-[12px] text-gray-400', className)}>
      {WORK_STAGES.map((s, i) => {
        const outcome = recorded[s];
        const current = position === s;
        return (
          <li key={s} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden="true">·</span>}
            <span className={cx('inline-flex items-center gap-1', current && 'font-medium text-primary-dark', !current && outcome && 'text-gray-600')}>
              {WORK_STAGE_LABELS[s]}
              {outcome === 'DONE' && <Check className="work-check h-3 w-3" strokeWidth={2.5} aria-hidden="true" />}
              {outcome === 'SKIPPED' && <SkipForward className="h-3 w-3" strokeWidth={2} aria-hidden="true" />}
              {current && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-primary" />}
              <span className="sr-only">{outcome === 'DONE' ? ': done' : outcome === 'SKIPPED' ? ': skipped' : current ? ': next' : ': to do'}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const ACTION_ICON: Record<WorkStage, typeof Check> = { SELECTION: CheckCircle2, EDITING: CheckCircle2, WHATSAPP: MessageCircle, DELIVERY: PackageCheck };

/** The step just before the current one — what "Mark … pending" reopens. It is the furthest recorded step, by definition of the position. */
const previousStage = (position: WorkPosition): WorkStage | null => (position === 'COMPLETE' ? 'DELIVERY' : WORK_STAGES[WORK_STAGES.indexOf(position) - 1] ?? null);

interface ActionProps {
  billId: string;
  position: WorkPosition;
  /** Studio Work edit. Without it no step can be recorded, skipped or undone from here. */
  canUpdate: boolean;
  /** Other things this row can do (Open bill, Receive payment …) — in the ••• menu, never beside the primary. */
  extraItems?: MenuItem[];
  /** `row`: a list row (full width on a phone). `page`: the bill screen. */
  size?: 'row' | 'page';
  disabled?: boolean;
}

/**
 * The next action as ONE primary button — Done / Done / Share / Delivered — plus the ••• menu.
 * WhatsApp's button opens the existing share dialog; opening WhatsApp there records the step, so
 * the app never claims a message it did not open. Undoing a delivery asks first (it clears the
 * delivered date); everything else is one click and one click to put back.
 */
export function NextWorkAction({ billId, position, canUpdate, extraItems = [], size = 'row', disabled }: ActionProps) {
  const act = useWorkActions();
  const [sharing, setSharing] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  // The share dialog needs Billing read; without it WhatsApp can only be skipped (•••).
  const canShare = useAuthStore((s) => s.can)('operations_billing');
  const busy = act.isPending;
  const stage = position === 'COMPLETE' ? null : position;
  const showPrimary = !!stage && canUpdate && (stage !== 'WHATSAPP' || canShare);
  const prev = previousStage(position);

  const menu: MenuItem[] = [
    ...extraItems,
    ...(canUpdate && (stage || prev) && extraItems.length ? [{ label: '', divider: true }] : []),
    ...(canUpdate && stage ? [{ label: `Skip ${WORK_STAGE_LABELS[stage]}`, icon: <SkipForward className="h-3.5 w-3.5" />, onClick: () => act.mutate({ type: 'record', billId, stage, outcome: 'SKIPPED' }) }] : []),
    ...(canUpdate && prev
      ? [{ label: `Mark ${WORK_STAGE_LABELS[prev]} pending`, icon: <RotateCcw className="h-3.5 w-3.5" />, onClick: () => (prev === 'DELIVERY' ? setConfirmUndo(true) : act.mutate({ type: 'reopen', billId, stage: prev })) }]
      : []),
  ];

  const primary = () => {
    if (!stage) return;
    if (stage === 'WHATSAPP') setSharing(true);
    else act.mutate({ type: 'record', billId, stage });
  };
  const Icon = stage ? ACTION_ICON[stage] : Check;

  return (
    <div className={cx('flex items-center gap-1.5', size === 'row' && 'max-sm:w-full')} onClick={(e) => e.stopPropagation()}>
      {stage && showPrimary && (
        <button
          type="button"
          className={cx('btn-primary', size === 'row' ? 'h-8 min-w-[104px] px-3 text-[13px] max-sm:h-[44px] max-sm:flex-1' : 'max-sm:h-10')}
          disabled={disabled || busy}
          aria-label={WORK_STAGE_ACTION_NAMES[stage]}
          title={disabled ? 'Save your changes first' : WORK_STAGE_ACTION_NAMES[stage]}
          onClick={primary}
        >
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />}
          {WORK_STAGE_ACTIONS[stage]}
        </button>
      )}
      {menu.length > 0 && (
        <Dropdown
          trigger={
            <button type="button" className={cx('row-action', size === 'row' && 'max-sm:h-[44px] max-sm:w-[44px]')} aria-label="More actions" title="More actions" disabled={disabled}>
              <MoreHorizontal className="h-4 w-4" />
            </button>
          }
          items={menu}
        />
      )}
      {sharing && <ShareInvoiceDialog billId={billId} open onClose={() => setSharing(false)} workStage="WHATSAPP" />}
      <ConfirmDialog
        open={confirmUndo}
        onClose={() => setConfirmUndo(false)}
        loading={busy}
        title="Undo delivery?"
        confirmText="Undo delivery"
        message="The job goes back to waiting for delivery. The activity log keeps a record."
        onConfirm={() => act.mutate({ type: 'reopen', billId, stage: 'DELIVERY' }, { onSettled: () => setConfirmUndo(false) })}
      />
    </div>
  );
}

/** A stage-by-stage map from the server's recorded stages. */
export const recordedOf = (stages: { stage: WorkStage; outcome: WorkStageOutcome }[]): Recorded => Object.fromEntries(stages.map((s) => [s.stage, s.outcome]));
