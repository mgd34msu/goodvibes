/**
 * An order cannot be placed around the spending limits. A merchant's saved
 * payment method lets one click on "Place order" charge the card, so the
 * ordinary `browser` tool refuses any action that would take the order: a
 * click on a control whose label places one (button, scripted role=button,
 * link), Enter pressed in the order form, and text typed with submit. Only the
 * payment flow's own submit, which runs under the owner's limits, presses it.
 *
 * Real path: the settings manager with the owner's mode set to yolo, so the
 * gate admits every browser call and asks no one; the permission manager,
 * tool registry and tool-batch executor; the `browser` tool over the daemon's
 * own browser composition; a real headless Chromium. The merchant is a
 * loopback server that records every POST, so "no order was placed" is read
 * from what arrived. Jev answers through a fixture port that reads no page as
 * a sign-in page.
 *
 * The one arrangement outside the product: the machine's installed Chromium is
 * linked where the product's browser cache expects its own build, so the
 * product finds a browser without downloading one (the suite has no network).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createBrowserProvisionIo } from '../platform/src/platform/browser/browser-provision-io.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { composeDaemonBrowser, type DaemonBrowserGatewayService } from '../platform/src/platform/control-plane/routes/browser-composition.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { HeldForOwnerLedger } from '../platform/src/platform/permissions/held-for-owner.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { markPaymentCheckoutAction, ORDER_SUBMIT_REFUSAL_FIX } from '../platform/src/platform/security/order-submission.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import type { ToolResult } from '../platform/src/platform/types/tools.ts';
import { registerAgentBrowserTool } from '../terminal-shell/src/agent-turn/browser-tool.ts';

const root = mkdtempSync(join(tmpdir(), 'gv-unbudgeted-path-'));
// The product's browser cache for this home; set before anything loads the driver.
process.env.PLAYWRIGHT_BROWSERS_PATH = join(root, 'browsers');

/** The checkout page: every control that takes the order POSTs to /order; the coupon control POSTs to /coupon. */
const CHECKOUT = `<!doctype html><title>Checkout</title><h1>Checkout</h1>
<form method="post" action="/order">
  <label for="note">Gift note</label> <input id="note" name="note">
  <button type="submit">Place order</button>
</form>
<div role="button" tabindex="0" onclick="fetch('/order', { method: 'POST', body: 'pay-now' })">Pay now</div>
<a href="#" onclick="fetch('/order', { method: 'POST', body: 'buy-now' }); return false;">Buy now</a>
<button type="button" onclick="fetch('/order', { method: 'POST', body: 'bestellen' })">Zahlungspflichtig bestellen</button>
<button type="button" onclick="fetch('/coupon', { method: 'POST', body: 'SAVE10' })">Apply coupon</button>`;

/** The merchant: serves the page and records every POST by path. */
function startMerchant() {
  const posts: { readonly path: string; readonly body: string }[] = [];
  const waiting = new Map<string, (() => void)[]>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== 'POST') return new Response(CHECKOUT, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      posts.push({ path, body: await request.text() });
      for (const arrived of waiting.get(path)?.splice(0) ?? []) arrived();
      return new Response('<!doctype html><title>Thank you</title><p>Received.</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}/`,
    orders: () => posts.filter(post => post.path === '/order'),
    /** Forgets what arrived, so each case reads only its own. */
    clear: () => { posts.length = 0; },
    /** Resolves when the next POST to `path` arrives. */
    next: (path: string) => new Promise<void>(resolve => { waiting.set(path, [...(waiting.get(path) ?? []), resolve]); }),
    stop: () => server.stop(true),
  };
}

let merchant: ReturnType<typeof startMerchant>;
let browser: DaemonBrowserGatewayService;
let call: (args: Record<string, unknown>) => Promise<ToolResult>;
let ownerAsked = 0;
let previousPort: ReturnType<typeof installJudgmentPort>;

beforeAll(async () => {
  previousPort = installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
  const homeDirectory = join(root, 'home');
  // Where the product looks for its own browser build: the installed Chromium stands in for it.
  const installed = createBrowserProvisionIo({ homeDirectory, surfaceRoot: 'goodvibes' }).systemBrowserCandidates()[0];
  if (installed === undefined) throw new Error('This proof needs Chrome or Chromium installed on the machine.');
  const expected = (createRequire(import.meta.url)('playwright-core') as { chromium: { executablePath(): string } }).chromium.executablePath();
  mkdirSync(dirname(expected), { recursive: true });
  symlinkSync(installed, expected);

  // The owner chose yolo: the gate admits every browser call and asks no one.
  const config = new ConfigManager({ surfaceRoot: 'goodvibes', workingDir: join(root, 'workspace'), homeDir: homeDirectory, configDir: join(root, 'config'), ownsDaemonTier: true });
  expect(config.setMany([{ key: 'permissions.mode' as ConfigKey, value: 'yolo' }], { kind: 'owner', surface: 'fixture' }).ok).toBe(true);
  const permissions = new PermissionManager(async () => { ownerAsked++; return { approved: false }; },
    createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, null, { heldForOwner: new HeldForOwnerLedger(), surfaceOf: () => undefined });
  const registry = new ToolRegistry(permissions);
  browser = composeDaemonBrowser({ homeDirectory })!;
  registerAgentBrowserTool(registry, { browser: () => browser });
  // The model has loaded the browser tool's full parameters, as it does before its first call.
  registry.deferredCallRefusal('load', 'browser');
  const deps: ToolExecutionDeps = { permissionManager: permissions, toolRegistry: registry,
    autonomousSource: () => ({ goal: 'Buy the item in the cart', criteria: [] }),
    hookDispatcher: null, runtimeBus: null, sessionId: 'shopper', emitterContext: () => ({ sessionId: 'shopper', traceId: 'shopper', source: 'orchestrator' }) };
  let calls = 0;
  call = async args => (await executeToolCalls(deps, `turn-${String(++calls)}`, [{ id: `call-${String(calls)}`, name: 'browser', arguments: args }]))[0]!;

  merchant = startMerchant();
  expect((await call({ action: 'launch', headless: true })).success).toBe(true);
});

beforeEach(() => { merchant.clear(); });

afterAll(async () => {
  await browser?.shutdown();
  merchant?.stop();
  installJudgmentPort(previousPort);
  rmSync(root, { recursive: true, force: true });
});

/** Opens the checkout fresh and returns the ref of each control by its name. */
async function openCheckout(): Promise<Map<string, string>> {
  expect((await call({ action: 'navigate', url: merchant.url })).success).toBe(true);
  const snapshot = await call({ action: 'snapshot' });
  expect(snapshot.error).toBeUndefined();
  const elements = (JSON.parse(snapshot.output!) as { elements: { ref: string; name: string }[] }).elements;
  return new Map(elements.map(element => [element.name, element.ref]));
}

/** Refused as an order, with the budgeted path named as the way forward. */
function expectOrderRefusal(result: ToolResult): void {
  expect(result.success).toBe(false);
  expect(result.error).toContain(ORDER_SUBMIT_REFUSAL_FIX);
}

/** A later action on the same page reaches the merchant; by then no order has arrived. */
async function expectNoOrderReachedTheMerchant(refs: Map<string, string>): Promise<void> {
  const coupon = merchant.next('/coupon');
  expect((await call({ action: 'click', ref: refs.get('Apply coupon') })).success).toBe(true);
  await coupon;
  expect(merchant.orders()).toEqual([]);
}

test.each(['Place order', 'Pay now', 'Buy now', 'Zahlungspflichtig bestellen'])(
  'a click on "%s" through the browser tool is refused although the gate admitted it, and no order reaches the merchant',
  async name => {
    const refs = await openCheckout();
    expect(refs.get(name)).toBeDefined();
    expectOrderRefusal(await call({ action: 'click', ref: refs.get(name) }));
    await expectNoOrderReachedTheMerchant(refs);
    expect(ownerAsked).toBe(0);
  },
);

test('Enter in the order form and text typed with submit are refused, and no order reaches the merchant', async () => {
  const refs = await openCheckout();
  expectOrderRefusal(await call({ action: 'press', ref: refs.get('Gift note'), key: 'Enter' }));
  expectOrderRefusal(await call({ action: 'type', ref: refs.get('Gift note'), text: 'Happy birthday', submit: true }));
  expectOrderRefusal(await call({ action: 'type', ref: refs.get('Gift note'), text: 'Happy birthday\n', replace: false }));
  await expectNoOrderReachedTheMerchant(refs);
  expect(ownerAsked).toBe(0);
});

test('the payment flow\'s own submit is the one path that places the order', async () => {
  const refs = await openCheckout();
  const ordered = merchant.next('/order');
  const ownership = { assertCurrent: () => {} };
  markPaymentCheckoutAction(ownership);
  await browser.click({}, { ref: refs.get('Pay now')! }, ownership);
  await ordered;
  expect(merchant.orders()).toEqual([{ path: '/order', body: 'pay-now' }]);
});
