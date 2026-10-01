import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CalendarClock, CalendarDays, CheckCircle2, ClipboardList, IndianRupee, Truck } from 'lucide-react';
import { DASHBOARD_PERIODS, DASHBOARD_PERIOD_LABELS, WORK_POSITIONS, WORK_POSITION_LABELS, isIsoDate, type DashboardPeriod, type DashboardSummary } from '@erp/shared';
import { DateRangeInput, Spinner } from '@/components/ui';
import { useDashboard } from '@/lib/dashboard';
import { cx, fmtMoney } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { useAuthStore } from '@/store/auth';

/**
 * The Dashboard (docs/DASHBOARD.md): inquiries, orders and their workflow status, money, and what
 * needs attention today. Every figure comes from the server, already scoped to what this user may
 * see — a section the server did not return is simply not drawn. Administration (users, roles,
 * permissions) lives in Settings, not here.
 *
 * The period lives in the URL (`?period=…&from=…&to=…`), so a view can be bookmarked or shared.
 */
/**
 * Colour for marks only (icon badges, stage edges and bars) — the theme's validated series palette
 * (themes.css), in fixed order. Every figure keeps its text label, so colour is never the only cue.
 */
const SERIES = [
  { chip: 'bg-series-1/20 text-series-1', edge: 'border-l-series-1', bar: 'bg-series-1' },
  { chip: 'bg-series-2/20 text-series-2', edge: 'border-l-series-2', bar: 'bg-series-2' },
  { chip: 'bg-series-3/20 text-series-3', edge: 'border-l-series-3', bar: 'bg-series-3' },
  { chip: 'bg-series-4/20 text-series-4', edge: 'border-l-series-4', bar: 'bg-series-4' },
  { chip: 'bg-series-5/20 text-series-5', edge: 'border-l-series-5', bar: 'bg-series-5' },
] as const;

export default function DashboardPage() {
  const { user, can } = useAuthStore();
  const fmt = useDateFormatters();
  const [params, setParams] = useSearchParams();
  const raw = params.get('period') as DashboardPeriod | null;
  const period: DashboardPeriod = raw && (DASHBOARD_PERIODS as readonly string[]).includes(raw) ? raw : 'THIS_MONTH';
  const date = (k: string) => (isIsoDate(params.get(k)) ? (params.get(k) as string) : undefined);
  const from = date('from');
  const to = date('to');
  const q = useDashboard(period, from, to);
  // An incomplete custom range shows a hint, never the previous period's figures under a new label.
  const customProblem = period !== 'CUSTOM' ? null : !from || !to ? 'Choose both dates of the custom period.' : from > to ? 'The end date cannot be before the start date.' : null;
  const d = customProblem ? undefined : q.data;
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };
  const choose = (p: DashboardPeriod) =>
    // Custom starts from the range on screen, so switching to it never shows an empty dashboard.
    set(p === 'CUSTOM' ? { period: p, from: from ?? d?.from, to: to ?? d?.to } : { period: p === 'THIS_MONTH' ? undefined : p, from: undefined, to: undefined });
  const range = d ? (d.from === d.to ? fmt.date(d.from) : `${fmt.date(d.from)} – ${fmt.date(d.to)}`) : '';
  const nothing = d && !d.inquiries && !d.orders && !d.money;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold text-gray-900">Dashboard</h2>
          <p className="text-[13px] text-gray-500">
            {user?.firstName ?? user?.name?.split(' ')[0]}, here is your studio{range && <> · <span className="tabular-nums">{range}</span></>}
            {q.isFetching && <Spinner className="ml-2 inline h-3.5 w-3.5 align-[-2px]" />}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Period" className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface p-1">
            {DASHBOARD_PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={period === p}
                onClick={() => choose(p)}
                className={cx('whitespace-nowrap rounded-md px-2.5 py-1 text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40', period === p ? 'bg-primary-lighter font-medium text-primary' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900')}
              >
                {p === 'THIS_FY' ? 'This FY' : DASHBOARD_PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
          {period === 'CUSTOM' && (
            <DateRangeInput
              label="Period"
              from={from}
              to={to}
              onFrom={(v) => (v === '' || isIsoDate(v)) && set({ from: v || undefined })}
              onTo={(v) => (v === '' || isIsoDate(v)) && set({ to: v || undefined })}
            />
          )}
        </div>
      </div>

      {customProblem && <div className="card p-4 text-[13px] text-gray-600">{customProblem}</div>}
      {q.isError && <div className="card p-4 text-[13px] text-red-700">The dashboard could not be loaded. {(q.error as Error)?.message}</div>}
      {nothing && <div className="card p-6 text-center text-[13px] text-gray-500">Your role does not include Appointments, Billing or Receipts, so there are no figures to show here.</div>}

      {d && <Attention d={d} canWork={can('operations_work')} canAppointments={can('operations_appointments')} />}

      <div className="grid gap-4 xl:grid-cols-2">
        {d?.inquiries && (
          <Section title="Inquiries" tone={0} icon={<CalendarDays />} hint="Appointments dated in the period" link={can('operations_appointments') ? { to: '/modules/appointments', label: 'Appointments' } : undefined}>
            <Figures items={[
              { label: 'Total inquiries', value: d.inquiries.total, strong: true },
              { label: 'Pending', value: d.inquiries.pending },
              { label: 'Done', value: d.inquiries.done },
            ]} />
          </Section>
        )}
        {d?.orders && (
          <Section title="Orders" tone={2} icon={<ClipboardList />} hint="Bills dated in the period · completed = delivered" link={can('operations_billing') ? { to: '/modules/billing', label: 'Bills' } : undefined}>
            <Figures items={[
              { label: 'Total orders', value: d.orders.total, strong: true },
              { label: 'Completed', value: d.orders.completed },
              { label: 'Pending', value: d.orders.pending },
            ]} />
          </Section>
        )}
      </div>

      {d?.orders && (
        <Section title="Order process status" tone={1} icon={<Truck />} hint="Where the period's orders are now" link={can('operations_work') ? { to: '/modules/reports/delivery', label: 'Delivery report' } : undefined}>
          <Pipeline counts={d.orders.byPosition} total={d.orders.total} />
        </Section>
      )}

      {d?.money && (
        <Section title="Payments" tone={3} icon={<IndianRupee />} hint="As of today — the same figures as Reports → Receivables" link={can('reports_receivables') ? { to: '/modules/reports/receivables', label: 'Receivables' } : undefined}>
          <Figures
            items={[
              { label: 'Billed in period', value: fmtMoney(d.money.billed) },
              { label: 'Received on these bills', value: fmtMoney(d.money.received) },
              { label: 'Outstanding on these bills', value: fmtMoney(d.money.outstanding) },
              { label: 'Total outstanding', value: fmtMoney(d.money.totalOutstanding), strong: true, sub: `${d.money.billsWithOutstanding} bill${d.money.billsWithOutstanding === 1 ? '' : 's'} · ${d.money.customersWithOutstanding} customer${d.money.customersWithOutstanding === 1 ? '' : 's'} · all periods` },
            ]}
          />
        </Section>
      )}
    </div>
  );
}

function Section({ title, tone, icon, hint, link, children }: { title: string; tone: number; icon: ReactNode; hint: string; link?: { to: string; label: string }; children: ReactNode }) {
  return (
    <section className="card min-w-0 p-4" aria-label={title}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-md [&>svg]:h-4 [&>svg]:w-4', SERIES[tone].chip)} aria-hidden>{icon}</span>
          <h3 className="text-[14px] font-semibold text-gray-900">{title}</h3>
          <span className="hidden truncate text-[12px] text-gray-500 sm:inline">· {hint}</span>
        </div>
        {link && (
          <Link to={link.to} className="flex shrink-0 items-center gap-1 text-[12.5px] text-primary hover:underline">
            {link.label} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

function Figures({ items }: { items: { label: string; value: number | string; strong?: boolean; sub?: string }[] }) {
  return (
    <div className={cx('grid gap-px overflow-hidden rounded-md bg-line', items.length === 4 ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4' : 'grid-cols-3')}>
      {items.map((f) => (
        <div key={f.label} className="min-w-0 bg-surface px-3 py-2.5">
          <div className="truncate text-[12px] text-gray-500">{f.label}</div>
          <div className={cx('tabular-nums text-gray-900', f.strong ? 'text-[20px] font-semibold' : 'text-[18px]')}>{f.value}</div>
          {f.sub && <div className="truncate text-[11.5px] text-gray-500">{f.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/** Selection → Editing → WhatsApp → Delivery → Done: the count at each step, with its share as a thin bar. */
function Pipeline({ counts, total }: { counts: Record<(typeof WORK_POSITIONS)[number], number>; total: number }) {
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {WORK_POSITIONS.map((p, i) => {
        const n = counts[p];
        const share = total ? n / total : 0;
        return (
          <li key={p} className={cx('min-w-0 rounded-md border border-l-[3px] border-line px-3 py-2.5', SERIES[i].edge)}>
            <div className="flex items-center justify-between gap-2 text-[12px] text-gray-500">
              <span className="truncate">{i + 1 < WORK_POSITIONS.length ? `${i + 1}. ${p === 'DELIVERY' ? 'Delivery due' : WORK_POSITION_LABELS[p]}` : 'Completed'}</span>
              {p === 'COMPLETE' && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-series-5" aria-hidden />}
            </div>
            <div className="tabular-nums text-[18px] text-gray-900">{n}</div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-gray-100" aria-hidden>
              <div className={cx('h-full rounded-full', SERIES[i].bar)} style={{ width: `${Math.round(share * 100)}%` }} />
            </div>
            <div className="mt-1 text-[11px] text-gray-500">{total ? `${Math.round(share * 100)}% of orders` : '—'}</div>
          </li>
        );
      })}
    </ol>
  );
}

/** Today's to-dos and what is late — independent of the chosen period. Hidden when there is nothing. */
function Attention({ d, canWork, canAppointments }: { d: DashboardSummary; canWork: boolean; canAppointments: boolean }) {
  const items = [
    d.inquiries && { tone: 0, label: 'Appointments today', n: d.inquiries.pendingToday, icon: CalendarClock, to: canWork ? '/modules/work' : canAppointments ? '/modules/appointments' : undefined, late: false },
    d.orders && { tone: 2, label: 'Deliveries due today', n: d.orders.dueToday, icon: Truck, to: canWork ? '/modules/work' : undefined, late: false },
    d.orders && { tone: -1, label: 'Overdue deliveries', n: d.orders.overdue, icon: AlertTriangle, to: canWork ? '/modules/reports/delivery' : undefined, late: true },
    d.inquiries && { tone: -1, label: 'Overdue appointments', n: d.inquiries.overdue, icon: AlertTriangle, to: canAppointments ? '/modules/appointments' : undefined, late: true },
  ].filter((x): x is { tone: number; label: string; n: number; icon: typeof Truck; to: string | undefined; late: boolean } => !!x);
  if (!items.length) return null;
  return (
    <section aria-label="Today" className="card grid grid-cols-2 gap-px overflow-hidden bg-line p-0 lg:grid-cols-4">
      {items.map((it) => {
        const body = (
          <>
            <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-md', it.late && it.n > 0 ? 'bg-red-50 text-red-700' : it.tone < 0 ? 'bg-gray-100 text-gray-500' : SERIES[it.tone].chip)} aria-hidden>
              <it.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[12px] text-gray-500">{it.label}</div>
              <div className={cx('tabular-nums text-[18px]', it.late && it.n > 0 ? 'font-semibold text-red-700' : 'text-gray-900')}>{it.n}</div>
            </div>
          </>
        );
        return it.to ? (
          <Link key={it.label} to={it.to} className="flex items-center gap-3 bg-surface px-4 py-2.5 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40">{body}</Link>
        ) : (
          <div key={it.label} className="flex items-center gap-3 bg-surface px-4 py-2.5">{body}</div>
        );
      })}
    </section>
  );
}
