// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReceivePaymentDialog, type ReceivePaymentFor } from './ReceivePaymentDialog';

/**
 * Renders the REAL quick Receive payment dialog — the one component that posts money from a routine
 * screen — with only the server stubbed, and pins exactly what it sends: up to Due on the bill, the
 * rest as advance (by the receipt amount exceeding its allocation), nothing on a bill when there is
 * no bill, and nothing at all until "Receive ₹X" is pressed. The server re-decides all of it.
 */
const raw = vi.fn();
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { raw: (...a: unknown[]) => raw(...a), get: vi.fn(async () => []) },
}));
vi.mock('@/lib/receipts', async (orig) => ({
  ...(await orig<typeof import('@/lib/receipts')>()),
  usePaymentAccounts: () => ({ data: [{ id: 'acc-cash', accountName: 'CASH IN HAND', groupName: 'CASH' }], isLoading: false, isError: false }),
}));
vi.mock('@/lib/settings', () => ({
  useDateFormatters: () => ({ date: (v: string) => v, time: (v: string) => v, stamp: (v: string) => v, stampTime: (v: string) => v, dateFormat: 'yyyy-MM-dd' }),
  useDisplayFormats: () => ({ dateFormat: 'yyyy-MM-dd', timeFormat: 'HH:mm' }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BILL: ReceivePaymentFor = { customerKey: '9876500001', customerName: 'Riya Patel', bill: { id: 'bill-1', reference: '2026-27/5', due: 5000 } };
const ADVANCE: ReceivePaymentFor = { customerKey: '9876500002', customerName: 'Meera Shah' };

let root: Root;
let host: HTMLDivElement;
const onClose = vi.fn();
async function render(p: ReceivePaymentFor) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ReceivePaymentDialog open onClose={onClose} payment={p} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}
const dialog = () => document.body.querySelector('[role=dialog]') as HTMLElement;
const amount = () => dialog().querySelector('input[aria-label="Amount received"]') as HTMLInputElement;
async function type(v: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(amount(), v);
    amount().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const receiveButton = () => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith('Receive')) as HTMLButtonElement;
async function receive() {
  await act(async () => receiveButton().click());
}
const sent = () => raw.mock.calls.at(-1)?.[2] as Record<string, unknown>;

describe('Receive payment (quick dialog)', () => {
  beforeEach(() => {
    raw.mockReset();
    raw.mockResolvedValue({ message: 'ok', data: { amount: 1, receiptNumber: 9 } });
    onClose.mockReset();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('from a bill: opens on the Due, with the only account preselected — and posts nothing until pressed', async () => {
    await render(BILL);
    expect(amount().value).toBe('5000.00');
    expect(dialog().textContent).toContain('Due');
    expect(receiveButton().textContent).toContain('Receive ₹5,000.00');
    expect(raw).not.toHaveBeenCalled();
    await receive();
    expect(raw).toHaveBeenCalledWith('POST', '/api/receipts', expect.anything());
    expect(sent()).toMatchObject({ customerMobile: '9876500001', paymentMode: 'CASH', accountId: 'acc-cash', amount: 5000, allocations: [{ billId: 'bill-1', amount: 5000 }] });
    expect(onClose).toHaveBeenCalled();
  });

  it('more than Due: the bill takes only its Due, the rest is advance (amount > allocation)', async () => {
    await render(BILL);
    await type('7000');
    expect(dialog().textContent).toContain('₹2,000.00 more than due — kept as Advance');
    await receive();
    expect(sent()).toMatchObject({ amount: 7000, allocations: [{ billId: 'bill-1', amount: 5000 }] });
  });

  it('less than Due: all of it goes on the bill, and the dialog says what is still due', async () => {
    await render(BILL);
    await type('1234.50');
    expect(dialog().textContent).toContain('₹3,765.50 will still be due');
    await receive();
    expect(sent()).toMatchObject({ amount: 1234.5, allocations: [{ billId: 'bill-1', amount: 1234.5 }] });
  });

  it('no bill: labelled Advance, empty amount, and posted with no allocation at all', async () => {
    await render(ADVANCE);
    expect(dialog().textContent).toContain('Advance');
    expect(amount().value).toBe('');
    await type('2000');
    await receive();
    expect(sent()).toMatchObject({ customerMobile: '9876500002', customerName: 'Meera Shah', amount: 2000, allocations: [] });
  });

  it('a bad amount is refused on the field and nothing is posted', async () => {
    await render(BILL);
    await type('12.345');
    await receive();
    expect(raw).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('at most 2 decimals');
  });

  it("the server's refusal lands on the field it names", async () => {
    raw.mockRejectedValueOnce(Object.assign(new (await import('@/lib/api')).ApiError('VALIDATION_ERROR', 'Bill is already fully paid', 422, [{ path: ['allocations', 0, 'amount'], message: 'Bill 2026-27/5 is already fully paid' }]), {}));
    await render(BILL);
    await receive();
    expect(dialog().textContent).toContain('Bill 2026-27/5 is already fully paid');
    expect(onClose).not.toHaveBeenCalled();
  });
});
