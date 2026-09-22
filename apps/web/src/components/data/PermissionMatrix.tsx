import { useMemo, useState } from 'react';
import { PERMISSIONS, PERMISSION_ACTIONS, PERMISSION_ACTION_LABELS, PERMISSION_MODULE_LABELS, type PermissionAction, type PermissionGrants } from '@erp/shared';
import { Checkbox, Tabs, TextInput } from '@/components/ui';

/**
 * Permission grid for a role: module tabs × sub-module rows × View/Create/Edit/Delete.
 * Labels are presentation only — the stored identifiers stay read/create/update/delete.
 */
export function PermissionMatrix({ value, onChange }: { value: PermissionGrants; onChange: (g: PermissionGrants) => void }) {
  const modules = useMemo(() => Array.from(new Set(PERMISSIONS.map((p) => p.module))), []);
  const [tab, setTab] = useState<string>(modules[0]);
  const [q, setQ] = useState('');
  const list = PERMISSIONS.filter((p) => p.module === tab && (!q || p.displayName.toLowerCase().includes(q.toLowerCase())));
  const allowed = (n: string, a: PermissionAction) => (PERMISSIONS.find((p) => p.name === n)?.actions ?? PERMISSION_ACTIONS).includes(a);
  const has = (n: string, a: PermissionAction) => (value[n] ?? []).includes(a);
  /** Create / Edit / Delete imply View; removing View clears the row. */
  const set = (n: string, a: PermissionAction, v: boolean) => {
    const cur = new Set(value[n] ?? []);
    if (v) { cur.add(a); if (a !== 'read') cur.add('read'); } else { cur.delete(a); if (a === 'read') cur.clear(); }
    onChange({ ...value, [n]: Array.from(cur) });
  };
  const setAll = (a: PermissionAction, v: boolean) => {
    const g = { ...value };
    list.forEach((p) => { if (!allowed(p.name, a)) return; const cur = new Set(g[p.name] ?? []); if (v) { cur.add(a); cur.add('read'); } else { cur.delete(a); if (a === 'read') cur.clear(); } g[p.name] = Array.from(cur); });
    onChange(g);
  };
  const setRow = (n: string, v: boolean) => onChange({ ...value, [n]: v ? PERMISSION_ACTIONS.filter((a) => allowed(n, a)) : [] });
  const countFor = (m: string) => PERMISSIONS.filter((p) => p.module === m && value[p.name]?.length).length;
  const rowAll = (n: string) => PERMISSION_ACTIONS.every((a) => !allowed(n, a) || has(n, a));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tab} onChange={setTab} tabs={modules.map((m) => ({ value: m, label: PERMISSION_MODULE_LABELS[m] ?? m, count: countFor(m) }))} className="flex-1" />
        <TextInput size="sm" placeholder="Search permission..." value={q} onChange={(e) => setQ(e.target.value)} className="w-[200px]" />
      </div>
      <div className="mt-3 max-h-[380px] overflow-x-auto overflow-y-auto rounded-lg border border-line">
        <table className="min-w-full">
          <thead className="sticky top-0 z-10 bg-head">
            <tr>
              <th className="table-head !py-2">Permission</th>
              <th className="table-head !py-2 !px-3 text-center">All</th>
              {PERMISSION_ACTIONS.map((a) => (
                <th key={a} className="table-head !py-2 !px-3 text-center">
                  <span className="inline-flex items-center gap-1.5 normal-case tracking-normal">
                    <Checkbox checked={list.length > 0 && list.every((p) => !allowed(p.name, a) || has(p.name, a))} onChange={(v) => setAll(a, v)} />
                    {PERMISSION_ACTION_LABELS[a]}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.length === 0 && (
              <tr><td colSpan={PERMISSION_ACTIONS.length + 2} className="table-cell !py-6 text-center text-gray-500">No permission matches "{q}"</td></tr>
            )}
            {list.map((p) => (
              <tr key={p.name} className="transition hover:bg-gray-50/60">
                <td className="table-cell !py-1.5 text-gray-800">{p.displayName}</td>
                <td className="table-cell !py-1.5 !px-3 text-center">
                  <Checkbox ariaLabel={`All actions for ${p.displayName}`} checked={rowAll(p.name)} onChange={(v) => setRow(p.name, v)} />
                </td>
                {PERMISSION_ACTIONS.map((a) => (
                  <td key={a} className="table-cell !py-1.5 !px-3 text-center">
                    {allowed(p.name, a)
                      ? <Checkbox ariaLabel={`${PERMISSION_ACTION_LABELS[a]} ${p.displayName}`} checked={has(p.name, a)} onChange={(v) => set(p.name, a, v)} />
                      : <span className="text-gray-300">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[12px] text-gray-500">Create, Edit and Delete include View automatically.</p>
    </div>
  );
}
