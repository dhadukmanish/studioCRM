import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { Badge } from '@/components/ui';
import { useList } from '@/lib/queries';
import { useDateFormatters } from '@/lib/settings';

const color: Record<string, any> = { created: 'green', updated: 'blue', deleted: 'red', login: 'purple' };

export default function ActivityLogsPage() {
  const [state, setState] = useListState({ limit: 50 });
  const q = useList<any>('activity-logs', '/api/activity-logs', state);
  const fmt = useDateFormatters();

  const columns: Column<any>[] = [
    { key: 'createdAt', header: 'When', locked: true, render: (r) => fmt.stampTime(r.createdAt) },
    { key: 'userName', header: 'User', sortable: false },
    { key: 'action', header: 'Action', sortable: false, render: (r) => <Badge color={color[r.action] ?? 'gray'}>{r.action}</Badge> },
    { key: 'entityType', header: 'Entity', sortable: false, render: (r) => <span className="capitalize">{r.entityType}</span> },
    { key: 'description', header: 'Description', sortable: false },
    { key: 'ipAddress', header: 'IP', sortable: false, hidden: true, render: (r) => r.ipAddress || '-' },
  ];
  return (
    <>
      <h2 className="mb-4 text-[20px] font-semibold text-gray-900">Activity Logs</h2>
      <DataTable storageKey="activity-logs" filterFields={false} columns={columns} rows={q.data?.rows ?? []} total={q.data?.total} loading={q.isFetching} state={state} onStateChange={setState} rowKey={(r) => r.id} onRefresh={() => q.refetch()} searchPlaceholder="Search description..." />
    </>
  );
}
