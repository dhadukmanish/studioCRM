import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { fmtMoney } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { usePlatformSummary, useStudios, type PlatformSummary, type Studio } from './queries';
import { daysLeftText, StatusBadge } from './StatusBadge';
import { NewStudioDialog } from './NewStudioDialog';

const STATS: { key: keyof PlatformSummary; label: string; money?: boolean }[] = [
  { key: 'total', label: 'Total' },
  { key: 'trial', label: 'Trial' },
  { key: 'active', label: 'Active' },
  { key: 'grace', label: 'Grace' },
  { key: 'expired', label: 'Expired' },
  { key: 'suspended', label: 'Suspended' },
  { key: 'expiringSoon', label: 'Expiring ≤ 7 days' },
  { key: 'revenueThisMonth', label: 'Revenue this month', money: true },
];

/** The counts the server computed — one flat strip, no per-figure cards. */
function SummaryStrip() {
  const q = usePlatformSummary();
  return (
    <div className="card mb-4 grid grid-cols-2 gap-px overflow-hidden bg-line sm:grid-cols-4 xl:grid-cols-8" aria-label="Summary">
      {STATS.map((s) => (
        <div key={s.key} className="min-w-0 bg-white px-4 py-3">
          <div className="truncate text-[12px] text-gray-500">{s.label}</div>
          <div className="mt-0.5 truncate text-[18px] font-semibold text-gray-900" data-stat={s.key}>
            {q.data ? (s.money ? fmtMoney(q.data[s.key]) : q.data[s.key]) : q.isError ? '-' : '…'}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function StudiosPage() {
  const [state, setState] = useListState({ sortOrder: 'asc' });
  const q = useStudios(state.search);
  const fmt = useDateFormatters();
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);

  const columns: Column<Studio>[] = [
    { key: 'name', header: 'Studio', locked: true, render: (r) => <><div className="font-medium text-gray-900">{r.name}</div><div className="text-[12px] text-gray-500">{r.slug}</div></> },
    {
      key: 'owner', header: 'Owner', sortValue: (r) => r.owner?.name ?? '',
      render: (r) => (r.owner ? <><div className="text-gray-900">{r.owner.name}</div><div className="text-[12px] text-gray-500">{[r.owner.mobile, r.owner.email].filter(Boolean).join(' · ')}</div></> : <span className="text-gray-400">No owner</span>),
    },
    { key: 'status', header: 'Status', sortValue: (r) => r.access.status, render: (r) => <StatusBadge status={r.access.status} /> },
    { key: 'endsOn', header: 'Ends on', sortValue: (r) => r.access.endsOn ?? '', render: (r) => (r.access.endsOn ? fmt.date(r.access.endsOn) : '-') },
    { key: 'daysLeft', header: 'Days left', align: 'right', sortValue: (r) => r.access.daysLeft ?? Number.MAX_SAFE_INTEGER, render: (r) => daysLeftText(r.access.daysLeft) },
    { key: 'userCount', header: 'Users', align: 'right' },
    { key: 'createdAt', header: 'Created', render: (r) => fmt.stamp(r.createdAt) },
  ];

  return (
    <>
      <div className="mb-3">
        <h2 className="text-[20px] font-semibold text-gray-900">Studios</h2>
        <p className="text-[13px] text-gray-500">Every studio account, its owner and how long its subscription runs.</p>
      </div>
      <SummaryStrip />
      {q.isError && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">Could not load the studios. {q.error instanceof Error ? q.error.message : ''}</p>}
      <DataTable
        columns={columns}
        rows={q.data ?? []}
        loading={q.isFetching}
        state={state}
        onStateChange={setState}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/platform/studios/${r.id}`)}
        clientSide
        hidePagination
        filterFields={false}
        searchPlaceholder="Search studio, owner, mobile, email"
        emptyTitle={state.search ? 'No studio matches' : 'No studios yet'}
        emptyDescription={state.search ? undefined : 'Create the first studio with New studio.'}
        onRefresh={() => q.refetch()}
        actions={<button type="button" className="btn-primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New studio</button>}
        mobileCard={(r) => (
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium text-gray-900">{r.name}</span>
              <StatusBadge status={r.access.status} />
            </div>
            <div className="mt-0.5 truncate text-[12px] text-gray-500">{r.owner ? `${r.owner.name} · ${r.owner.mobile ?? r.owner.email}` : 'No owner'}</div>
            <div className="mt-0.5 text-[12px] text-gray-500">{r.access.endsOn ? `Ends ${fmt.date(r.access.endsOn)} · ${daysLeftText(r.access.daysLeft)}` : 'No plan'}</div>
          </div>
        )}
      />
      <NewStudioDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
