import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, HandCoins, MoreHorizontal, RefreshCw, RotateCcw, Search, Wallet } from 'lucide-react';
import { WORK_POSITION_LABELS, WORK_VIEWS, WORK_VIEW_LABELS, type WorkQueueItem, type WorkView } from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { Dropdown, EmptyState, Spinner, TextInput, type MenuItem } from '@/components/ui';
import { NextWorkAction } from '@/components/work/WorkProgress';
import { ApiError } from '@/lib/api';
import { cx, fmtMoney } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { toast } from '@/lib/toast';
import { RECEIPT_INVALIDATES, applyAdvance } from '@/lib/receipts';
import { useWorkActions, useWorkQueue } from '@/lib/work';
import { useAuthStore } from '@/store/auth';
import { ReceivePaymentDialog, type ReceivePaymentFor } from '@/pages/receipts/ReceivePaymentDialog';

const PAGE_SIZE = 50;

const EMPTY: Record<Exclude<WorkView, 'TODAY'>, string> = {
  PENDING: 'Nothing is pending.',
  UPCOMING: 'Nothing is coming up.',
  COMPLETED: 'Nothing completed yet.',
};

/** Columns of a row at desktop width; below `sm` a row stacks into a small card. */
const GRID = 'sm:grid sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)_190px] sm:items-center sm:gap-4';

/**
 * Operations -> Today's Work: the screen a studio employee keeps open all day. Every row says who,
 * the ONE thing to do next, when, and what they owe — with one button that does it. Pressing it
 * turns the row into the next step (Selection -> Editing -> WhatsApp -> Delivery) until the job
 * leaves the list. Nobody manages a status here; the server derives where each job is.
 *
 * Views: Today (default — overdue, today's appointments and deliveries, work under way, new jobs),
 * Pending (everything unfinished), Upcoming, Completed. One search box. Anything uncommon is in •••.
 */
export default function TodaysWorkPage() {
  const [view, setView] = useState<WorkView>('TODAY');
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [paying, setPaying] = useState<ReceivePaymentFor | null>(null);
  const can = useAuthStore((s) => s.can);
  const seesMoney = can('operations_billing') || can('operations_receipts');
  const fmt = useDateFormatters();
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(text.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [text]);

  const q = useWorkQueue(view, { page, limit: PAGE_SIZE, search, sortOrder: 'asc', filters: [] });
  const data = q.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const show = (v: WorkView) => {
    setView(v);
    setPage(1);
  };
  const notToday = data ? data.counts.PENDING - data.counts.TODAY : 0;

  return (
    <>
      <Crumb items={[{ label: 'Operations' }, { label: "Today's Work" }]} />
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[20px] font-semibold text-gray-900">Today&rsquo;s Work</h2>
          {data && <span className="text-[13px] text-gray-500">{fmt.date(data.today)}</span>}
        </div>
        <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => q.refetch()}>
          <RefreshCw className={cx('h-4 w-4', q.isFetching && 'animate-spin')} />
        </button>
      </div>

      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div role="group" aria-label="Show" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {WORK_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => show(v)}
              className={cx(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] transition max-sm:h-9',
                view === v ? 'border-primary/40 bg-primary-50 font-medium text-primary-dark' : 'border-line bg-surface text-gray-600 hover:bg-gray-50',
              )}
            >
              {WORK_VIEW_LABELS[v]}
              {v !== 'COMPLETED' && <span className={cx('tabular-nums', view === v ? 'text-primary-dark' : 'text-gray-400')}>{data?.counts[v] ?? '·'}</span>}
            </button>
          ))}
        </div>
        <div className="relative w-full lg:w-[320px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" strokeWidth={1.5} />
          <TextInput className="pl-9" placeholder="Search name, mobile, bill or appt no." aria-label="Search work" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
      </div>
      {data?.searchedAllPending && <p className="mb-2 text-[12.5px] text-gray-500">Showing matches from all pending work.</p>}

      {q.isLoading ? (
        <div className="card flex justify-center py-16"><Spinner className="h-5 w-5 text-primary" /></div>
      ) : q.isError ? (
        <div className="card"><EmptyState title="Today's work could not be loaded" action={<button type="button" className="btn-outline" onClick={() => q.refetch()}>Try again</button>} /></div>
      ) : !data || data.rows.length === 0 ? (
        <div className="card">
          {search ? (
            <EmptyState title="Nothing matches that search" description="Try a name, a mobile number, or a bill or appointment number." />
          ) : view === 'TODAY' ? (
            <EmptyState
              icon={<CheckCircle2 className="work-check h-9 w-9" strokeWidth={1.25} />}
              title="You're all caught up for today."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  {data && data.counts.UPCOMING > 0 && <button type="button" className="btn-outline" onClick={() => show('UPCOMING')}>View upcoming work</button>}
                  {notToday > 0 && <button type="button" className="btn-ghost" onClick={() => show('PENDING')}>{notToday} other pending</button>}
                </div>
              }
            />
          ) : (
            <EmptyState icon={<CheckCircle2 className="h-8 w-8" strokeWidth={1.25} />} title={EMPTY[view]} />
          )}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className={cx('hidden border-b border-line bg-head px-4 py-2 text-[12px] text-gray-500', GRID)} aria-hidden="true">
            <span>Customer</span>
            <span>Work</span>
            <span>{view === 'COMPLETED' ? 'Done on' : 'When'}</span>
            <span>{seesMoney ? 'Payment' : ''}</span>
            <span />
          </div>
          <ul className="divide-y divide-line">
            {data.rows.map((r) => (
              <WorkRow key={`${r.kind}-${r.id}`} row={r} today={data.today} onReceive={setPaying} />
            ))}
          </ul>
        </div>
      )}

      {data && view === 'TODAY' && !search && data.rows.length > 0 && notToday > 0 && page >= pages && (
        <p className="mt-3 text-[13px] text-gray-500">
          {notToday} more pending, not due today.{' '}
          <button type="button" className="link" onClick={() => show('PENDING')}>View pending</button>
        </p>
      )}
      {data && data.total > PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-end gap-2 text-[13px] text-gray-600">
          <span>Page {page} of {pages}</span>
          <button type="button" className="icon-btn" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" className="icon-btn" aria-label="Next page" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-4 w-4" /></button>
        </div>
      )}

      <ReceivePaymentDialog open={!!paying} onClose={() => setPaying(null)} payment={paying} />
    </>
  );
}

function WorkRow({ row: r, today, onReceive }: { row: WorkQueueItem; today: string; onReceive: (p: ReceivePaymentFor) => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const fmt = useDateFormatters();
  const act = useWorkActions();
  const [applying, setApplying] = useState(false);
  const isBill = r.kind === 'BILL';
  const done = r.next === 'COMPLETE';
  const due = r.outstandingAmount ?? 0;
  const canReceive = can('operations_receipts', 'create');
  const seesMoney = can('operations_billing') || can('operations_receipts');

  /* ---- the one thing to do, and when ---- */
  const work = done
    ? isBill ? (r.deliveryOutcome === 'SKIPPED' ? 'Delivery not needed' : 'Delivered') : 'Appointment done'
    : r.next === 'APPOINTMENT'
      ? `Appointment${r.dueTime ? ` · ${fmt.time(r.dueTime)}` : ''}`
      : WORK_POSITION_LABELS[r.next];
  const when = done
    ? fmt.stamp(r.completedAt)
    : r.overdue
      ? `Overdue · ${fmt.date(r.dueDate)}`
      : !isBill
        ? r.dueDate === today ? 'Today' : fmt.date(r.dueDate)
        : r.plannedDelivery
          ? r.plannedDelivery === today ? 'Due today' : `Due ${fmt.date(r.plannedDelivery)}`
          : r.billDate === today ? 'New today' : `Billed ${fmt.date(r.billDate)}`;
  const quietWhen = isBill && !r.plannedDelivery && !done;

  /* ---- ••• ---- */
  const apply = async () => {
    setApplying(true);
    try {
      const res = await applyAdvance(r.id, r.advanceToApply);
      toast.success(res.message);
      RECEIPT_INVALIDATES.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'The advance could not be applied');
    } finally {
      setApplying(false);
    }
  };
  const receive = () => onReceive({ customerKey: r.mobileSearch, customerName: r.customerName, bill: isBill ? { id: r.id, reference: r.reference, due } : undefined });
  const moneyItems: MenuItem[] = [
    ...(canReceive && isBill && r.advanceToApply > 0 ? [{ label: `Apply ${fmtMoney(r.advanceToApply)} advance`, icon: <Wallet className="h-3.5 w-3.5" />, disabled: applying, onClick: apply }] : []),
    ...(canReceive && (!isBill || due > 0) ? [{ label: 'Receive payment', icon: <HandCoins className="h-3.5 w-3.5" />, onClick: receive }] : []),
  ];
  const billItems: MenuItem[] = isBill && can('operations_billing')
    ? [
        { label: 'Open bill', icon: <ExternalLink className="h-3.5 w-3.5" />, onClick: () => nav(`/modules/billing/${r.id}`) },
        ...(!done && can('operations_billing', 'update') ? [{ label: r.plannedDelivery ? 'Change delivery date' : 'Set delivery date', icon: <CalendarDays className="h-3.5 w-3.5" />, onClick: () => nav(`/modules/billing/${r.id}`) }] : []),
      ]
    : [];
  const canAppt = can('operations_appointments', 'update');
  const apptItems: MenuItem[] = !isBill && done && canAppt ? [{ label: 'Mark as pending', icon: <RotateCcw className="h-3.5 w-3.5" />, onClick: () => act.mutate({ type: 'appointment-reopen', id: r.id }) }] : [];

  return (
    <li className={cx('flex flex-col gap-1 px-4 py-3 sm:py-2.5', GRID)}>
      <div className="min-w-0">
        <p className="truncate text-[14px] text-gray-900">
          {r.customerName}
          {r.babyName && <span className="text-gray-500"> · {r.babyName}</span>}
        </p>
        <p className="truncate text-[12px] text-gray-400">
          {isBill ? `Bill ${r.reference}` : `Appt ${r.reference}`} · {r.mobileNumber}
        </p>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-1.5 text-[13.5px] sm:contents">
        <span className={cx('font-medium', done ? 'inline-flex items-center gap-1 font-normal text-gray-500' : 'text-gray-900')}>
          {done && <CheckCircle2 className="work-check h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />}
          {work}
        </span>
        <span aria-hidden="true" className="text-gray-300 sm:hidden">·</span>
        <span className={cx('tabular-nums', r.overdue ? 'font-medium text-red-600' : quietWhen ? 'text-gray-400' : 'text-gray-600')}>{when}</span>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
        {isBill ? (
          r.outstandingAmount === null ? null : due > 0 ? <span className="tabular-nums text-gray-900">{fmtMoney(due)} Due</span> : <span className="text-gray-500">Paid</span>
        ) : r.availableAdvance <= 0 && seesMoney ? (
          <span className="text-gray-300 max-sm:hidden">—</span>
        ) : null}
        {r.availableAdvance > 0 && (isBill ? r.advanceToApply > 0 : true) && <span className="tabular-nums text-primary-dark">{fmtMoney(r.availableAdvance)} Advance</span>}
      </div>

      <div className="flex items-center justify-end gap-1.5 max-sm:mt-1.5">
        {isBill ? (
          <NextWorkAction billId={r.id} position={r.next === 'APPOINTMENT' ? 'SELECTION' : r.next} canUpdate={can('operations_work', 'update')} extraItems={[...moneyItems, ...billItems]} />
        ) : (
          <div className="flex items-center gap-1.5 max-sm:w-full">
            {!done && canAppt && (
              <button
                type="button"
                className="btn-primary h-8 min-w-[104px] px-3 text-[13px] max-sm:h-[44px] max-sm:flex-1"
                aria-label={`Appointment ${r.reference} done`}
                disabled={act.isPending}
                onClick={() => act.mutate({ type: 'appointment-done', id: r.id })}
              >
                {act.isPending ? <Spinner className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />} Done
              </button>
            )}
            {moneyItems.length + apptItems.length > 0 && (
              <Dropdown
                trigger={<button type="button" className="row-action max-sm:h-[44px] max-sm:w-[44px]" aria-label="More actions" title="More actions"><MoreHorizontal className="h-4 w-4" /></button>}
                items={[...moneyItems, ...apptItems]}
              />
            )}
          </div>
        )}
      </div>
    </li>
  );
}
