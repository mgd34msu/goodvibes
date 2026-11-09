import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { createTerminalCommandRegistry } from '../terminal-shell/src/command-registry.js';
import { SelectionModal, type OpenSelection } from '../terminal-shell/src/selection-modal.js';
import { attachSelectionModalQueue, type SelectionModalCallback } from '../terminal-shell/src/selection-modal-queue.js';
import { handleSelectionModalToken } from '../terminal-shell/src/modal-input-routes.js';
import { createPaymentWindowCommand } from '../terminal-shell/src/payment-window-command.js';
import { createPaymentCardCommands } from '../terminal-shell/src/card-field-prompts.js';
import { RetainedOperatorConnection } from '../terminal-shell/src/retained-operator-connection.js';
import type { PaymentWindowView } from '../sdk/src/platform/payments/window-view.js';
import type { PaymentOperationView } from '../sdk/src/platform/payments/operation-view.js';

const roots: string[] = [];
const exits: (() => void)[] = [];
afterEach(() => {
  for (const exit of exits.splice(0)) exit();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const window: PaymentWindowView = { purchaseId: 'purchase-A', windowId: 'window-A', kind: 'approval',
  notice: 'Approval needed: the full total exceeds your requested maximum.\nMerchant: example.com\nItem: the requested item\nTotal: USD 20.00\nRequested maximum: USD 15.00', deadlineMs: Date.now() + 60_000 };
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 0)); }
  throw new Error('The expected payment UI state did not appear.');
}
function barrier() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }

function fixture(options: { readonly window?: PaymentWindowView; readonly principal?: string; readonly answerStatus?: number; readonly operation?: PaymentOperationView } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'terminal-purchases-')); roots.push(root);
  const credentialFile = join(root, 'paired.json'); writeFileSync(credentialFile, 'private credential source');
  const manager = new ConfigManager({ surfaceRoot: 'tui', configDir: root, workingDir: root, homeDir: root });
  let baseUrl = 'https://host-one.invalid', token = 'fixture-operator-bearer', environment = 'first';
  const requests: { url: URL; headers: Headers; body: unknown; signal: AbortSignal | undefined | null }[] = [];
  let holdAuth: Promise<void> | undefined;
  let principal = options.principal ?? 'pairing:owner';
  const view = options.window ?? window;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, headers, body, signal: init?.signal });
    if (url.pathname === '/api/control-plane/auth') {
      await holdAuth;
      return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true,
        sessionCookiePresent: false, principalId: principal, principalKind: 'token', admin: true, scopes: ['read:payments', 'write:payments'], roles: [] });
    }
    if (url.pathname.endsWith('/status')) return Response.json({ windows: options.operation ? [] : [view], operations: options.operation ? [options.operation] : [] });
    if (options.answerStatus) return Response.json({ error: 'private transport diagnostic' }, { status: options.answerStatus });
    if (url.pathname.endsWith('/reconcile') && options.operation && body && typeof body === 'object' && 'outcome' in body) {
      return Response.json({ ...options.operation, state: 'completed', outcome: `owner-confirmed-${String(body.outcome)}` });
    }
    if (options.operation) return Response.json({ purchaseId: options.operation.purchaseId, operationId: options.operation.operationId, accepted: true, mayHaveSubmitted: true });
    const action = url.pathname.split('/').at(-1);
    return Response.json({ purchaseId: view.purchaseId, windowId: view.windowId, accepted: true,
      answer: view.kind === 'approval' ? (action === 'approve' ? 'approve' : 'deny') : (action === 'approve' ? 'acknowledge' : 'object') });
  }) as typeof fetch;
  const modal = new SelectionModal();
  const ui = { selectionModal: modal, selectionCallback: null as SelectionModalCallback | null, syncFeedSelectionCallback: null,
    modalStack: [] as string[], modalOpened(name: string) { this.modalStack.push(name); }, requestRender() {}, exitApp() {},
    handleEscape() { const callback = this.selectionCallback; this.selectionCallback = null; modal.close(); this.modalStack.pop(); callback?.(null); } };
  const queue = attachSelectionModalQueue(ui); exits.push(() => ui.exitApp());
  const messages: string[] = [];
  const context = { invokedByModel: false, print: (text: string) => messages.push(text), renderRequest() {},
    openSelection: ((title, items, opts, callback) => queue.request({ title, items, opts, callback })) as OpenSelection };
  const commands = createTerminalCommandRegistry<typeof context>(); const registry = new commands.CommandRegistry();
  const pending = createPaymentWindowCommand<typeof context>({
    isOwner: ctx => commands.isDirectOwnerCommandContext(ctx, 'payments'), owner: () => manager, home: () => root,
    read(_ctx, observation) { return { baseUrl, token, identity: observation.observe([baseUrl, token], manager), expectedPrincipalId: 'pairing:owner' }; },
    files: () => [credentialFile], environment: () => [environment], fetchImpl,
  });
  createPaymentCardCommands<typeof context>({ surface: 'tui', announcement: '', promptFields() {}, status: () => ['local card status'],
    pending, description: 'Payments', usage: '/payments pending', argsHint: 'pending' }).registerPaymentCardCommands(registry);
  const choose = (id: string) => {
    const index = modal.filteredItems.findIndex(item => item.id === id);
    expect(index).toBeGreaterThanOrEqual(0); modal.selectedIndex = index;
    handleSelectionModalToken(ui, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false });
  };
  return { root, manager, credentialFile, context, registry, messages, ui, modal, requests, choose,
    open: () => registry.executeFromOwner('payments', ['pending'], context),
    setHost: () => { baseUrl = 'https://host-two.invalid'; token = 'second-fixture-bearer'; },
    setEnvironment: () => { environment = 'second'; },
    setPrincipal: (value: string) => { principal = value; },
    holdAuth: (wait: Promise<void>) => { holdAuth = wait; } };
}

test('only a direct owner command opens the actual payment picker', async () => {
  const f = fixture();
  await f.registry.execute('payments', ['pending'], f.context);
  expect(f.requests).toHaveLength(0); expect(f.modal.active).toBe(false);
  await f.open();
  expect(f.modal.title, f.messages.join('\n')).toBe('Purchases');
  expect(f.modal.items[0]?.detail).toContain(window.notice);
  expect(f.requests.every(request => !request.headers.has('x-goodvibes-explicit-user-request'))).toBe(true);
});

test('the shared terminal requires merchant-history confirmation before reconciling an uncertain original checkout', async () => {
  const operation: PaymentOperationView = { purchaseId: 'uncertain-checkout', operationId: 'original-operation', state: 'uncertain', phase: 'submit-pending',
    createdAtMs: 1, updatedAtMs: 2, outcome: null, totalMinorUnits: 2000, currency: 'USD' };
  const f = fixture({ operation }); await f.open(); f.choose('operation-0');
  f.choose('not-purchased');
  expect(f.requests.some(request => request.url.pathname.endsWith('/reconcile'))).toBe(false);
  expect(f.modal.filteredItems.some(item => item.detail?.includes('never places another order'))).toBe(true);
  f.choose('confirm');
  await until(() => f.messages.some(message => message.includes('You confirmed no order was placed')));
  const sent = f.requests.filter(request => request.url.pathname.endsWith('/reconcile'));
  expect(sent).toHaveLength(1);
  expect(sent[0]?.body).toEqual({ purchaseId: operation.purchaseId, operationId: operation.operationId, outcome: 'not-purchased', inspectedMerchantHistory: true, confirm: true });
  expect(sent[0]?.headers.get('x-goodvibes-explicit-user-request')).toBe('true');
  expect(f.requests.some(request => request.url.pathname.includes('/checkout/'))).toBe(false);
});

test('operation status and stop are available through the actual shared terminal picker after a window disappears', async () => {
  const operation: PaymentOperationView = { purchaseId: 'detached', operationId: 'original-operation', state: 'running', phase: 'submit-pending',
    createdAtMs: 1, updatedAtMs: 2, totalMinorUnits: 100, currency: 'USD', outcome: null };
  const f = fixture({ operation }); await f.open(); f.choose('operation-0');
  expect(f.modal.items.map(item => item.id)).toEqual(['refresh', 'stop']);
  f.choose('stop'); await until(() => f.messages.some(message => message.includes('Stop requested;')));
  const stops = f.requests.filter(request => request.url.pathname.endsWith('/cancel'));
  expect(stops).toHaveLength(1);
  expect(stops[0]?.body).toEqual({ purchaseId: operation.purchaseId, operationId: operation.operationId, confirm: true });
  expect(stops[0]?.headers.get('x-goodvibes-explicit-user-request')).toBe('true');
  expect(f.messages.join(' ')).toContain('does not undo an order');
  f.ui.handleEscape();
});

test.each([
  ['invalid-requested-maximum', 'requested maximum is invalid'],
  ['requested-maximum-exceeded-denied', 'requested maximum was denied'],
  ['requested-maximum-exceeded-expired', 'requested maximum expired'],
  ['requested-maximum-exceeded-undeliverable', 'approval notice could not be delivered'],
] as const)('terminal purchase status explains %s without exposing only its internal code', async (code, explanation) => {
  const operation: PaymentOperationView = { purchaseId: 'refused-maximum', operationId: 'original-operation', state: 'refused', phase: null,
    createdAtMs: 1, updatedAtMs: 2, totalMinorUnits: null, currency: null, outcome: `refused:${code}` };
  const f = fixture({ operation }); await f.open();
  expect(f.modal.items[0]?.detail).toContain(explanation);
  expect(f.modal.items[0]?.detail).not.toContain(code);
});

test.each(['approve', 'deny'] as const)('the selected %s is bound to the displayed notice and sent exactly once', async action => {
  const f = fixture(); await f.open(); f.choose('window-0');
  expect(f.modal.items.every(item => item.detail?.includes(window.notice))).toBe(true);
  const old = f.ui.selectionCallback;
  f.choose(action);
  old?.({ item: { id: action, label: 'Old callback' }, action: 'select' });
  await until(() => !f.modal.active);
  const mutations = f.requests.filter(request => request.headers.has('x-goodvibes-explicit-user-request'));
  expect(mutations).toHaveLength(1);
  expect(mutations[0]?.body).toEqual({ purchaseId: window.purchaseId, windowId: window.windowId, confirm: true });
  expect(mutations[0]?.url.origin).toBe('https://host-one.invalid');
  expect(f.messages).toContain('[payments] Purchase-window answer accepted.');
  expect(f.messages.join(' ')).not.toContain('fixture-operator-bearer');
});

test('veto cancellation uses the cancel verb; Escape merely closes the local view', async () => {
  const f = fixture({ window: { ...window, kind: 'veto' } }); await f.open(); f.choose('window-0');
  expect(f.modal.items.map(item => item.id)).toEqual(['approve', 'cancel']);
  f.ui.handleEscape();
  expect(f.requests.filter(request => request.headers.has('x-goodvibes-explicit-user-request'))).toHaveLength(0);
  await f.open(); f.choose('window-0'); f.choose('cancel'); await until(() => !f.modal.active);
  expect(f.requests.filter(request => request.url.pathname.endsWith('/cancel'))).toHaveLength(1);
});

test.each(['host', 'environment', 'credential-restoration', 'configuration'] as const)('%s changes retire an old choice without retargeting it', async change => {
  const f = fixture(); await f.open(); f.choose('window-0'); const old = f.ui.selectionCallback;
  if (change === 'host') f.setHost();
  if (change === 'environment') f.setEnvironment();
  if (change === 'credential-restoration') { const original = readFileSync(f.credentialFile); writeFileSync(f.credentialFile, 'replacement'); writeFileSync(f.credentialFile, original); }
  if (change === 'configuration') f.manager.setDynamic('display.stream', false);
  if (f.modal.active) f.choose('approve');
  old?.({ item: { id: 'approve', label: 'Stale' }, action: 'select' });
  await until(() => !f.modal.active);
  expect(f.requests.filter(request => request.headers.has('x-goodvibes-explicit-user-request'))).toHaveLength(0);
  expect(f.requests.every(request => request.url.origin === 'https://host-one.invalid')).toBe(true);
});

test('a changed live principal cannot consume the saved window, and server conflicts are not retried', async () => {
  const changed = fixture(); await changed.open(); changed.choose('window-0'); changed.setPrincipal('pairing:other'); changed.choose('approve');
  await until(() => !changed.modal.active);
  expect(changed.requests.filter(request => request.headers.has('x-goodvibes-explicit-user-request'))).toHaveLength(0);
  const stale = fixture({ answerStatus: 409 }); await stale.open(); stale.choose('window-0'); stale.choose('approve');
  await until(() => !stale.modal.active);
  expect(stale.requests.filter(request => request.headers.has('x-goodvibes-explicit-user-request'))).toHaveLength(1);
  expect(stale.messages.join(' ')).not.toContain('private transport diagnostic');
  expect(stale.messages).not.toContain('[payments] Purchase-window answer accepted.');
});

test('terminal exit cancels an accepted read even when its transport ignores the signal', async () => {
  const f = fixture(); const gate = barrier(); f.holdAuth(gate.wait);
  const opening = f.open(); await until(() => f.requests.length === 1);
  f.ui.exitApp(); expect(f.requests[0]?.signal?.aborted).toBe(true);
  gate.release(); await opening;
  expect(f.modal.active).toBe(false);
  expect(f.requests).toHaveLength(1);
  expect(f.messages).toHaveLength(0);
});

test('shared bootstrap credentials cannot open payment approval controls', async () => {
  const f = fixture({ principal: 'shared-token' }); await f.open();
  expect(f.modal.active).toBe(false);
  expect(f.requests).toHaveLength(1);
  expect(f.messages.join(' ')).toContain('pairing');
});

test('connection shutdown drains a borrowed transport instead of declaring an abandoned request settled', async () => {
  const f = fixture(); const entered = barrier(), gate = barrier(), cancelling = barrier(), cancelled = barrier();
  const connection = new RetainedOperatorConnection({ owner: () => f.manager, home: () => f.root,
    read: observation => ({ baseUrl: 'https://retained.invalid', token: 'private-fixture', identity: observation.observe(['original'], f.manager) }),
    files: () => [f.credentialFile], signal: new AbortController().signal,
    fetchImpl: async () => {
      entered.release(); await gate.wait;
      return new Response(new ReadableStream({ cancel() { cancelling.release(); return cancelled.wait; } }));
    } });
  const reading = connection.run((operator, signal) => operator.control.auth.current({}, { signal }));
  void reading.catch(() => {});
  await entered.wait;
  let closed = false;
  const close = connection.close().then(() => { closed = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(connection.signal.aborted).toBe(true); expect(closed).toBe(false);
  gate.release();
  await cancelling.wait; expect(closed).toBe(false);
  cancelled.release();
  await expect(reading).rejects.toThrow(); await close;
  expect(closed).toBe(true);
});
