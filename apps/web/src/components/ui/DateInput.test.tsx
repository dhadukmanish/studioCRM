// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { addDays, addMonths, monthGrid } from '@/lib/calendar';
import { DateInput, DateRangeInput } from './DateInput';

/**
 * The shared date picker, rendered for real. Pins what operators rely on: the text follows the
 * Settings format (here DD/MM/YYYY, never the browser's), typing needs no calendar, a picked day is
 * exactly the stored day in any timezone, Clear only where the field is optional, and an old year
 * is a few clicks away.
 */
vi.mock('@/lib/settings', () => ({ useDisplayFormats: () => ({ dateFormat: 'dd/MM/yyyy', timeFormat: 'HH:mm' }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const changes: string[] = [];

function Harness({ initial = '', clearable, min, max }: { initial?: string; clearable?: boolean; min?: string; max?: string }) {
  const [v, setV] = useState(initial);
  return <DateInput aria-label="Bill date" value={v} clearable={clearable} min={min} max={max} onChange={(x) => { changes.push(x); setV(x); }} />;
}
function RangeHarness({ to = '' }: { to?: string }) {
  const [r, setR] = useState({ from: '2026-09-10', to });
  return <DateRangeInput label="Bill date" from={r.from} to={r.to} onFrom={(from) => setR((x) => ({ ...x, from }))} onTo={(to) => { changes.push(to); setR((x) => ({ ...x, to })); }} />;
}

async function render(el: JSX.Element) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(el));
}
const field = (label = 'Bill date') => host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
const pop = () => document.body.querySelector('[role=dialog]') as HTMLElement | null;
const btn = (label: string) => pop()!.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
const byText = (text: string) => [...pop()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const caption = () => pop()!.querySelector('button[aria-live]')!.textContent;
async function type(v: string, el = field()) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = (el: HTMLElement) => act(async () => el.click());
const key = (el: Element, k: string, extra: KeyboardEventInit = {}) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...extra })); });
const openByIcon = (wrap: ParentNode = host) => click(wrap.querySelector('button[aria-label="Open calendar"]') as HTMLButtonElement);

describe('DateInput — the professional date picker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 27, 10, 0)); // 27 Sep 2026, local time
    changes.length = 0;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('shows the Settings format (DD/MM/YYYY), not the browser locale — and no native date input is left', async () => {
    await render(<Harness initial="2026-09-05" />);
    expect(field().value).toBe('05/09/2026');
    expect(field().placeholder).toBe('DD/MM/YYYY');
    expect(document.querySelector('input[type=date]')).toBeNull();
  });

  it('typing needs no calendar: 27/09/2026 and 27092026 both store 2026-09-27; half-typed text is reported as typed', async () => {
    await render(<Harness />);
    await type('27/09/2026');
    expect(changes.at(-1)).toBe('2026-09-27');
    await type('01012027');
    expect(changes.at(-1)).toBe('2027-01-01');
    await type('31/02/2026');
    expect(changes.at(-1)).toBe('31/02/2026'); // left for validDate to refuse, never guessed
    expect(field().getAttribute('aria-invalid')).toBe('true');
  });

  it('calendar pick: opens on the value month, a click stores that exact day, closes and shows it formatted', async () => {
    await render(<Harness initial="2026-09-05" />);
    await openByIcon();
    expect(caption()).toBe('September 2026');
    await click(btn('15 September 2026'));
    expect(changes.at(-1)).toBe('2026-09-15');
    expect(pop()).toBeNull();
    expect(field().value).toBe('15/09/2026');
    expect(document.activeElement).toBe(field());
  });

  it('marks today, and Today picks the local business date', async () => {
    await render(<Harness initial="2026-09-05" />);
    await openByIcon();
    expect(btn('27 September 2026, today').getAttribute('aria-current')).toBe('date');
    await click(byText('Today'));
    expect(changes.at(-1)).toBe('2026-09-27');
  });

  it('a required date offers no Clear; an optional one clears to blank', async () => {
    await render(<Harness initial="2026-09-05" />);
    await openByIcon();
    expect(byText('Clear')).toBeUndefined();
    await act(async () => root.unmount());
    host.remove();
    await render(<Harness initial="2026-09-05" clearable />);
    await openByIcon();
    await click(byText('Clear'));
    expect(changes.at(-1)).toBe('');
    expect(field().value).toBe('');
  });

  it('old Birth Date: caption → year page → year → month → day, a handful of clicks', async () => {
    await render(<Harness />);
    await openByIcon();
    await click(pop()!.querySelector('button[aria-live]') as HTMLButtonElement); // months of 2026
    expect(caption()).toBe('2026');
    await click(pop()!.querySelector('button[aria-live]') as HTMLButtonElement); // years
    expect(caption()).toBe('2016 – 2027');
    await click(btn('Previous years'));
    await click(btn('Previous years'));
    expect(caption()).toBe('1992 – 2003');
    await click(byText('1995'));
    await click(btn('March 1995'));
    expect(caption()).toBe('March 1995');
    await click(btn('10 March 1995'));
    expect(changes.at(-1)).toBe('1995-03-10');
  });

  it('keyboard: Alt+↓ opens on the selected day, arrows / PageDown move, Enter picks, Escape returns to the field', async () => {
    await render(<Harness initial="2026-12-30" />);
    await key(field(), 'ArrowDown', { altKey: true });
    expect(document.activeElement?.getAttribute('data-day')).toBe('2026-12-30');
    await key(document.activeElement!, 'ArrowRight');
    await key(document.activeElement!, 'ArrowRight'); // across the year end
    expect(document.activeElement?.getAttribute('data-day')).toBe('2027-01-01');
    expect(caption()).toBe('January 2027');
    await key(document.activeElement!, 'PageDown');
    expect(document.activeElement?.getAttribute('data-day')).toBe('2027-02-01');
    await key(document.activeElement!, 'Enter');
    expect(changes.at(-1)).toBe('2027-02-01');
    expect(pop()).toBeNull();
    await key(field(), 'F4');
    expect(pop()).not.toBeNull();
    await key(document.activeElement!, 'Escape');
    expect(pop()).toBeNull();
    expect(document.activeElement).toBe(field());
  });

  it('29 February and month ends: the grid and the keys land on real days only', async () => {
    await render(<Harness initial="2028-02-28" />);
    await key(field(), 'ArrowDown', { altKey: true });
    await key(document.activeElement!, 'ArrowRight');
    expect(document.activeElement?.getAttribute('data-day')).toBe('2028-02-29');
    await key(document.activeElement!, 'ArrowRight');
    expect(document.activeElement?.getAttribute('data-day')).toBe('2028-03-01');
  });

  it('bounds: days outside min/max are shown but cannot be picked', async () => {
    await render(<Harness initial="2026-09-15" min="2026-09-10" />);
    await openByIcon();
    expect(btn('9 September 2026').disabled).toBe(true);
    expect(btn('10 September 2026').disabled).toBe(false);
  });

  it('range: picking From opens To on that month; To cannot be before From; the span is shaded', async () => {
    await render(<RangeHarness />);
    await openByIcon(field('Bill date from').parentElement!);
    await click(btn('12 September 2026'));
    // To opened by itself, on From's month
    expect(pop()).not.toBeNull();
    expect(document.activeElement?.closest('[role=dialog]')).toBe(pop());
    expect(btn('11 September 2026').disabled).toBe(true);
    await click(btn('20 September 2026'));
    expect(changes.at(-1)).toBe('2026-09-20');
    expect(field('Bill date to').value).toBe('20/09/2026');
    await openByIcon(field('Bill date to').parentElement!);
    expect(btn('15 September 2026').closest('[role=gridcell]')!.className).toContain('bg-primary-50');
  });

  it('range with a default To (a report period): picking From still moves on to To', async () => {
    await render(<RangeHarness to="2026-09-30" />);
    await openByIcon(field('Bill date from').parentElement!);
    await click(btn('3 September 2026'));
    expect(pop()?.getAttribute('aria-label')).toBe('Choose bill date to');
    await key(document.activeElement!, 'Escape');
    expect(field('Bill date to').value).toBe('30/09/2026'); // Escape keeps To as it was
  });
});

describe('calendar arithmetic — date-only, no timezone can shift it', () => {
  const zones = ['Pacific/Honolulu', 'America/New_York', 'UTC', 'Asia/Kolkata', 'Pacific/Kiritimati'];
  const originalTz = process.env.TZ;
  afterEach(() => { process.env.TZ = originalTz; });

  it.each(zones)('under %s: day, month and year boundaries and leap days stay exact', (tz) => {
    process.env.TZ = tz;
    expect(addDays('2026-09-27', 0)).toBe('2026-09-27');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09'); // a US daylight-saving change
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    const grid = monthGrid(2026, 9);
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe('2026-08-30'); // the Sunday before 1 Sep 2026 (a Tuesday)
    expect(grid).toContain('2026-09-30');
  });
});
