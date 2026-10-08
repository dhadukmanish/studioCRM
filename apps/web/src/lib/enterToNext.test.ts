// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { enterToNext } from './enterToNext';

const press = (el: Element) => {
  const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  enterToNext(e);
  return e;
};
const mount = (html: string) => {
  document.body.innerHTML = html;
  return (id: string) => document.getElementById(id) as HTMLInputElement;
};

afterEach(() => { document.body.innerHTML = ''; });

describe('Enter moves to the next field', () => {
  it('goes to the next input, skipping disabled / read-only / checkbox, and does not submit', () => {
    const $ = mount('<form><input id="a"><input id="b" disabled><input id="c" readonly><input id="d" type="checkbox"><input id="e"></form>');
    $('a').focus();
    expect(press($('a')).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($('e'));
  });

  it('leaves Enter in the last field to submit', () => {
    const $ = mount('<form><input id="a"><input id="b"></form>');
    $('b').focus();
    expect(press($('b')).defaultPrevented).toBe(false);
  });

  it('never submits a form marked enter-submit=never, even from its last field', () => {
    const $ = mount('<form data-enter-submit="never"><input id="a"></form>');
    expect(press($('a')).defaultPrevented).toBe(true);
  });

  it('ignores a box outside a form, a combobox, and a keypress something else already handled', () => {
    const $ = mount('<input id="s"><form><input id="c" role="combobox"><input id="x"></form>');
    expect(press($('s')).defaultPrevented).toBe(false);
    expect(press($('c')).defaultPrevented).toBe(false);
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    e.preventDefault();
    $('x').dispatchEvent(e);
    enterToNext(e);
    expect(document.activeElement).not.toBe($('c'));
  });
});
