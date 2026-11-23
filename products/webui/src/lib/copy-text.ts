/**
 * copy-text.ts, copying text for the person on every origin this UI serves from.
 *
 * Browsers give the clipboard API (`navigator.clipboard`) only to a secure
 * context: https, or localhost. A phone opening the daemon at its plain-http
 * network address has none. There the text is copied through the editing
 * command on a hidden field (still allowed during a click), and when the
 * browser refuses that too, the text the caller shows is selected so the
 * person copies it with one key press, and told so.
 */

/** `copied`: on the clipboard. `selected`: selected on the page for the person to copy. `failed`: neither. */
export type CopyOutcome = 'copied' | 'selected' | 'failed';

function copyWithEditingCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.top = '0';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

/** Select what `target` shows, for the person to copy with one key press; false when the page has no selection. */
export function selectContents(target: Element): boolean {
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(target);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * Copy `text`. `showing` is the element on the page that shows the same text,
 * selected when nothing could be copied.
 */
export async function copyText(text: string, showing?: Element | null): Promise<CopyOutcome> {
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      // Refused (no permission, the page not focused): the other ways below.
    }
  }
  if (copyWithEditingCommand(text)) return 'copied';
  return showing && selectContents(showing) ? 'selected' : 'failed';
}

/** What the person is told when the text was not copied, or null when it was. */
export function copyOutcomeMessage(outcome: CopyOutcome): string | null {
  if (outcome === 'copied') return null;
  return outcome === 'selected'
    ? 'Selected: press Ctrl+C (Cmd+C on a Mac) to copy it. The browser did not let this page copy it (browsers keep the clipboard from pages on plain http).'
    : 'Could not copy: the browser did not let this page copy it (browsers keep the clipboard from pages on plain http). Select the text and copy it yourself.';
}
