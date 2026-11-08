import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PaymentWindowView } from '@goodvibes-jev/engine/sdk/platform/payments';
import { sdk } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { getClientLifetime, subscribeClientLifetime } from '../../lib/client-lifetime';
import { Button } from '../ui/Button';
import { SettingsBlock } from './dialog/parts';

const QUERY_KEY = ['payments', 'purchase-windows'] as const;

/** The daemon owns amounts, deadlines and outcomes. This view sends only the
 * exact notice reference selected by an explicit owner click; it never retries. */
export function PaymentWindows() {
  const queryClient = useQueryClient();
  const active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const identity = useSyncExternalStore(subscribeClientLifetime, () => getClientLifetime().revision, () => 0);
  const windows = useQuery({ queryKey: [...QUERY_KEY, identity], queryFn: ({ signal }) => sdk.operator.payments.purchase.status(signal),
    refetchInterval: 2000, retry: false, gcTime: 0 });
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => subscribeClientLifetime(() => {
    active.current?.abort(); active.current = null;
    setPending(null); setMessage('');
  }), []);

  const answer = async (window: PaymentWindowView, action: 'approve' | 'deny' | 'cancel') => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    const selected = { purchaseId: window.purchaseId, windowId: window.windowId };
    setPending(window.windowId); setMessage('');
    try {
      const result = await sdk.operator.payments.purchase[action](selected, controller.signal);
      if (controller.signal.aborted) return;
      setMessage(result.answer === 'approve' || result.answer === 'acknowledge'
        ? 'Answer accepted. The daemon will continue the checkout checks.'
        : 'Answer accepted. The pending purchase is being stopped.');
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessage(`${formatError(error)} Refresh the purchase status before trying again.`);
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) {
        setPending(null);
        void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      }
    }
  };

  return <SettingsBlock title="Purchase windows" description="Read the exact purchase notice before answering. Approval needs a yes; an in-budget veto proceeds when its stated deadline passes without an objection. Answers require a paired owner connection.">
    <Button size="sm" onClick={() => { void windows.refetch(); }} disabled={windows.isFetching}>Refresh purchases</Button>
    {windows.error && <p role="alert">{formatError(windows.error)}</p>}
    {windows.isPending && <p>Loading purchase windows…</p>}
    {!windows.isPending && !windows.error && windows.data?.windows.length === 0 && <p>No purchase window is waiting for an answer.</p>}
    {message && <p role="status">{message}</p>}
    {windows.data?.windows.map(window => <section key={window.windowId} aria-label={`Purchase ${window.purchaseId}`}>
      <h4>{window.kind === 'approval' ? 'Approval required' : 'Purchase veto window'}</h4>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{window.notice}</pre>
      <p>Deadline: {new Date(window.deadlineMs).toLocaleString()}</p>
      <Button disabled={pending !== null} onClick={() => { void answer(window, 'approve'); }}>
        {pending === window.windowId ? 'Sending answer…' : window.kind === 'approval' ? 'Approve purchase' : 'Proceed now'}
      </Button>
      <Button variant="danger" disabled={pending !== null} onClick={() => { void answer(window, window.kind === 'approval' ? 'deny' : 'cancel'); }}>
        {window.kind === 'approval' ? 'Deny purchase' : 'Cancel purchase'}
      </Button>
    </section>)}
  </SettingsBlock>;
}
