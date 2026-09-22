import { useMemo, useState } from 'react';
import { PERMISSIONS, PERMISSION_ACTIONS, PERMISSION_MODULE_LABELS, type PermissionAction, type PermissionGrants } from '@erp/shared';
import { Checkbox, Tabs, TextInput } from '@/components/ui';

/**
 * Reusable permission grid: module tabs × (sub-module rows) × (read/create/update/delete).
 * Used by the Roles page and by per-user overrides.
 */
export function PermissionMatrix({ value, onChange, readOnly, baseline }: { value: PermissionGrants; onChange: (g: PermissionGrants) => void; readOnly?: boolean; /** grants inherited from the role — shown as locked ticks */ baseline?: PermissionGrants }) {
  const modules = useMemo(() => Array.from(new Set(PERMISSIONS.map((p) => p.module))), []);
  const [tab, setTab] = useState<string>(modules[0]);
  const [q, setQ] = useState('');
  const list = PERMISSIONS.filter((p) => p.module === tab && (!q || p.displayName.toLowerCase().includes(q.toLowerCase())));
  const allowed = (n: string, a: PermissionAction) => (PERMISSIONS.find((p) => p.name === n)?.actions ?? PERMISSION_ACTIONS).includes(a);
  const inherited = (n: string, a: PermissionAction) => !!baseline?.[n]?.includes(a);
  const has = (n: string, a: PermissionAction) => inherited(n, a) || (value[n] ?? []).includes(a);
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
  const countFor = (m: string) => PERMISSIONS.filter((p) => p.module === m && (value[p.name]?.length || baseline?.[p.name]?.length)).length;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tab} onChange={setTab} tabs={modules.map((m) => ({ value: m, label: PERMISSION_MODULE_LABELS[m] ?? m, count: countFor(m) }))} className="flex-1" />
        <TextInput size="sm" placeholder="Search permission..." value={q} onChange={(e) => setQ(e.target.value)} className="w-[200px]" />
      </div>
      <div className="mt-3 max-h-[440px] overflow-x-auto overflow-y-auto rounded-lg border border-line">
        <table className="min-w-full">
          <thead className="sticky top-0 bg-[#F8FAFC]">
            <tr>
              <th className="table-head">Permission</th>
              <th className="table-head text-center">All</th>
              {PERMISSION_ACTIONS.map((a) => (
                <th key={a} className="table-head text-center">
                  <span className="inline-flex items-center gap-1.5 capitalize"><Checkbox disabled={readOnly} checked={list.length > 0 && list.every((p) => !allowed(p.name, a) || has(p.name, a))} onChange={(v) => setAll(a, v)} />{a}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map((p) => (
              <tr key={p.name} className="hover:bg-gray-50/60">
                <td className="table-cell !py-2"><div>{p.displayName}</div><div className="font-mono text-[11px] text-gray-400">{p.name}</div></td>
                <td className="table-cell !py-2 text-center"><Checkbox disabled={readOnly} checked={PERMISSION_ACTIONS.every((a) => !allowed(p.name, a) || has(p.name, a))} onChange={(v) => setRow(p.name, v)} /></td>
                {PERMISSION_ACTIONS.map((a) => (
                  <td key={a} className="table-cell !py-2 text-center">{allowed(p.name, a) ? <Checkbox disabled={readOnly || inherited(p.name, a)} checked={has(p.name, a)} onChange={(v) => set(p.name, a, v)} /> : <span className="text-gray-300">—</span>}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {baseline && <p className="mt-2 text-[12px] text-gray-500">Greyed ticks come from the user's role and cannot be removed here — change the role instead. Extra ticks are per-user overrides.</p>}
    </div>
  );
}
