import { readPaymentWindowStatus, readPaymentWindowAnswer, readPaymentOperation, readPaymentOperationCancellation, paymentOperationDescription, isLivePaymentOperation, canReconcilePaymentOperation,
  type PaymentWindowView, type PaymentOperationView } from '@goodvibes-jev/engine/platform/platform/payments/browser';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { OwnedSelectionObservation } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { RetainedOperatorConnection, type RetainedOperatorConnectionPolicy, type SelectedOperatorConnection } from './retained-operator-connection.js';
import type { OpenSelection, SelectionItem, SelectionResult } from './selection-modal.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';
import { isPairedOperatorPrincipal } from './native/native-paired-principal.js';

export interface PaymentWindowCommandContext {
  readonly print: (message: string) => void;
  readonly renderRequest: () => void;
  readonly openSelection?: OpenSelection;
}
export interface PaymentWindowCommandPolicy<Context> {
  readonly isOwner: (context: Context) => boolean;
  readonly owner: (context: Context) => ConfigManager;
  readonly home: (context: Context) => string;
  readonly read: (context: Context, observation: OwnedSelectionObservation) => SelectedOperatorConnection | null;
  readonly files: (selection: SelectedOperatorConnection, home: string) => readonly string[];
  readonly environment?: RetainedOperatorConnectionPolicy['environment'];
  readonly fetchImpl?: RetainedOperatorConnectionPolicy['fetchImpl'];
}

/** Display-only sanitation; original purchase/window references go back unchanged. */
function text(value: string): string {
  return stripDangerousAnsi(value).replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
function detail(window: PaymentWindowView): string {
  return `${text(window.notice)}\n\nDeadline: ${new Date(window.deadlineMs).toLocaleString()}`;
}

/** The products supply host-selection policy; menu, gesture, transport and
 * lifetime behavior are shared. No model interprets a typed owner answer.
 */
export function createPaymentWindowCommand<Context extends PaymentWindowCommandContext>(policy: PaymentWindowCommandPolicy<Context>) {
  return async function openPaymentWindows(context: Context): Promise<void> {
    // Retain the actual dispatch proof before the first await. A model invoking
    // the same slash command cannot open an approval picker or mint this proof.
    if (!policy.isOwner(context)) {
      context.print('[payments] Type /payments pending in the owner terminal to review purchase windows.');
      return;
    }
    const open = context.openSelection;
    if (!open) { context.print('[payments] Purchase-window selection is unavailable on this surface.'); return; }
    const ownerAbort = new AbortController();
    let connection: RetainedOperatorConnection;
    try {
      connection = new RetainedOperatorConnection({
        owner: () => policy.owner(context), home: () => policy.home(context),
        read: observation => policy.read(context, observation), files: policy.files,
        environment: policy.environment, fetchImpl: policy.fetchImpl, signal: ownerAbort.signal,
      });
    } catch {
      context.print('[payments] Check the selected daemon and its paired owner credential, then reopen /payments pending.');
      return;
    }
    let closed = false;
    let replacing = false;
    let pickerAbort: AbortController | undefined;
    let principal: string | undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      ownerAbort.abort();
      pickerAbort?.abort();
      pickerAbort = undefined;
      principal = undefined;
      void connection.close();
    };
    const report = (message: string) => {
      if (closed) return;
      context.print(message);
      context.renderRequest();
    };
    const show = (title: string, items: SelectionItem[], chosen: (result: SelectionResult) => void) => {
      if (closed) return;
      connection.assertCurrent();
      if (context.openSelection !== open) throw new Error('The terminal picker owner changed.');
      replacing = true;
      try { pickerAbort?.abort(); } finally { replacing = false; }
      pickerAbort = new AbortController();
      open.call(context, title, items, { allowSearch: false, primaryVerbLabel: 'Choose', signal: AbortSignal.any([connection.signal, pickerAbort.signal]) }, result => {
        if (replacing || closed) return;
        if (result === null || result.action !== 'select') { finish(); return; }
        try { connection.assertCurrent(); chosen(result); }
        catch { report('[payments] The host or purchase window changed. Reopen /payments pending.'); finish(); }
      });
    };
    const loading = (title: string) => show(title, [], () => {});
    const authenticate = async (): Promise<void> => {
      const auth = await connection.run((operator, signal) => operator.control.auth.current({}, { signal }));
      if (!isPairedOperatorPrincipal(auth, ['read:payments', 'write:payments'], connection.expectedPrincipalId) || (principal !== undefined && auth.principalId !== principal)) {
        throw new Error('A current paired administrative payment owner is required.');
      }
      principal = auth.principalId;
    };
    const fail = (answering: boolean) => {
      // Typed failures can contain neither a semantic reinterpretation nor
      // provider/transport text which might echo the credential or request.
      report(answering
        ? '[payments] Could not confirm the purchase-window answer. Refresh /payments pending before trying again.'
        : '[payments] Could not read purchase windows. Check the selected host, pairing and payment scopes, then retry /payments pending.');
      finish();
    };
    const answer = async (window: PaymentWindowView, action: 'approve' | 'deny' | 'cancel') => {
      try {
        loading('Sending purchase-window answer — Escape closes this view');
        await authenticate();
        const result = await connection.run(async (operator, signal) => readPaymentWindowAnswer(await operator.invoke(
          `payments.purchase.${action}`,
          { purchaseId: window.purchaseId, windowId: window.windowId, confirm: true },
          { signal, headers: { 'x-goodvibes-explicit-user-request': 'true' } },
        )));
        const expected = window.kind === 'approval' ? (action === 'approve' ? 'approve' : 'deny') : (action === 'approve' ? 'acknowledge' : 'object');
        if (result.purchaseId !== window.purchaseId || result.windowId !== window.windowId || result.answer !== expected) throw new Error('Mismatched answer.');
        report('[payments] Purchase-window answer accepted.');
        finish();
      } catch { fail(true); }
    };
    const choose = (window: PaymentWindowView) => {
      const notice = detail(window);
      const choices: SelectionItem[] = window.kind === 'approval'
        ? [{ id: 'approve', label: 'Approve purchase', detail: notice }, { id: 'deny', label: 'Deny purchase', detail: notice }]
        : [{ id: 'approve', label: 'Proceed now', detail: notice }, { id: 'cancel', label: 'Cancel purchase', detail: notice }];
      show(`Purchase ${text(window.purchaseId)}`, choices, result => {
        const action = choices.find(item => item.id === result.item.id)?.id;
        if (action !== 'approve' && action !== 'deny' && action !== 'cancel') { finish(); return; }
        void answer(window, action);
      });
    };
    const stop = async (operation: PaymentOperationView): Promise<void> => {
      try {
        loading('Requesting checkout stop — Escape closes this view');
        await authenticate();
        const result = await connection.run(async (operator, signal) => readPaymentOperationCancellation(await operator.invoke(
          'payments.purchase.cancel', { purchaseId: operation.purchaseId, operationId: operation.operationId, confirm: true },
          { signal, headers: { 'x-goodvibes-explicit-user-request': 'true' } },
        )));
        if (result.purchaseId !== operation.purchaseId || result.operationId !== operation.operationId) throw new Error('Mismatched stop acknowledgement.');
        report(result.mayHaveSubmitted
          ? '[payments] Stop requested; submission may already have begun. Check purchase status and the merchant. This does not undo an order.'
          : '[payments] Stop requested. Check final purchase status before taking further action.');
        await refresh();
      } catch { fail(true); }
    };
    const reconcile = async (operation: PaymentOperationView, outcome: 'purchased' | 'not-purchased'): Promise<void> => {
      try {
        loading('Recording your merchant-history finding — Escape closes this view');
        await authenticate();
        const result = await connection.run(async (operator, signal) => readPaymentOperation(await operator.invoke(
          'payments.purchase.reconcile', { purchaseId: operation.purchaseId, operationId: operation.operationId,
            outcome, inspectedMerchantHistory: true, confirm: true },
          { signal, headers: { 'x-goodvibes-explicit-user-request': 'true' } },
        )));
        if (result.purchaseId !== operation.purchaseId || result.operationId !== operation.operationId || result.outcome !== `owner-confirmed-${outcome}`) throw new Error('Mismatched reconciliation.');
        report(`[payments] ${paymentOperationDescription(result)}`);
        await refresh();
      } catch {
        report('[payments] Could not confirm completed reconciliation. Refresh /payments pending and repeat only the finding already saved. Do not submit another order.');
        finish();
      }
    };
    const confirmFinding = (operation: PaymentOperationView, outcome: 'purchased' | 'not-purchased') => {
      const description = `Only continue after inspecting the merchant’s order history and your payment statement for this original checkout.\n\nFinding: ${outcome === 'purchased' ? 'an order was placed' : 'no order was placed'}.\n\nThis records your finding and settles original bookkeeping. It never places another order. A no-order finding releases an unspent hold; already committed spend is not credited. If the result is still unknown, close this view and keep the hold.`;
      show(`Confirm finding for ${text(operation.purchaseId)}`, [
        { id: 'confirm', label: 'I inspected merchant history; record this finding', detail: description },
        { id: 'back', label: 'Go back without changing this purchase', detail: description },
      ], result => { if (result.item.id === 'confirm') void reconcile(operation, outcome); else chooseOperation(operation); });
    };
    const chooseOperation = (operation: PaymentOperationView) => {
      const description = `${paymentOperationDescription(operation)}\n\nUpdated: ${new Date(operation.updatedAtMs).toLocaleString()}`;
      const choices: SelectionItem[] = [{ id: 'refresh', label: 'Refresh purchase status', detail: description }];
      if (isLivePaymentOperation(operation.state) && operation.state !== 'cancelling') choices.push({ id: 'stop', label: 'Stop this checkout', detail: `${description}\n\nStopping does not undo a merchant submission. Wait for final status.` });
      if (canReconcilePaymentOperation(operation)) {
        if (operation.outcome !== 'owner-reconciliation-pending-not-purchased') choices.push({ id: 'purchased', label: 'Merchant history confirms an order was placed', detail: description });
        if (operation.outcome !== 'owner-reconciliation-pending-purchased') choices.push({ id: 'not-purchased', label: 'Merchant history confirms no order was placed', detail: description });
      }
      show(`Checkout ${text(operation.purchaseId)} · ${operation.state}`, choices, result => {
        if (result.item.id === 'stop') { void stop(operation); return; }
        if (result.item.id === 'refresh') { void refresh(); return; }
        if (result.item.id === 'purchased' || result.item.id === 'not-purchased') { confirmFinding(operation, result.item.id); return; }
        finish();
      });
    };
    const refresh = async (): Promise<void> => {
      try {
        loading('Reading purchase windows — Escape cancels');
        await authenticate();
        const { windows, operations } = await connection.run(async (operator, signal) => readPaymentWindowStatus(await operator.invoke('payments.purchase.status', {}, { signal })));
        if (windows.length === 0 && operations.length === 0) { report('[payments] No purchase operations or windows on the selected host.'); finish(); return; }
        const byId = new Map(windows.map((window, index) => [`window-${index}`, window]));
        const byOperationId = new Map(operations.map((operation, index) => [`operation-${index}`, operation]));
        const items: SelectionItem[] = [...byId].map(([id, window]) => ({ id, label: `${window.kind === 'approval' ? 'Approval' : 'Veto'}: ${text(window.purchaseId)}`, detail: detail(window) }));
        for (const [id, operation] of byOperationId) items.push({ id, label: `${operation.state}: ${text(operation.purchaseId)}`, detail: paymentOperationDescription(operation) });
        items.push({ id: 'refresh', label: 'Refresh purchases', detail: 'Read current operations and windows from this same paired host.' });
        show('Purchases', items, result => {
          if (result.item.id === 'refresh') { void refresh(); return; }
          const operation = byOperationId.get(result.item.id);
          if (operation) { chooseOperation(operation); return; }
          const window = byId.get(result.item.id);
          if (!window) { finish(); return; }
          choose(window);
        });
      } catch { fail(false); }
    };
    await refresh();
  };
}
