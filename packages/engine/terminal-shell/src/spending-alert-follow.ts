/**
 * spending-alert-follow.ts: the daemon's spending alert said in this terminal
 * program, once.
 *
 * When what the daemon's own runs (schedules, work, web chat, shared sessions)
 * cost in the last 24 hours first passes the spending alert, the daemon sends
 * it to the notification addresses and announces LIST_CHANGED `spending` with
 * the id `alert-passed:<when>` (control-plane/routes/attribution-ingest.ts).
 * On that notice this program reads the alert's sentence from `usage.by-source`
 * (`data.alert.text`, the daemon's own words) and says it as a notice in the
 * conversation, once per crossing. A crossing announced while this program was
 * not connected is not said here (Money, Spending, and the menu's Money row
 * show where the runs stand). Nothing waits on a clock.
 */
import { subscribeDaemonEventFrames, type DaemonFrameChange } from '@goodvibes/engine/platform/platform/runtime/client';

/** The id prefix of a crossing's LIST_CHANGED `spending` notice (runtime/cost/model-usage.ts says the same). */
const ALERT_PASSED = 'alert-passed:';

export interface SpendingAlertFollowOptions {
  /** The daemon's address and credential for its event stream, or why there is none. */
  readonly daemonEndpoint: () => Promise<{ readonly baseUrl: string; readonly token: string | null } | { readonly unavailable: string }>;
  /** Told each time this program's daemon connection comes back; returns the stop. */
  readonly onDaemonBack: (listener: () => void) => () => void;
  /** A daemon method, called as this program. */
  readonly invoke: (method: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  /** Says the sentence as a notice in the conversation. */
  readonly say: (text: string) => void;
}

function alertText(answer: unknown): string | undefined {
  const data = answer !== null && typeof answer === 'object' ? (answer as { data?: unknown }).data : undefined;
  const alert = data !== null && typeof data === 'object' ? (data as { alert?: unknown }).alert : undefined;
  if (alert === null || typeof alert !== 'object') return undefined;
  const { passed, text } = alert as { passed?: unknown; text?: unknown };
  return passed === true && typeof text === 'string' && text.trim() !== '' ? text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim() : undefined;
}

/** Follow the daemon's spending alert for this program; returns the stop. */
export function followDaemonSpendingAlert(options: SpendingAlertFollowOptions): () => void {
  let stopped = false;
  let stopStream: (() => void) | null = null;
  const said = new Set<string>();
  const heard = (change?: DaemonFrameChange): void => {
    const id = change?.id;
    if (stopped || change?.list !== 'spending' || typeof id !== 'string' || !id.startsWith(ALERT_PASSED) || said.has(id)) return;
    said.add(id);
    void options.invoke('capabilities.run', { id: 'usage.by-source', inputs: { window: '24h', by: 'source' } }).then((answer) => {
      const text = alertText(answer);
      if (text !== undefined && !stopped) options.say(text);
    }, () => { /* Not read: Money, Spending, still shows where the runs stand. */ });
  };
  const open = (): void => {
    stopStream?.();
    stopStream = null;
    void options.daemonEndpoint().then((endpoint) => {
      if (stopped || 'unavailable' in endpoint) return;
      stopStream = subscribeDaemonEventFrames(
        { baseUrl: endpoint.baseUrl, getAuthToken: () => endpoint.token },
        { domains: ['workspace'], events: [], lists: ['spending'] },
        heard,
      );
    }, () => { /* No daemon yet: opened when this program's daemon connection is back. */ });
  };
  open();
  const stopBack = options.onDaemonBack(() => { if (!stopped) open(); });
  return () => {
    stopped = true;
    stopBack();
    stopStream?.();
    stopStream = null;
  };
}
