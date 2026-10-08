import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Bell, ChevronDown, ChevronRight, Boxes, Leaf, LogOut, Palette, Menu, Monitor, Moon, Search, CloudFog, Settings, Sprout, Sun, Sunset, User, Waves } from 'lucide-react';
import { THEMES, type ThemePref } from '@/lib/theme';
import { Dropdown } from '@/components/ui';
import { NAV, navSectionFor, type NavSection } from '@erp/shared';
import { useAuthStore, type AuthUser } from '@/store/auth';
import { useUiStore } from '@/store/ui';
import { cx } from '@/lib/format';
import { api } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { useEnterToNext } from '@/lib/enterToNext';
import { useCompanyLogo, useCompanyProfile } from '@/lib/settings';
import { SubscriptionBanner } from './SubscriptionBanner';

/** NAV with the items this user may read; a group left with none is hidden. */
function useVisibleNav(): NavSection[] {
  const can = useAuthStore((s) => s.can);
  return useMemo(
    () => NAV.map((sec) => ({ ...sec, items: sec.items.filter((it) => !it.permission || can(it.permission)) })).filter((s) => s.items.length > 0),
    [can],
  );
}

const PRODUCT_NAME = import.meta.env.VITE_APP_NAME ?? 'StudioCRM';
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

/**
 * The brand square: the company's logo when it has one, else its initials, else (while the
 * profile loads) the product mark. Fixed 36px box with object-contain, so a logo of any shape
 * or size is scaled down undistorted and can never grow the header; a logo that fails to load
 * falls back to the initials rather than a broken-image icon.
 */
function BrandMark({ name, companyId, logoVersion }: { name?: string; companyId?: string; logoVersion?: string }) {
  const logo = useCompanyLogo(companyId, logoVersion);
  const [broken, setBroken] = useState<string | null>(null);
  if (logo.data && broken !== logo.data) {
    return <img src={logo.data} alt="" onError={() => setBroken(logo.data!)} className="h-9 w-9 shrink-0 rounded-lg border border-line bg-white object-contain p-0.5" />;
  }
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-on-topbar text-[13px] font-semibold text-topbar">
      {name ? initialsOf(name) : <Boxes className="h-5 w-5" strokeWidth={1.5} />}
    </span>
  );
}

/**
 * The icon sidebar: one entry per group (Dashboard, Work, Billing, Reports, Masters). It opens the
 * group's first page; the group's other pages are the tabs above the page (SectionTabs).
 */
function Rail({ nav, current, collapsed }: { nav: NavSection[]; current?: NavSection; collapsed: boolean }) {
  return (
    <nav aria-label="Main" className={cx('flex h-full flex-col gap-1 overflow-y-auto border-r border-line bg-sidebar py-3 transition-all', collapsed ? 'w-[64px] px-1.5' : 'w-[88px] px-2')}>
      {nav.map((sec) => {
        const active = current?.title === sec.title;
        return (
          <Link
            key={sec.title}
            to={sec.items[0].href}
            aria-current={active ? 'true' : undefined}
            title={sec.title}
            className={cx(
              'relative flex flex-col items-center gap-1 rounded-[var(--r-card)] px-1 py-2.5 text-[12px] font-medium leading-tight transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              active ? 'bg-primary-50 text-primary before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-primary' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
            )}
          >
            <Icon name={sec.icon} className="h-5 w-5 shrink-0" />
            {collapsed ? <span className="sr-only">{sec.title}</span> : <span className="max-w-full truncate">{sec.title}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

/** The open group's pages as tabs — only when it has more than one page this user may see. */
function SectionTabs({ section }: { section?: NavSection }) {
  if (!section || section.items.length < 2) return null;
  return (
    <nav aria-label={`${section.title} pages`} className="-mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:-mx-6 sm:px-6">
      {section.items.map((it) => (
        <NavLink
          key={it.href}
          to={it.href}
          className={({ isActive }) =>
            cx(
              '-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px] font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
              isActive ? 'border-primary text-primary' : 'border-transparent text-gray-600 hover:border-line hover:text-gray-900',
            )
          }
        >
          <Icon name={it.icon} className="h-4 w-4" />
          {it.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** A round button on the top bar. */
const barBtn = 'inline-flex h-9 w-9 items-center justify-center rounded-full text-on-topbar transition hover:bg-topbar-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-on-topbar/60';

/** Theme switcher — every theme in THEMES (lib/theme.ts), plus System */
export function ThemeSwitcher() {
  const { theme, setTheme } = useUiStore();
  const icons: Record<string, JSX.Element> = { light: <Sun className="h-4 w-4" />, dark: <Moon className="h-4 w-4" />, olive: <Leaf className="h-4 w-4" />, sky: <Palette className="h-4 w-4" />, slate: <Palette className="h-4 w-4" />, teal: <Palette className="h-4 w-4" />, lavender: <Palette className="h-4 w-4" />, mist: <CloudFog className="h-4 w-4" />, olivepro: <Sprout className="h-4 w-4" />, tealmint: <Waves className="h-4 w-4" />, dusk: <Sunset className="h-4 w-4" />, system: <Monitor className="h-4 w-4" /> };
  const items = [...THEMES.map((t) => ({ label: <span className="flex items-center gap-2">{icons[t.key]}<span className="flex-1">{t.label}</span><span className="h-3 w-3 rounded-full border border-line" style={{ background: t.swatch }} />{theme === t.key && <span className="text-primary">✓</span>}</span>, onClick: () => setTheme(t.key) })), { divider: true, label: '' }, { label: <span className="flex items-center gap-2">{icons.system}<span className="flex-1">System</span>{theme === 'system' && <span className="text-primary">✓</span>}</span>, onClick: () => setTheme('system' as ThemePref) }];
  return <Dropdown items={items} trigger={<button className={barBtn} title="Theme">{icons[theme] ?? icons.system}</button>} />;
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
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 text-on-topbar transition hover:bg-topbar-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-on-topbar/60">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-on-topbar text-[12px] font-semibold text-topbar">{initials}</span>
        <span className="hidden text-[13px] font-medium sm:block max-w-[140px] truncate">{user?.name}</span>
        <ChevronDown className="h-4 w-4" />
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
  useEnterToNext();
  const { sidebarCollapsed, toggleSidebar, mobileOpen, setMobileOpen } = useUiStore();
  const { pathname } = useLocation();
  const nav = useVisibleNav();
  const current = navSectionFor(nav, pathname);
  // Company name and logo come from the tenant's company profile (Settings -> Companies), the
  // product name from the build. They are different things and both are shown.
  const company = useCompanyProfile().data;
  useEffect(() => setMobileOpen(false), [pathname, setMobileOpen]);
  // The stored user is a sign-in snapshot; refresh it once per app load so the subscription banner
  // (and anything else on the user) reflects today, merged over what sign-in stored.
  const subscription = useAuthStore((s) => s.user?.subscription);
  useEffect(() => {
    api.get<Partial<AuthUser>>('/api/auth/me').then((me) => {
      const current = useAuthStore.getState().user;
      if (me && current) useAuthStore.getState().setUser({ ...current, ...me });
    }).catch(() => {}); // a failed refresh keeps the snapshot; a suspension (SUB_003) signs out in lib/api
  }, []);
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-topbar px-2 text-on-topbar sm:gap-3 sm:px-4">
        <button className={cx(barBtn, 'lg:hidden')} onClick={() => setMobileOpen(true)} title="Menu"><Menu className="h-5 w-5" /></button>
        <button className={cx(barBtn, 'hidden lg:inline-flex')} onClick={toggleSidebar} title={sidebarCollapsed ? 'Show menu labels' : 'Hide menu labels'}><Menu className="h-5 w-5" /></button>
        <Link to="/dashboard" className="flex min-w-0 items-center gap-2.5 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-on-topbar/60">
          <BrandMark name={company?.name} companyId={company?.id} logoVersion={company?.logo?.version} />
          <span className="min-w-0">
            <span className="block truncate font-heading text-[15px] font-semibold leading-tight">{company?.name ?? PRODUCT_NAME}</span>
            <span className="block truncate text-[11px] leading-tight opacity-80">{PRODUCT_NAME}</span>
          </span>
        </Link>
        <div className="relative ml-auto hidden w-[300px] md:block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-80" />
          <input placeholder="Search anything..." className="h-9 w-full rounded-[var(--r-control)] border border-on-topbar/25 bg-topbar-raised pl-9 pr-3 text-[13px] text-on-topbar outline-none transition placeholder:text-on-topbar/75 focus:ring-2 focus:ring-on-topbar/50" />
        </div>
        <div className="ml-auto flex items-center gap-1 md:ml-0">
          <ThemeSwitcher />
          <Link to="/modules/settings" className={barBtn} title="Settings"><Settings className="h-4 w-4" /></Link>
          <button className={barBtn} title="Notifications"><Bell className="h-4 w-4" /></button>
          <UserMenu />
        </div>
      </header>
      <SubscriptionBanner access={subscription} />
      <div className="flex min-h-0 flex-1">
        <div className="hidden lg:block shrink-0 h-full"><Rail nav={nav} current={current} collapsed={sidebarCollapsed} /></div>
        {mobileOpen && (
          <div className="fixed inset-0 z-[70] lg:hidden">
            <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
            <div className="absolute left-0 top-0 h-full"><Rail nav={nav} current={current} collapsed={false} /></div>
          </div>
        )}
        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <SectionTabs section={current} />
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
