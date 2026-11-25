/**
 * The daemon's spending alert, shown once in this tab as a notice. When what the
 * daemon's own runs (schedules, work, web chat, shared sessions) cost in the last
 * 24 hours first passes the alert, the daemon announces LIST_CHANGED `spending`
 * with the id `alert-passed:<when>`; on that frame this tab reads the alert's
 * sentence from `usage.by-source` (`data.alert.text`, the daemon's own words,
 * the same every terminal program shows) and shows it once per crossing. A
 * crossing announced while no tab was open is not shown here (Money, Spending,
 * shows where the runs stand). Nothing is read on a clock.
 */
import { useEffect, useRef } from 'react';
import { client as platformClient } from '../../lib/goodvibes';
import { useToast } from '../../lib/toast';
import { subscribeEvents } from '../../lib/event-stream';

const ALERT_PASSED = 'alert-passed:';

/** The crossing's id, when a `workspace` frame is LIST_CHANGED `spending` for one (the envelope or its payload). */
function crossingOf(frame: unknown): string | null {
  const outer = (frame ?? {}) as { type?: unknown; list?: unknown; id?: unknown; payload?: unknown };
  const inner = (outer.payload ?? {}) as { type?: unknown; list?: unknown; id?: unknown };
  for (const event of [inner, outer]) {
    if (event.type === 'LIST_CHANGED' && event.list === 'spending' && typeof event.id === 'string' && event.id.startsWith(ALERT_PASSED)) return event.id;
  }
  return null;
}

/** The sentence the daemon wrote for a passed alert, from `usage.by-source`'s answer. */
function alertText(answer: unknown): string | null {
  const data = (answer ?? {}) as { data?: { alert?: { passed?: unknown; text?: unknown } } };
  const alert = data.data?.alert;
  return alert?.passed === true && typeof alert.text === 'string' && alert.text.trim() !== '' ? alert.text : null;
}

export function SpendingAlertNotice(): null {
  const { toast } = useToast();
  const shown = useRef(new Set<string>());
  useEffect(() => {
    let stopped = false;
    const unsubscribe = subscribeEvents({
      domains: ['workspace'],
      events: ['workspace'],
      onEvent: (_name, payload) => {
        const crossing = crossingOf(payload);
        if (crossing === null || shown.current.has(crossing)) return;
        shown.current.add(crossing);
        void platformClient.operator.invoke('capabilities.run' as never, { id: 'usage.by-source', inputs: { window: '24h', by: 'source' } } as never)
          .then((answer: unknown) => {
            const text = alertText(answer);
            if (text !== null && !stopped) toast({ title: 'Spending alert passed', description: text, tone: 'warning', durationMs: 0 });
          }, () => { /* Not read: Money, Spending, still shows where the runs stand. */ });
      },
    });
    return () => { stopped = true; unsubscribe(); };
  }, [toast]);
  return null;
}
