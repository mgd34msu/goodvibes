/**
 * A newer web UI is being served (the daemon's compatibility answer says
 * `restart-required`): the page reloads by itself when nothing would be lost
 * (lib/reload-guard: no unsent text, no reply streaming, nothing open over the
 * page). Until then it shows "Reload to update" in the header, and reloads at
 * the next moment those are all clear: read again when a hold is let go, when
 * the person types, clicks or presses a key, or when focus moves. No timer.
 */
import { useEffect } from 'react';
import { TriangleAlert } from 'lucide-react';
import { reloadIsSafe, subscribeReloadGuard } from '../../lib/reload-guard';

const RELOADED_KEY = 'goodvibes.webui.update-reloaded';

function alreadyReloadedFor(message: string): boolean {
  try { return window.sessionStorage.getItem(RELOADED_KEY) === message; } catch { return false; }
}

/** False when this tab cannot remember it: then it never reloads by itself (that could loop), and the button stays. */
function rememberReloadFor(message: string): boolean {
  try { window.sessionStorage.setItem(RELOADED_KEY, message); return window.sessionStorage.getItem(RELOADED_KEY) === message; } catch { return false; }
}

export function UpdateReload({ message }: { message: string }) {
  useEffect(() => {
    // One reload by itself per answer: if the page that loads still hears the same answer, a
    // reload is not what it needs, and the button stays for the person instead of a loop.
    if (alreadyReloadedFor(message)) return undefined;
    let done = false;
    const check = () => {
      if (done || !reloadIsSafe()) return;
      done = true;
      if (rememberReloadFor(message)) window.location.reload();
    };
    // After the event's own handlers ran (a send clears the box, a dialog closes).
    const soon = () => { queueMicrotask(check); };
    check();
    const unsubscribe = subscribeReloadGuard(soon);
    const events = ['input', 'click', 'keyup', 'focusin', 'focusout'] as const;
    for (const name of events) document.addEventListener(name, soon, true);
    return () => {
      unsubscribe();
      for (const name of events) document.removeEventListener(name, soon, true);
    };
  }, [message]);

  return (
    <button
      type="button"
      className="status-strip__segment status-strip__segment--button status-strip__segment--compatibility-warning"
      title={message}
      aria-label={`Reload to update. ${message}`}
      onClick={() => window.location.reload()}
    >
      <TriangleAlert className="status-strip__icon" aria-hidden="true" size={12} />
      <span className="status-strip__label">Reload to update</span>
    </button>
  );
}
