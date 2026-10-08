import { useEffect } from 'react';

const NON_TEXT = new Set(['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'range', 'color', 'hidden']);
const STOPS = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([disabled]):not([readonly]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([readonly]):not([tabindex="-1"])';

/**
 * Data entry is keyboard-first: Enter in a form's text box moves to the next field, and only Enter
 * in the LAST field submits (so a login or a one-field dialog still saves on Enter). It steps back
 * for anything that already owns Enter — a textarea (new line), a combobox (picks an option), a
 * control that called preventDefault itself (the bill's item grid) — and and a form marked `data-enter-submit="never"` (the bill: it saves on Ctrl+S / the button only) — and for a box outside a form
 * (search / filters), which is never a data-entry step.
 */
export function enterToNext(e: KeyboardEvent): void {
  const el = e.target;
  if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!(el instanceof HTMLInputElement) || NON_TEXT.has(el.type) || el.readOnly || el.disabled || el.getAttribute('role') === 'combobox') return;
  const form = el.form;
  if (!form) return;
  const stops = Array.from(form.querySelectorAll<HTMLElement>(STOPS));
  const next = stops[stops.indexOf(el) + 1];
  // Last field: the browser's own Enter-to-submit — unless the form says Enter must never save it.
  if (!next && form.dataset.enterSubmit !== 'never') return;
  e.preventDefault();
  next?.focus();
  if (next instanceof HTMLInputElement) next.select?.();
}

/** Installs the rule once for the whole app (mounted by the app shell). */
export function useEnterToNext(): void {
  useEffect(() => {
    document.addEventListener('keydown', enterToNext);
    return () => document.removeEventListener('keydown', enterToNext);
  }, []);
}
