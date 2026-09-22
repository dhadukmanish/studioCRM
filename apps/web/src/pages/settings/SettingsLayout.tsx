import { useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { ChevronRight, Search } from 'lucide-react';
import { SETTINGS_GROUPS } from '@erp/shared';
import { useAuthStore } from '@/store/auth';
import { cx } from '@/lib/format';
import { Icon } from '@/lib/icons';

export function useSettingsGroups() {
  const can = useAuthStore((s) => s.can);
  return useMemo(() => SETTINGS_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !i.permission || can(i.permission)) })).filter((g) => g.items.length), [can]);
}

/** Hub: search + card grid, exactly as /modules/settings */
export function SettingsHub() {
  const groups = useSettingsGroups();
  const [q, setQ] = useState('');
  const filtered = q ? groups.map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())) })).filter((g) => g.items.length) : groups;
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[20px] font-semibold text-gray-900">Settings</h2>
        <div className="relative w-full sm:w-[320px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings..." className="input pl-9" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((g) => (
          <div key={g.title} className="card p-5">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-lighter text-primary"><Icon name={g.icon} className="h-4 w-4" /></span>
              <h3 className="text-[15px] font-semibold text-gray-900">{g.title}</h3>
            </div>
            <ul className="space-y-1">
              {g.items.map((i) => (
                <li key={i.href}>
                  <Link to={i.href} className="flex items-center justify-between rounded-md px-2 py-1.5 text-[14px] text-gray-600 hover:bg-gray-50 hover:text-primary">
                    {i.label} <ChevronRight className="h-4 w-4 text-gray-300" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Layout for a settings page: left sub-nav + content */
export default function SettingsLayout() {
  const groups = useSettingsGroups();
  const { pathname } = useLocation();
  const current = groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.title }))).find((i) => pathname.startsWith(i.href));
  return (
    <div className="flex gap-6">
      <aside className="hidden w-[240px] shrink-0 lg:block">
        <div className="card p-2 sticky top-0 max-h-[calc(100vh-7rem)] overflow-y-auto">
          {groups.map((g) => (
            <div key={g.title} className="mb-2">
              <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{g.title}</div>
              {g.items.map((i) => (
                <NavLink key={i.href} to={i.href} className={({ isActive }) => cx('block rounded-md px-3 py-1.5 text-[13.5px]', isActive ? 'bg-primary-lighter/60 font-medium text-primary' : 'text-gray-600 hover:bg-gray-50')}>
                  {i.label}
                </NavLink>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex items-center gap-1 text-[12px] text-gray-500">
          <Link to="/modules/settings" className="hover:text-primary">Settings</Link>
          {current && (<><ChevronRight className="h-3 w-3" /><span>{current.group}</span><ChevronRight className="h-3 w-3" /><span className="text-gray-700">{current.label}</span></>)}
        </div>
        <Outlet />
      </div>
    </div>
  );
}
