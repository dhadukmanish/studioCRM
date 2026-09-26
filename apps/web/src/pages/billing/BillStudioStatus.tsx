import { useState } from 'react';
import { Check, MoreHorizontal, RotateCcw, SkipForward } from 'lucide-react';
import { WORK_STAGES, WORK_STAGE_LABELS, type WorkStage } from '@erp/shared';
import { ConfirmDialog, Dropdown, Spinner, type MenuItem } from '@/components/ui';
import { ShareInvoiceDialog } from '@/components/invoice/ShareInvoiceDialog';
import { recordedOf } from '@/components/work/WorkProgress';
import { cx } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { useBillWork, useWorkActions } from '@/lib/work';
import { useAuthStore } from '@/store/auth';

/**
 * Studio Status on a saved bill — the job's actual progress, and where an authorised operator
 * records or corrects it by hand. The SAME rows Today's Work reads and writes (`bill_work_stages`
 * via `/api/work/bills/:id`), so a click here is what Today's Work shows next, and the reverse.
 *
 *   ✓ done        a recorded step; click → who/when, and "Mark pending" to correct a mistake
 *   ● next        the recommended step (highlighted); click → done
 *   ○ not done    any other step; click → done — staff record what really happened, in any order,
 *                 and nobody has to fake an earlier step to get the job to where it really is
 *
 * WhatsApp is never ticked by hand: its chip opens the real share dialog, and only opening WhatsApp
 * there records it ("opened" — the app cannot know sent or read). Delivered is its own date; the
 * bill's Delivery Date stays the PLANNED one. Every state is in text as well as the mark.
 */
export function BillStudioStatus({ billId, plannedDelivery, dirty, className }: { billId: string; plannedDelivery: string | null; dirty: boolean; className?: string }) {
  const can = useAuthStore((s) => s.can);
  const visible = can('operations_work');
  const canUpdate = can('operations_work', 'update');
  const canShare = can('operations_billing');
  const q = useBillWork(billId, visible);
  const act = useWorkActions();
  const fmt = useDateFormatters();
  const [sharing, setSharing] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  if (!visible) return null;

  const w = q.data;
  const recorded = w ? recordedOf(w.stages) : {};
  const recordOf = (s: WorkStage) => w?.stages.find((x) => x.stage === s);
  const delivered = recordOf('DELIVERY');
  const blocked = dirty || act.isPending;
  const why = dirty ? 'Save your changes first' : undefined;

  const markDone = (s: WorkStage) => (s === 'WHATSAPP' ? setSharing(true) : act.mutate({ type: 'record', billId, stage: s }));
  const markPending = (s: WorkStage) => (s === 'DELIVERY' ? setConfirmUndo(true) : act.mutate({ type: 'reopen', billId, stage: s }));

  const chip = (s: WorkStage) => {
    const outcome = recorded[s];
    const current = w?.position === s;
    const label = WORK_STAGE_LABELS[s];
    const state = outcome === 'DONE' ? (s === 'WHATSAPP' ? 'opened' : 'done') : outcome === 'SKIPPED' ? 'skipped' : current ? 'next' : 'not done';
    const look = cx(
      'inline-flex h-8 min-w-0 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12.5px] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 max-sm:h-[44px]',
      outcome === 'DONE' && 'border-line bg-surface text-gray-700',
      outcome === 'SKIPPED' && 'border-line bg-surface text-gray-500',
      !outcome && current && 'border-primary/50 bg-primary-50 font-medium text-primary-dark',
      !outcome && !current && 'border-dashed border-gray-300 bg-surface text-gray-500',
      canUpdate && !blocked && 'hover:border-primary/50',
    );
    const mark =
      outcome === 'DONE' ? <Check className="work-check h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
      : outcome === 'SKIPPED' ? <SkipForward className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      : <span aria-hidden="true" className={cx('h-2 w-2 rounded-full', current ? 'bg-primary' : 'border border-gray-400')} />;
    const body = (
      <>
        {mark}
        <span className="truncate">{label}</span>
      </>
    );
    // Read-only: the state, spelled out, with nothing to press.
    if (!canUpdate) return <span className={look} aria-label={`${label}: ${state}`}>{body}</span>;

    const rec = recordOf(s);
    if (outcome && rec) {
      const items: MenuItem[] = [
        { label: <span className="text-gray-500">{outcome === 'SKIPPED' ? 'Skipped' : s === 'WHATSAPP' ? 'WhatsApp opened' : 'Done'} {fmt.date(rec.completedOn)}{rec.completedByName ? ` · ${rec.completedByName}` : ''}</span>, disabled: true },
        { label: `Mark ${label} pending`, icon: <RotateCcw className="h-3.5 w-3.5" />, onClick: () => markPending(s) },
      ];
      return (
        <Dropdown
          align="left"
          items={items}
          trigger={<button type="button" className={look} disabled={blocked} title={why} aria-label={`${label}: ${state}. Options`}>{body}</button>}
        />
      );
    }
    const noShare = s === 'WHATSAPP' && !canShare;
    return (
      <button
        type="button"
        className={look}
        disabled={blocked || noShare}
        title={why ?? (noShare ? 'Sharing needs Billing access' : s === 'WHATSAPP' ? 'Share on WhatsApp' : `Mark ${label} done`)}
        aria-label={`${label}: ${state}. ${s === 'WHATSAPP' ? 'Share on WhatsApp' : 'Mark done'}`}
        onClick={() => markDone(s)}
      >
        {body}
      </button>
    );
  };

  const next = w && w.position !== 'COMPLETE' ? w.position : null;

  return (
    <section aria-label="Studio Status" className={cx('w-fit min-w-0 max-w-full', className)}>
      <div className="mb-2 flex items-center justify-between gap-6">
        <h3 className="section-title">Studio Status</h3>
        <div className="flex items-center gap-1.5 text-[12.5px] text-gray-500">
          {act.isPending && <Spinner className="h-3 w-3" />}
          {w && (next ? <span>Next: <span className="font-medium text-gray-800">{WORK_STAGE_LABELS[next]}</span></span> : <span className="text-gray-700">Job done</span>)}
          {canUpdate && next && (
            <Dropdown
              items={[{ label: `Skip ${WORK_STAGE_LABELS[next]}`, icon: <SkipForward className="h-3.5 w-3.5" />, onClick: () => act.mutate({ type: 'record', billId, stage: next, outcome: 'SKIPPED' }) }]}
              trigger={<button type="button" className="row-action h-7 w-7" aria-label="More studio actions" title={why ?? 'More'} disabled={blocked}><MoreHorizontal className="h-4 w-4" /></button>}
            />
          )}
        </div>
      </div>

      {q.isLoading && <p className="flex items-center gap-1.5 text-[13px] text-gray-500"><Spinner className="h-3 w-3" /> Loading…</p>}
      {q.isError && <p className="text-[13px] text-red-600">Studio status could not be loaded.</p>}
      {w && (
        <>
          <ol className="flex flex-wrap items-center gap-y-1.5">
            {WORK_STAGES.map((s, i) => (
              <li key={s} className="flex min-w-0 items-center">
                {i > 0 && <span aria-hidden="true" className="mx-1 h-px w-3 bg-line sm:w-4" />}
                {chip(s)}
              </li>
            ))}
          </ol>
          {dirty && canUpdate && <p className="mt-2 text-[12px] text-amber-700">Save the bill to update its studio status.</p>}
          <p className="mt-2 text-[12px] text-gray-500">
            {plannedDelivery ? `Planned delivery ${fmt.date(plannedDelivery)}` : 'No planned delivery date'}
            {delivered && ` · ${delivered.outcome === 'DONE' ? `Delivered ${fmt.date(delivered.completedOn)}` : 'Delivery not needed'}`}
          </p>
        </>
      )}

      {sharing && <ShareInvoiceDialog billId={billId} open onClose={() => setSharing(false)} workStage="WHATSAPP" />}
      <ConfirmDialog
        open={confirmUndo}
        onClose={() => setConfirmUndo(false)}
        loading={act.isPending}
        title="Mark delivery pending?"
        confirmText="Mark pending"
        message="The job goes back to waiting for delivery. The activity log keeps a record."
        onConfirm={() => act.mutate({ type: 'reopen', billId, stage: 'DELIVERY' }, { onSettled: () => setConfirmUndo(false) })}
      />
    </section>
  );
}
