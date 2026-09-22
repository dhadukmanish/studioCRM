import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Bell, ChevronDown, ChevronRight, Boxes, Leaf, LogOut, Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Search, Settings, Sun, User } from 'lucide-react';
import { THEMES, type ThemePref } from '@/lib/theme';
import { Dropdown } from '@/components/ui';
import { NAV, type NavItem } from '@erp/shared';
import { useAuthStore } from '@/store/auth';
import { useUiStore } from '@/store/ui';
import { cx } from '@/lib/format';
import { api } from '@/lib/api';
import { Icon } from '@/lib/icons';

function useVisibleNav() {
  const can = useAuthStore((s) => s.can);
  return useMemo(
    () =>
      NAV.map((sec) => ({
        ...sec,
        items: sec.items
          .map((it) => (it.children ? { ...it, children: it.children.filter((c) => !c.permission || can(c.permission)) } : it))
          .filter((it) => (it.children ? it.children.length > 0 : !it.permission || can(it.permission))),
      })).filter((s) => s.items.length > 0),
    [can],
  );
}

function SidebarItem({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const { pathname } = useLocation();
  const { openGroups, toggleGroup } = useUiStore();
  const isChildActive = item.children?.some((c) => c.href && pathname.startsWith(c.href));
  const open = openGroups[item.label] ?? isChildActive;
  if (item.children) {
    return (
      <div>
        <button type="button" onClick={() => toggleGroup(item.label)} className={cx('group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium transition', isChildActive ? 'text-primary' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')} title={collapsed ? item.label : undefined}>
          <Icon name={item.icon} className="h-[18px] w-[18px] shrink-0" />
          {!collapsed && <span className="flex-1 text-left truncate">{item.label}</span>}
          {!collapsed && <ChevronDown className={cx('h-4 w-4 transition', open ? '' : '-rotate-90')} />}
        </button>
        {!collapsed && open && (
          <div className="ml-[15px] mt-0.5 border-l border-line pl-3 space-y-0.5">
            {item.children.map((c) => (
              <NavLink key={c.href} to={c.href!} className={({ isActive }) => cx('block rounded-lg px-3 py-1.5 text-[13.5px] transition truncate', isActive ? 'bg-primary-lighter/60 text-primary font-medium' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')}>
                {c.label}
              </NavLink>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <NavLink to={item.href!} end={item.href === '/modules/accounting'} className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium transition', isActive ? 'bg-primary-lighter/60 text-primary' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')} title={collapsed ? item.label : undefined}>
      <Icon name={item.icon} className="h-[18px] w-[18px] shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </NavLink>
  );
}

function Sidebar({ collapsed }: { collapsed: boolean }) {
  const nav = useVisibleNav();
  const tenantName = useAuthStore((s) => s.user?.tenantName);
  return (
    <aside className={cx('flex h-full flex-col border-r border-line bg-white transition-all', collapsed ? 'w-[68px]' : 'w-[260px]')}>
      <Link to="/dashboard" className="flex h-16 items-center gap-2.5 border-b border-line px-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-white"><Boxes className="h-5 w-5" /></span>
        {!collapsed && (
          <div className="min-w-0">
            <div className="font-heading text-[15px] font-semibold text-gray-900 leading-tight">{import.meta.env.VITE_APP_NAME ?? 'ERP'}</div>
            <div className="truncate text-[11px] text-gray-500">{tenantName || 'Workspace'}</div>
          </div>
        )}
      </Link>
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {nav.map((sec) => (
          <div key={sec.title}>
            {!collapsed && <div className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{sec.title}</div>}
            <div className="space-y-0.5">
              {sec.items.map((it) => (
                <SidebarItem key={it.label} item={it} collapsed={collapsed} />
              ))}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}

/** Theme switcher — light / dark / olive / system */
export function ThemeSwitcher() {
  const { theme, setTheme } = useUiStore();
  const icons: Record<string, JSX.Element> = { light: <Sun className="h-4 w-4" />, dark: <Moon className="h-4 w-4" />, olive: <Leaf className="h-4 w-4" />, system: <Monitor className="h-4 w-4" /> };
  const items = [...THEMES.map((t) => ({ label: <span className="flex items-center gap-2">{icons[t.key]}<span className="flex-1">{t.label}</span><span className="h-3 w-3 rounded-full border border-line" style={{ background: t.swatch }} />{theme === t.key && <span className="text-primary">✓</span>}</span>, onClick: () => setTheme(t.key) })), { divider: true, label: '' }, { label: <span className="flex items-center gap-2">{icons.system}<span className="flex-1">System</span>{theme === 'system' && <span className="text-primary">✓</span>}</span>, onClick: () => setTheme('system' as ThemePref) }];
  return <Dropdown items={items} trigger={<button className="icon-btn rounded-full" title="Theme">{icons[theme] ?? icons.system}</button>} />;
}

function UserMenu() {
  const { user, logout, refreshToken } = useAuthStore();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const initials = (user?.name ?? '?').split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-full border border-line bg-white py-1 pl-1 pr-2 hover:bg-gray-50">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-lighter text-[12px] font-semibold text-primary-dark">{initials}</span>
        <span className="hidden text-[13px] font-medium text-gray-700 sm:block max-w-[140px] truncate">{user?.name}</span>
        <ChevronDown className="h-4 w-4 text-gray-500" />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-60 card shadow-lg py-1">
          <div className="px-4 py-3 border-b border-line">
            <div className="text-[14px] font-medium text-gray-900 truncate">{user?.name}</div>
            <div className="text-[12px] text-gray-500 truncate">{user?.email}</div>
            <div className="mt-1 badge bg-primary-lighter text-primary-dark">{user?.roleName}</div>
          </div>
          <button onClick={() => { setOpen(false); nav('/profile'); }} className="flex w-full items-center gap-2 px-4 py-2 text-[13px] text-gray-700 hover:bg-gray-50"><User className="h-4 w-4" /> My Profile</button>
          <button onClick={() => { setOpen(false); nav('/modules/settings'); }} className="flex w-full items-center gap-2 px-4 py-2 text-[13px] text-gray-700 hover:bg-gray-50"><Settings className="h-4 w-4" /> Settings</button>
          <div className="my-1 border-t border-line" />
          <button onClick={async () => { try { await api.post('/api/auth/logout', { refreshToken }); } catch {} logout(); nav('/signin'); }} className="flex w-full items-center gap-2 px-4 py-2 text-[13px] text-red-600 hover:bg-gray-50"><LogOut className="h-4 w-4" /> Sign out</button>
        </div>
      )}
    </div>
  );
}

export default function AppShell() {
  const { sidebarCollapsed, toggleSidebar, mobileOpen, setMobileOpen } = useUiStore();
  const { pathname } = useLocation();
  useEffect(() => setMobileOpen(false), [pathname, setMobileOpen]);
  return (
    <div className="flex h-screen overflow-hidden">
      <div className="hidden lg:block shrink-0 h-full"><Sidebar collapsed={sidebarCollapsed} /></div>
      {mobileOpen && (
        <div className="fixed inset-0 z-[70] lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute left-0 top-0 h-full"><Sidebar collapsed={false} /></div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-white px-4 sm:px-6">
          <button className="icon-btn lg:hidden" onClick={() => setMobileOpen(true)}><Menu className="h-4 w-4" /></button>
          <button className="icon-btn hidden lg:inline-flex" onClick={toggleSidebar}>{sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}</button>
          <div className="relative hidden md:block w-[320px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input placeholder="Search anything..." className="input input-sm pl-9 bg-gray-50" />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ThemeSwitcher />
            <Link to="/modules/settings" className="icon-btn rounded-full" title="Settings"><Settings className="h-4 w-4" /></Link>
            <button className="icon-btn rounded-full" title="Notifications"><Bell className="h-4 w-4" /></button>
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export const Crumb = ({ items }: { items: { label: string; href?: string }[] }) => (
  <div className="mb-1 flex items-center gap-1 text-[12px] text-gray-500">
    {items.map((b, i) => (
      <span key={i} className="flex items-center gap-1">
        {i > 0 && <ChevronRight className="h-3 w-3" />}
        {b.href ? <Link to={b.href} className="hover:text-primary">{b.label}</Link> : <span className="text-gray-700">{b.label}</span>}
      </span>
    ))}
  </div>
);
