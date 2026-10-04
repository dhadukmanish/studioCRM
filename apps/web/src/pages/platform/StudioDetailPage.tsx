import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, Download, KeyRound, Pencil, Plus, Power, RotateCcw } from 'lucide-react';
import { PLAN_KIND_LABELS } from '@erp/shared';
import { DataTable, type Column } from '@/components/data/DataTable';
import { Badge, ConfirmDialog, EmptyState, Spinner } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { saveFile } from '@/lib/invoice';
import { platformApi } from '@/lib/platformApi';
import { toast } from '@/lib/toast';
import { fmtMoney } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { PAYMENT_MODE_LABELS, usePlatformSave, usePlatformToday, useStudio, type Period, type StudioDetail } from './queries';
import { daysLeftText, StatusBadge } from './StatusBadge';
import { GrantDialog } from './GrantFields';
import { CancelPeriodDialog, OwnerPasswordDialog, RenameDialog } from './StudioDialogs';
import { RestoreDialog } from './RestoreDialog';

/**
 * Only the latest ACTIVE period can be cancelled (an earlier one is refused, 409 SUB_004): the one
 * with the greatest endsOn, ties broken by the latest createdAt. Which row offers Cancel follows that rule.
 */
export function cancellablePeriodId(periods: Period[]): string | null {
  let best: Period | null = null;
  for (const p of periods) {
    if (p.status !== 'ACTIVE') continue;
    if (!best || p.endsOn > best.endsOn || (p.endsOn === best.endsOn && p.createdAt > best.createdAt)) best = p;
  }
  return best?.id ?? null;
}

const Info = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="min-w-0">
    <dt className="text-[12px] text-gray-500">{label}</dt>
    <dd className="truncate text-[14px] text-gray-900">{children}</dd>
  </div>
);

function History({ studio, onCancel }: { studio: StudioDetail; onCancel: (p: Period) => void }) {
  const fmt = useDateFormatters();
  const muted = (p: Period) => p.status === 'CANCELLED';
  const cancellable = cancellablePeriodId(studio.periods);
  const columns: Column<Period>[] = [
    { key: 'planName', header: 'Plan', locked: true, sortable: false, render: (p) => <span className="font-medium text-gray-900">{p.planName}</span> },
    { key: 'kind', header: 'Kind', sortable: false, render: (p) => PLAN_KIND_LABELS[p.kind] },
    { key: 'startsOn', header: 'Start', sortable: false, render: (p) => fmt.date(p.startsOn) },
    { key: 'endsOn', header: 'End', sortable: false, render: (p) => fmt.date(p.endsOn) },
    { key: 'days', header: 'Days', align: 'right', sortable: false },
    { key: 'amount', header: 'Amount', align: 'right', sortable: false, render: (p) => fmtMoney(p.amount) },
    { key: 'paymentMode', header: 'Mode', sortable: false, render: (p) => (p.paymentMode ? PAYMENT_MODE_LABELS[p.paymentMode] : '-') },
    { key: 'paymentRef', header: 'Ref', sortable: false, render: (p) => p.paymentRef || '-' },
    { key: 'paidOn', header: 'Paid on', sortable: false, render: (p) => (p.paidOn ? fmt.date(p.paidOn) : '-') },
    {
      key: 'status', header: 'Status', sortable: false,
      render: (p) => (muted(p) ? <span className="whitespace-normal"><Badge>Cancelled</Badge>{p.cancelReason && <span className="ml-2 text-[12px] text-gray-500">{p.cancelReason}</span>}</span> : <Badge color="green">Active</Badge>),
    },
    { key: 'notes', header: 'Notes', sortable: false, hidden: true, render: (p) => p.notes || '-' },
  ];
  return (
    <DataTable
      columns={columns}
      rows={studio.periods}
      rowKey={(p) => p.id}
      rowClassName={(p) => muted(p) && 'opacity-60'}
      clientSide
      hidePagination
      hideSearch
      filterFields={false}
      compact
      toolbar={<span className="section-title">Subscription history</span>}
      emptyTitle="No subscription yet"
      emptyDescription="This studio has never had a plan — it is unrestricted until one is added."
      rowActions={(p) => (p.id === cancellable ? <button type="button" className="row-action-danger" title="Cancel period" aria-label={`Cancel ${p.planName} from ${fmt.date(p.startsOn)}`} onClick={() => onCancel(p)}><Ban className="h-3.5 w-3.5" /></button> : null)}
      mobileCard={(p) => (
        <div className={muted(p) ? 'opacity-60' : undefined}>
          <div className="flex items-center justify-between gap-2"><span className="truncate font-medium text-gray-900">{p.planName}</span><span className="text-[13px]">{fmtMoney(p.amount)}</span></div>
          <div className="text-[12px] text-gray-500">{fmt.date(p.startsOn)} to {fmt.date(p.endsOn)} · {p.days} days{p.paymentMode ? ` · ${PAYMENT_MODE_LABELS[p.paymentMode]}` : ''}</div>
          {muted(p) && <div className="text-[12px] text-gray-500">Cancelled{p.cancelReason ? ` — ${p.cancelReason}` : ''}</div>}
        </div>
      )}
    />
  );
}

type DialogName = 'grant' | 'rename' | 'password' | 'status' | 'restore';

export default function StudioDetailPage() {
  const { id = '' } = useParams();
  const q = useStudio(id);
  const fmt = useDateFormatters();
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const [cancelling, setCancelling] = useState<Period | null>(null);
  const close = () => setDialog(null);
  const setStatus = usePlatformSave({ onSuccess: close });

  const back = <Link to="/platform" className="mb-2 inline-flex items-center gap-1 text-[13px] text-gray-500 hover:text-primary"><ArrowLeft className="h-3.5 w-3.5" /> Studios</Link>;
  if (q.isLoading) return <div className="flex justify-center py-20"><Spinner className="h-6 w-6 text-primary" /></div>;
  if (q.isError || !q.data) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return <>{back}<div className="card"><EmptyState title={notFound ? 'Studio not found' : 'Could not load this studio'} description={q.error instanceof Error ? q.error.message : undefined} action={!notFound && <button type="button" className="btn-outline" onClick={() => q.refetch()}>Try again</button>} /></div></>;
  }
  const s = q.data;
  const suspended = !s.isActive;
  return (
    <>
      {back}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-[20px] font-semibold text-gray-900">{s.name}</h2>
            <StatusBadge status={s.access.status} />
          </div>
          <p className="mt-0.5 text-[13px] text-gray-500">
            {s.access.endsOn ? <>Ends on {fmt.date(s.access.endsOn)} · {daysLeftText(s.access.daysLeft)}{s.access.daysLeft !== null && s.access.daysLeft >= 1 ? ' left' : ''}</> : 'No plan — unrestricted until a subscription is added'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-primary" onClick={() => setDialog('grant')}><Plus className="h-4 w-4" /> Add / renew</button>
          <button type="button" className="btn-outline" onClick={() => setDialog('rename')}><Pencil className="h-4 w-4" /> Rename</button>
          {s.owner && <button type="button" className="btn-outline" onClick={() => setDialog('password')}><KeyRound className="h-4 w-4" /> Reset owner password</button>}
          <BackupButton studio={s} />
          <button type="button" className="btn-outline" onClick={() => setDialog('restore')}><RotateCcw className="h-4 w-4" /> Restore</button>
          <button type="button" className={suspended ? 'btn-outline-primary' : 'btn-outline'} onClick={() => setDialog('status')}><Power className="h-4 w-4" /> {suspended ? 'Activate' : 'Suspend'}</button>
        </div>
      </div>

      <dl className="card mb-4 grid grid-cols-1 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Info label="Owner">{s.owner?.name ?? '-'}</Info>
        <Info label="Email (sign-in)">{s.owner?.email ?? '-'}</Info>
        <Info label="Mobile">{s.owner?.mobile || '-'}</Info>
        <Info label="Owner last sign-in">{s.owner?.lastLoginAt ? fmt.stampTime(s.owner.lastLoginAt) : 'Never'}</Info>
        <Info label="Users">{s.userCount}</Info>
        <Info label="Created">{fmt.stamp(s.createdAt)}</Info>
      </dl>

      <History studio={s} onCancel={setCancelling} />

      <GrantDialog studio={s} open={dialog === 'grant'} onClose={close} />
      <RenameDialog studio={s} open={dialog === 'rename'} onClose={close} />
      <OwnerPasswordDialog studio={s} open={dialog === 'password'} onClose={close} />
      <RestoreDialog studio={s} open={dialog === 'restore'} onClose={close} />
      <CancelPeriodDialog studio={s} period={cancelling} onClose={() => setCancelling(null)} />
      <ConfirmDialog
        open={dialog === 'status'}
        onClose={close}
        loading={setStatus.isPending}
        title={suspended ? 'Activate studio?' : 'Suspend studio?'}
        confirmText={suspended ? 'Activate' : 'Suspend'}
        message={suspended
          ? <>Activate <b>{s.name}</b>? Its users can sign in again; its subscription decides what they can do.</>
          : <>Suspend <b>{s.name}</b>? Every user of this studio is signed out at once and nobody can sign in until it is activated.</>}
        onConfirm={() => setStatus.mutate({ method: 'post', url: `/api/platform/studios/${s.id}/status`, body: { isActive: suspended } })}
      />
    </>
  );
}

/** Downloads the studio's data backup (ZIP: a CSV per table + backup.json). The server logs it in the studio's activity log. */
function BackupButton({ studio }: { studio: StudioDetail }) {
  const today = usePlatformToday();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      saveFile(await platformApi.blob(`/api/platform/studios/${studio.id}/backup`), `${studio.slug}-backup-${today}.zip`);
      toast.success('Backup downloaded');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not download the backup');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn-outline" onClick={download} disabled={busy} title="Download this studio's data — Excel (CSV) files and a full JSON">
      {busy ? <Spinner /> : <Download className="h-4 w-4" />} Download backup
    </button>
  );
}
