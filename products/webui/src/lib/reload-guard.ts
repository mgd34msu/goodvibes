/**
 * Whether the page can be reloaded without losing anything: no reply streaming (a
 * view holds the guard while one runs), no unsent text in a text box or field,
 * and no dialog or panel open. The update reload (components/shell/UpdateReload)
 * waits for this.
 */

const holds = new Set<symbol>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Hold reloads while something is in progress (a reply streaming); call the result to let go. */
export function holdReload(): () => void {
  const token = Symbol('reload-hold');
  holds.add(token);
  notify();
  return () => {
    if (holds.delete(token)) notify();
  };
}

/** Told when a hold is taken or let go. */
export function subscribeReloadGuard(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Unsent text: a text box, or a text field of a form, that holds anything typed. */
function hasUnsentText(): boolean {
  for (const element of document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, form input')) {
    if (element instanceof HTMLInputElement && !['text', 'email', 'url', 'number', 'tel', ''].includes(element.type)) continue;
    if (element.value.trim() !== '') return true;
  }
  return false;
}

/** A dialog, drawer, sheet or menu open over the page (the kit marks each layer). */
function hasOpenLayer(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"], [data-gv-layer]:not(.gv-tooltip)') !== null;
}

/** Nothing would be lost by reloading now. */
export function reloadIsSafe(): boolean {
  if (typeof document === 'undefined') return false;
  return holds.size === 0 && !hasUnsentText() && !hasOpenLayer();
}
