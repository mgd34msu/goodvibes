import { readPaymentWindowStatus, readPaymentWindowAnswer, readPaymentSecurityCodeAcceptance, readPaymentOperation, readPaymentOperationCancellation, paymentOperationDescription, isLivePaymentOperation, canReconcilePaymentOperation,
  type PaymentWindowView, type PaymentOperationView, type PaymentSecurityCodeRequestView } from '@goodvibes-jev/engine/platform/platform/payments/browser';
import type { ConcealedInputRequest } from './concealed-input.js';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { OwnedSelectionObservation } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { describeRetainedConnectionFailure, RetainedOperatorConnection, type RetainedOperatorConnectionPolicy, type SelectedOperatorConnection } from './retained-operator-connection.js';
import type { OpenSelection, SelectionItem, SelectionResult } from './selection-modal.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';
import { isPairedOperatorPrincipal } from './native/native-paired-principal.js';

export interface PaymentWindowCommandContext {
  readonly print: (message: string) => void;
  readonly renderRequest: () => void;
  readonly openSelection?: OpenSelection;
  /** One masked composer line; the card security code is typed only through this. */
  readonly beginConcealedInput?: ((request: ConcealedInputRequest) => void) | undefined;
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
    } catch (error) {
      context.print(`[payments] ${describeRetainedConnectionFailure(error, 'reopen /payments pending')}`);
      return;
    }
    let closed = false;
    let replacing = false;
    // True while a request that changes a purchase is on the wire, so closing the view cannot claim it did nothing.
    let mutating = false;
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
        if (result === null || result.action !== 'select') {
          if (mutating) report('[payments] The request may already have reached the host. Reopen /payments pending to confirm what it did before trying again.');
          finish();
          return;
        }
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
    const mutate = async <T>(send: () => Promise<T>): Promise<T> => {
      mutating = true;
      try { return await send(); } finally { mutating = false; }
    };
    const fail = (what: 'answer' | 'stop' | 'read') => {
      // Typed failures can contain neither a semantic reinterpretation nor
      // provider/transport text which might echo the credential or request.
      report(what === 'answer'
        ? '[payments] Could not confirm the purchase-window answer. Refresh /payments pending before trying again.'
        : what === 'stop'
          ? '[payments] Could not confirm the checkout stop. Refresh /payments pending to see whether it was applied before trying again.'
          : '[payments] Could not read purchase windows. Check the selected host, pairing and payment scopes, then retry /payments pending.');
      finish();
    };
    const answer = async (window: PaymentWindowView, action: 'approve' | 'deny' | 'cancel') => {
      try {
        loading('Sending purchase-window answer — Escape closes this view');
        await authenticate();
        const result = await mutate(() => connection.run(async (operator, signal) => readPaymentWindowAnswer(await operator.invoke(
          `payments.purchase.${action}`,
          { purchaseId: window.purchaseId, windowId: window.windowId, confirm: true },
          { signal, headers: { 'x-goodvibes-explicit-user-request': 'true' } },
        ))));
        const expected = window.kind === 'approval' ? (action === 'approve' ? 'approve' : 'deny') : (action === 'approve' ? 'acknowledge' : 'object');
        if (result.purchaseId !== window.purchaseId || result.windowId !== window.windowId || result.answer !== expected) throw new Error('Mismatched answer.');
        const said = { approve: 'Approved', deny: 'Denied', acknowledge: 'Proceeding with', object: 'Cancelled' }[result.answer];
        report(`[payments] ${said} purchase ${text(window.purchaseId)}.`);
        // Others may be waiting: return to the refreshed list, as stop and reconcile do.
        await refresh();
      } catch { fail('answer'); }
    };
    const supplyCode = async (request: PaymentSecurityCodeRequestView, code: string) => {
      try {
        loading('Handing the security code to the purchase — Escape closes this view');
        await authenticate();
        const result = await mutate(() => connection.run(async (operator, signal) => readPaymentSecurityCodeAcceptance(await operator.invoke(
          'payments.purchase.securityCode',
          { purchaseId: request.purchaseId, windowId: request.windowId, code, confirm: true },
          { signal, headers: { 'x-goodvibes-explicit-user-request': 'true' } },
        ))));
        if (result.purchaseId !== request.purchaseId || result.windowId !== request.windowId) throw new Error('Mismatched acknowledgement.');
        report('[payments] Security code accepted; the purchase continues. Watch /payments pending for its outcome.');
        finish();
      } catch {
        // Never echo the transport error: the request carried the code.
        report('[payments] Could not confirm the security code was accepted. Refresh /payments pending; if the request is still open, type the code again.');
        finish();
      }
    };
    const askCode = (request: PaymentSecurityCodeRequestView) => {
      const begin = context.beginConcealedInput;
      if (!begin) {
        report('[payments] Masked entry is unavailable on this surface, so the security code cannot be typed here. Use the terminal app or the local web UI.');
        finish();
        return;
      }
      // The chosen picker has closed, so the composer takes the masked line;
      // the plaintext reaches only this callback and is sent once.
      report(`[payments] Type the security code for the card ending ${text(request.cardLast4)} (${text(request.merchantDomain)}), then Enter. Escape cancels.`);
      begin.call(context, {
        label: 'Card security code',
        onSubmit: (value: string) => { void supplyCode(request, value); },
        onCancel: () => { report('[payments] No code sent. The purchase waits until its deadline; reopen /payments pending to type it.'); finish(); },
      });
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
        const result = await mutate(() => connection.run(async (operator, signal) => readPaymentOperationCancellation(await operator.invoke(
          'payments.purchase.cancel', { purchaseId: operation.purchaseId, operationId: operation.operationId, confirm: true },
          { signal, headers: { 'x-goodvibes-explicit-user-request': 'true' } },
        ))));
        if (result.purchaseId !== operation.purchaseId || result.operationId !== operation.operationId) throw new Error('Mismatched stop acknowledgement.');
        report(result.mayHaveSubmitted
          ? '[payments] Stop requested; submission may already have begun. Check purchase status and the merchant. This does not undo an order.'
          : '[payments] Stop requested. Check final purchase status before taking further action.');
        await refresh();
      } catch { fail('stop'); }
    };
    const reconcile = async (operation: PaymentOperationView, outcome: 'purchased' | 'not-purchased'): Promise<void> => {
      try {
        loading('Recording your merchant-history finding — Escape closes this view');
        await authenticate();
        const result = await mutate(() => connection.run(async (operator, signal) => readPaymentOperation(await operator.invoke(
          'payments.purchase.reconcile', { purchaseId: operation.purchaseId, operationId: operation.operationId,
            outcome, inspectedMerchantHistory: true, confirm: true },
          { signal, headers: { 'x-goodvibes-explicit-user-request': 'true' } },
        ))));
        if (result.purchaseId !== operation.purchaseId || result.operationId !== operation.operationId || result.outcome !== `owner-confirmed-${outcome}`) throw new Error('Mismatched reconciliation.');
        report(`[payments] ${paymentOperationDescription(result)}`);
        await refresh();
      } catch {
        report('[payments] Could not confirm completed reconciliation. Refresh /payments pending; if it shows your finding as saved, repeat that same finding. Do not submit another order.');
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
        const { windows, operations, unreadable, securityCodes } = await connection.run(async (operator, signal) => readPaymentWindowStatus(await operator.invoke('payments.purchase.status', {}, { signal })));
        if (windows.length === 0 && operations.length === 0 && unreadable.length === 0 && securityCodes.length === 0) { report('[payments] No purchase operations or windows on the selected host.'); finish(); return; }
        const byCodeId = new Map(securityCodes.map((request, index) => [`code-${index}`, request]));
        const byId = new Map(windows.map((window, index) => [`window-${index}`, window]));
        const byOperationId = new Map(operations.map((operation, index) => [`operation-${index}`, operation]));
        const items: SelectionItem[] = [...byCodeId].map(([id, request]) => ({ id, label: `Security code needed: ${text(request.purchaseId)}`,
          detail: `${text(request.merchantDomain)}, card ending ${text(request.cardLast4)}. The purchase is approved and waits for the code until ${new Date(request.deadlineMs).toLocaleString()}.` }));
        items.push(...[...byId].map(([id, window]) => ({ id, label: `${window.kind === 'approval' ? 'Approval' : 'Veto'}: ${text(window.purchaseId)}`, detail: detail(window) })));
        for (const [id, operation] of byOperationId) items.push({ id, label: `${operation.state}: ${text(operation.purchaseId)}`, detail: paymentOperationDescription(operation) });
        // Named so its evidence is inspected; there is nothing to answer or stop on it from here.
        for (const [index, row] of unreadable.entries()) items.push({ id: `unreadable-${index}`, label: `unreadable: ${text(row.purchaseId)}`, detail: text(row.reason) });
        items.push({ id: 'refresh', label: 'Refresh purchases', detail: 'Read current operations and windows from this same paired host.' });
        show('Purchases', items, result => {
          if (result.item.id === 'refresh') { void refresh(); return; }
          const codeRequest = byCodeId.get(result.item.id);
          if (codeRequest) { askCode(codeRequest); return; }
          const operation = byOperationId.get(result.item.id);
          if (operation) { chooseOperation(operation); return; }
          const window = byId.get(result.item.id);
          if (!window) { finish(); return; }
          choose(window);
        });
      } catch { fail('read'); }
    };
    await refresh();
  };
}

/** What `payments.checkout.approve` answered, or null when it is not that shape. */
function readAdvanceApproval(value: unknown): { merchantDomain: string; item: string; amount: string; expiresAt: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { approved, merchantDomain, item, amount, expiresAt } = record;
  if (approved !== true || typeof merchantDomain !== 'string' || typeof item !== 'string'
    || typeof amount !== 'string' || typeof expiresAt !== 'string') return null;
  return { merchantDomain, item, amount, expiresAt };
}

/** `/payments approve <merchant> <item> <maximum>`: the merchant is the first word, the maximum the last. */
export function parseAdvanceApprovalArgs(args: readonly string[]): { merchantDomain: string; item: string; amount: string } | null {
  const words = args.map(word => word.trim()).filter(Boolean);
  if (words.length < 3) return null;
  return { merchantDomain: words[0]!, item: words.slice(1, -1).join(' '), amount: words[words.length - 1]! };
}

/**
 * The owner approves one purchase in advance: merchant, item and the most it may
 * cost. Optional unless payments.confirmEveryPurchase is on; a matching purchase
 * then needs no answer up to that amount. The owner sees the three facts in a
 * picker and approves with one choice; the daemon reads the amount and refuses
 * one it cannot match before recording anything.
 */
export function createPaymentApproveCommand<Context extends PaymentWindowCommandContext>(policy: PaymentWindowCommandPolicy<Context>) {
  return async function approvePurchaseInAdvance(context: Context, args: readonly string[]): Promise<void> {
    if (!policy.isOwner(context)) {
      context.print('[payments] Type /payments approve <merchant> <item> <maximum> in the owner terminal to approve a purchase in advance.');
      return;
    }
    const requested = parseAdvanceApprovalArgs(args);
    if (!requested) {
      context.print('[payments] Usage: /payments approve <merchant> <item> <maximum>, for example /payments approve shop.example USB-C cable 25.00. Nothing was approved.');
      return;
    }
    const open = context.openSelection;
    if (!open) { context.print('[payments] Approving needs the picker, which this surface does not have. Use the terminal app or the web UI Purchases panel.'); return; }
    const ownerAbort = new AbortController();
    let connection: RetainedOperatorConnection;
    try {
      connection = new RetainedOperatorConnection({
        owner: () => policy.owner(context), home: () => policy.home(context),
        read: observation => policy.read(context, observation), files: policy.files,
        environment: policy.environment, fetchImpl: policy.fetchImpl, signal: ownerAbort.signal,
      });
    } catch (error) {
      context.print(`[payments] ${describeRetainedConnectionFailure(error, 'run /payments approve again')} Nothing was approved.`);
      return;
    }
    const finish = () => { ownerAbort.abort(); void connection.close(); };
    const report = (message: string) => { context.print(message); context.renderRequest(); };
    const summary = `Merchant: ${text(requested.merchantDomain)}\nItem: ${text(requested.item)}\nAt most: ${text(requested.amount)}\n\n`
      + 'A purchase matching these three, begun in the next five minutes, needs no further answer up to this amount. The approval is used once.';
    const approve = async () => {
      try {
        const auth = await connection.run((operator, signal) => operator.control.auth.current({}, { signal }));
        if (!isPairedOperatorPrincipal(auth, ['read:payments', 'write:payments'], connection.expectedPrincipalId)) {
          throw new Error('A current paired administrative payment owner is required.');
        }
        const result = readAdvanceApproval(await connection.run((operator, signal) => operator.invoke(
          'payments.checkout.approve', { ...requested, confirm: true },
          { signal, headers: { 'x-goodvibes-explicit-user-request': 'true' } },
        )));
        if (!result) throw new Error('Unexpected approval answer.');
        report(`[payments] Approved in advance: ${text(result.item)} from ${text(result.merchantDomain)}, at most ${text(result.amount)}, until ${new Date(result.expiresAt).toLocaleString()}.`);
      } catch (error) {
        // A refusal from the daemon names what was wrong (an amount it cannot read, a full approval list); a transport error is not echoed.
        const reason = error instanceof Error && /amount|approval|payments\./i.test(error.message) ? ` ${text(error.message)}` : '';
        report(`[payments] The approval was not confirmed.${reason} Check /payments pending and the paired owner credential, then try /payments approve again.`);
      } finally { finish(); }
    };
    try {
      open.call(context, 'Approve this purchase in advance?', [
        { id: 'approve', label: 'Approve this purchase', detail: summary },
        { id: 'back', label: 'Do not approve', detail: summary },
      ], { allowSearch: false, primaryVerbLabel: 'Choose', signal: connection.signal }, result => {
        if (result === null || result.action !== 'select' || result.item.id !== 'approve') {
          report('[payments] Nothing was approved.');
          finish();
          return;
        }
        void approve();
      });
    } catch {
      report('[payments] The picker could not open. Nothing was approved.');
      finish();
    }
  };
}
