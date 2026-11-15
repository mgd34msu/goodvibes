import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { createTerminalCommandRegistry } from '../terminal-shell/src/command-registry.js';
import { SelectionModal, type OpenSelection } from '../terminal-shell/src/selection-modal.js';
import { attachSelectionModalQueue, type SelectionModalCallback } from '../terminal-shell/src/selection-modal-queue.js';
import { handleSelectionModalToken } from '../terminal-shell/src/modal-input-routes.js';
import { createPaymentWindowCommand } from '../terminal-shell/src/payment-window-command.js';
import { createPaymentCardCommands } from '../terminal-shell/src/card-field-prompts.js';
import { RetainedOperatorConnection } from '../terminal-shell/src/retained-operator-connection.js';
import type { PaymentWindowView } from '../platform/src/platform/payments/window-view.js';
import type { PaymentOperationView } from '../platform/src/platform/payments/operation-view.js';

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
  let holdMutation: Promise<void> | undefined;
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
    if (!url.pathname.endsWith('/status')) await holdMutation;
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
    holdAuth: (wait: Promise<void>) => { holdAuth = wait; }, holdMutation: (wait: Promise<void>) => { holdMutation = wait; } };
}

const running: PaymentOperationView = { purchaseId: 'detached', operationId: 'original-operation', state: 'running', phase: 'submit-pending',
  createdAtMs: 1, updatedAtMs: 2, totalMinorUnits: 100, currency: 'USD', outcome: null };

test('closing the view while an answer is on the wire says the request may have been sent', async () => {
  const f = fixture(); const gate = barrier(); f.holdMutation(gate.wait);
  await f.open(); f.choose('window-0'); f.choose('approve');
  await until(() => f.requests.some(request => request.headers.has('x-goodvibes-explicit-user-request')));
  f.ui.handleEscape();
  expect(f.messages.join('\n')).toContain('may already have reached the host');
  expect(f.messages.join('\n')).toContain('/payments pending');
  gate.release();
});

test('closing the view before anything is sent adds no such warning', async () => {
  const f = fixture(); await f.open(); f.choose('window-0');
  f.ui.handleEscape();
  expect(f.messages.join('\n')).not.toContain('may already have reached the host');
});

test('a failed stop names the stop, not a purchase-window answer', async () => {
  const f = fixture({ operation: running, answerStatus: 500 }); await f.open(); f.choose('operation-0'); f.choose('stop');
  await until(() => f.messages.some(message => message.includes('checkout stop')));
  expect(f.messages.join('\n')).not.toContain('purchase-window answer');
});
