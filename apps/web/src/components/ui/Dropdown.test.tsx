// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Dropdown } from './index';

/**
 * A row's ••• menu sits inside a table's scroll box (overflow: auto), which clipped it. The menu is
 * drawn on <body> instead, so no container can cut it — and it still behaves like the row's menu.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(onEdit: () => void) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <div data-testid="scroll-box" style={{ overflow: 'auto', height: 40 }}>
        <Dropdown items={[{ label: 'Edit', onClick: onEdit }, { label: 'Delete', danger: true }]} trigger={<button type="button" aria-label="More">•••</button>} />
      </div>,
    );
  });
}
const menuButton = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent === label);

describe('Dropdown', () => {
  it('opens its menu outside any clipping container and runs the chosen item', async () => {
    const onEdit = vi.fn();
    await render(onEdit);
    await act(async () => (host.querySelector('[aria-label="More"]') as HTMLButtonElement).click());
    const edit = menuButton('Edit')!;
    expect(edit).toBeDefined();
    expect(host.querySelector('[data-testid="scroll-box"]')!.contains(edit)).toBe(false);
    await act(async () => edit.click());
    expect(onEdit).toHaveBeenCalledOnce();
    expect(menuButton('Edit')).toBeUndefined(); // closed after choosing
  });

  it('closes on a click elsewhere and on Escape', async () => {
    await render(() => {});
    const open = () => act(async () => (host.querySelector('[aria-label="More"]') as HTMLButtonElement).click());
    await open();
    await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(menuButton('Edit')).toBeUndefined();
    await open();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(menuButton('Edit')).toBeUndefined();
  });
});
