// Proves: An agent places an order with ordinary browser actions (a merchant's saved payment method), around every spending limit.
// Red when: The browser click path stops asking whether a control places an order or loses its name, Enter or a submitting type in the order form is not treated as an order, or a key pressed on the order control itself is not refused.
// Proves: After the daemon typed the card into a real page, a snapshot, text read, extract or screenshot through the browser tool returns the number to the model.
// Red when: The browser engine's screenshot stops asking the card guard while the card is live on the page, so the typed number goes out as an image.
// Proves: A click that reached the merchant and then timed out is reported as never sent, so the hold is released and the record closed for an order that may exist.
// Red when: The payment flow's click, once dispatched to the page, ends in an error other than outcome-unknown when it does not finish.
/**
 * An order cannot be placed around the spending limits. A merchant's saved
 * payment method lets one click on "Place order" charge the card, so the
 * ordinary `browser` tool refuses any action that would take the order: a
 * click on a control whose label places one (a button, a scripted link),
 * Enter pressed in the order form, and text typed with submit.
 *
 * Real path: the settings manager with the owner's mode set to yolo, so the
 * gate admits every browser call and asks no one; the permission manager,
 * tool registry and tool-batch executor; the `browser` tool over the daemon's
 * own browser composition; a real headless Chromium. The merchant is a
 * loopback server that records every POST, so "no order was placed" is read
 * from what arrived. Jev answers through a fixture port that reads no page as
 * a sign-in page.
 *
 * The one arrangement outside the product: the suite has no network, so the
 * browser build the product downloads for itself (the driver's own Chrome for
 * Testing revision, `cli.js install chromium --no-shell`) is installed before
 * the run and linked into this file's browser cache, where the product finds it
 * as a user's machine has it after the first browser call. Never the machine's
 * own Chrome or Chromium: the driver is built for its revision, and a browser
 * of another version is not what a user runs.
 *
 * When the start fails, or the file is killed at its limit, its output holds
 * each step of the start and the browser's own lines (the driver's
 * `pw:browser` log), so the run's log says what was waited for.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { join, relative, sep } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { defaultBrowsersPath } from '../../platform/src/platform/browser/browser-provision-io.ts';
import { ConfigManager } from '../../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../../platform/src/platform/config/schema.ts';
import { composeDaemonBrowser, type BrowserCheckoutSeam, type DaemonBrowserGatewayService } from '../../platform/src/platform/control-plane/routes/browser-composition.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { HeldForOwnerLedger } from '../../platform/src/platform/permissions/held-for-owner.ts';
import { createPermissionConfigReader, PermissionManager } from '../../platform/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { markPaymentCheckoutAction, ORDER_SUBMIT_REFUSAL_FIX } from '../../platform/src/platform/security/order-submission.ts';
import { ToolRegistry } from '../../platform/src/platform/tools/registry.ts';
import type { ToolResult } from '../../platform/src/platform/types/tools.ts';
import { registerAgentBrowserTool } from '../../terminal-shell/src/agent-turn/browser-tool.ts';

const root = mkdtempSync(join(tmpdir(), 'gv-unbudgeted-path-'));
// Where the product's own browser build was installed before the run: the account's browser cache, unless named.
const installedBrowsers = process.env.GOODVIBES_TEST_BROWSERS_PATH?.trim() || defaultBrowsersPath(userInfo().homedir);
// The product's browser cache for this home; set before anything loads the driver.
process.env.PLAYWRIGHT_BROWSERS_PATH = join(root, 'browsers');
// The browser's own output, written as it happens, so a start that never ends still leaves it in the log.
process.env.DEBUG = 'pw:browser';

/** The checkout page: every control that takes the order POSTs to /order; the coupon control POSTs to /coupon. */
const CHECKOUT = `<!doctype html><title>Checkout</title><h1>Checkout</h1>
<form method="post" action="/order">
  <label for="note">Gift note</label> <input id="note" name="note">
  <label for="cc">Card number</label> <input id="cc" name="cardnumber" autocomplete="cc-number">
  <button type="submit">Place order</button>
</form>
<a href="#" onclick="fetch('/order', { method: 'POST', body: 'buy-now' }); return false;">Buy now</a>
<button type="button" onclick="fetch('/order', { method: 'POST', body: 'pay-now' })">Pay now</button>
<button type="button" onclick="fetch('/coupon', { method: 'POST', body: 'SAVE10' })">Apply coupon</button>
<button type="button" onclick="const held = new XMLHttpRequest(); held.open('POST', '/held-order', false); held.send('confirm');">Confirm and pay</button>`;

/** The merchant: serves the page and records every POST by path. */
function startMerchant() {
  const posts: { readonly path: string; readonly body: string }[] = [];
  const waiting = new Map<string, (() => void)[]>();
  let release: () => void = () => {};
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== 'POST') return new Response(CHECKOUT, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      posts.push({ path, body: await request.text() });
      for (const arrived of waiting.get(path)?.splice(0) ?? []) arrived();
      // This order's answer is held until the test lets it go, as a merchant that is slow to confirm.
      if (path === '/held-order') await new Promise<void>(resolve => { release = resolve; });
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
    /** Lets the held order's answer go. */
    release: () => release(),
    stop: () => server.stop(true),
  };
}

let merchant: ReturnType<typeof startMerchant> | undefined;
let browser: DaemonBrowserGatewayService | undefined;
let seam: BrowserCheckoutSeam | undefined;
let call: (args: Record<string, unknown>) => Promise<ToolResult>;
let ownerAsked = 0;
const previousPort = installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);

afterAll(async () => {
  await browser?.shutdown();
  merchant?.stop();
  installJudgmentPort(previousPort);
  rmSync(root, { recursive: true, force: true });
});

/**
 * The one browser the cases share, started before any case at module scope:
 * how long a real browser takes to start, and to open its first page, is not
 * what this file proves, so it counts against the file's limit and never
 * against a case's.
 */
async function startShopper(): Promise<void> {
  const homeDirectory = join(root, 'home');
  // The product's own browser build, linked where the product looks for it: <cache>/chromium-<revision>.
  const expected = (createRequire(import.meta.url)('playwright-core') as { chromium: { executablePath(): string } }).chromium.executablePath();
  const inCache = relative(join(root, 'browsers'), expected);
  const build = inCache.split(sep)[0]!;
  if (!existsSync(join(installedBrowsers, inCache))) {
    throw new Error(`This proof drives the browser build the product installs for itself (${build}), and it is not in ${installedBrowsers}. `
      + 'Install it with `bun packages/engine/node_modules/playwright-core/cli.js install chromium --no-shell`, or name the cache that holds it in GOODVIBES_TEST_BROWSERS_PATH.');
  }
  mkdirSync(join(root, 'browsers'), { recursive: true });
  symlinkSync(join(installedBrowsers, build), join(root, 'browsers', build));

  // The owner chose yolo: the gate admits every browser call and asks no one.
  const config = new ConfigManager({ surfaceRoot: 'goodvibes', workingDir: join(root, 'workspace'), homeDir: homeDirectory, configDir: join(root, 'config'), ownsDaemonTier: true });
  expect(config.setMany([{ key: 'permissions.mode' as ConfigKey, value: 'yolo' }], { kind: 'owner', surface: 'fixture' }).ok).toBe(true);
  const permissions = new PermissionManager(async () => { ownerAsked++; return { approved: false }; },
    createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, null, { heldForOwner: new HeldForOwnerLedger(), surfaceOf: () => undefined });
  const registry = new ToolRegistry(permissions);
  const composed = composeDaemonBrowser({ homeDirectory, onBrowserCheckout: checkout => { seam = checkout; } })!;
  browser = composed;
  registerAgentBrowserTool(registry, { browser: () => composed });
  // The model has loaded the browser tool's full parameters, as it does before its first call.
  registry.deferredCallRefusal('load', 'browser');
  const deps: ToolExecutionDeps = { permissionManager: permissions, toolRegistry: registry,
    autonomousSource: () => ({ goal: 'Buy the item in the cart', criteria: [] }),
    hookDispatcher: null, runtimeBus: null, sessionId: 'shopper', emitterContext: () => ({ sessionId: 'shopper', traceId: 'shopper', source: 'orchestrator' }) };
  let calls = 0;
  call = async args => (await executeToolCalls(deps, `turn-${String(++calls)}`, [{ id: `call-${String(calls)}`, name: 'browser', arguments: args }]))[0]!;

  const front = startMerchant();
  merchant = front;
  const started = performance.now();
  const step = (what: string): void => { console.error(`browser start, ${((performance.now() - started) / 1000).toFixed(1)} s: ${what}`); };
  step(`launching ${build} through the browser tool`);
  const launched = await call({ action: 'launch', headless: true });
  if (!launched.success) throw new Error(`The browser did not start: ${launched.error ?? 'no reason given'}`);
  step('launched; opening the checkout');
  const opened = await call({ action: 'navigate', url: front.url });
  if (!opened.success) throw new Error(`The browser did not open the checkout: ${opened.error ?? 'no reason given'}`);
  step('the checkout is open');
}

try { await startShopper(); }
catch (error) { await browser?.shutdown(); merchant?.stop(); throw error; }
const shop = merchant!;
const engine = browser!;

beforeEach(() => { shop.clear(); });

/** Opens the checkout fresh and returns the ref of each control by its name. */
async function openCheckout(): Promise<Map<string, string>> {
  expect((await call({ action: 'navigate', url: shop.url })).success).toBe(true);
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
  const coupon = shop.next('/coupon');
  expect((await call({ action: 'click', ref: refs.get('Apply coupon') })).success).toBe(true);
  await coupon;
  expect(shop.orders()).toEqual([]);
}

test.each(['Place order', 'Buy now'])(
  'a click on "%s" through the browser tool is refused although the gate admitted it, and no order reaches the merchant',
  async name => {
    const refs = await openCheckout();
    expect(refs.get(name)).toBeDefined();
    expectOrderRefusal(await call({ action: 'click', ref: refs.get(name) }));
    await expectNoOrderReachedTheMerchant(refs);
    expect(ownerAsked).toBe(0);
  },
);

test('Enter in the order form, text typed with submit and a key on the order control are refused, and no order reaches the merchant', async () => {
  const refs = await openCheckout();
  expectOrderRefusal(await call({ action: 'press', ref: refs.get('Gift note'), key: 'Enter' }));
  expectOrderRefusal(await call({ action: 'type', ref: refs.get('Gift note'), text: 'Happy birthday', submit: true }));
  expectOrderRefusal(await call({ action: 'type', ref: refs.get('Gift note'), text: 'Happy birthday\n', replace: false }));
  // A key on the order control itself: Enter on the scripted link, Space on a plain button.
  expectOrderRefusal(await call({ action: 'press', ref: refs.get('Buy now'), key: 'Enter' }));
  expectOrderRefusal(await call({ action: 'press', ref: refs.get('Pay now'), key: 'Space' }));
  await expectNoOrderReachedTheMerchant(refs);
  expect(ownerAsked).toBe(0);
});

test('once the daemon has typed the card into the page, a screenshot through the browser tool is refused', async () => {
  const pan = '4539578763621486';
  expect((await call({ action: 'navigate', url: shop.url })).success).toBe(true);
  const snapshot = await call({ action: 'snapshot' });
  const page = JSON.parse(snapshot.output!) as { sessionId: string; pageId: string; elements: { ref: string; name: string }[] };
  const card = page.elements.find(element => element.name === 'Card number')!.ref;
  // As the payment flow does it: arm the guard, then type through the checkout seam's driver.
  seam!.cardFieldGuard.arm(page.sessionId, page.pageId, [{ kind: 'number', value: pan }]);
  await seam!.driverFor(page.sessionId, page.pageId).fillSecrets([{ target: card, value: pan, kind: 'number' }], { assertCurrent: () => {} });

  // Text reads are scrubbed of the number on the way out; an image cannot be, so the capture itself is refused.
  const capture = await call({ action: 'screenshot' });
  expect(capture.success).toBe(false);
  expect(JSON.stringify(capture).replace(/\D/g, '')).not.toContain(pan);
});

test('a payment click the merchant received but never answered is reported as outcome unknown, not as never sent', async () => {
  expect((await call({ action: 'navigate', url: shop.url })).success).toBe(true);
  const page = JSON.parse((await call({ action: 'snapshot' })).output!) as { sessionId: string; pageId: string; elements: { ref: string; name: string }[] };
  const confirm = page.elements.find(element => element.name === 'Confirm and pay')!.ref;
  // The click as the payment flow makes it, with a one-second deadline.
  const owner = { assertCurrent: () => {} };
  markPaymentCheckoutAction(owner);
  const arrived = shop.next('/held-order');
  const clicked = engine.click({ sessionId: page.sessionId, pageId: page.pageId }, { ref: confirm, timeoutMs: 1_000 }, owner).then(() => null, (error: unknown) => error);
  await arrived;
  const failure = await clicked;
  shop.release();
  expect((failure as Error | null)?.name).toBe('BrowserClickOutcomeUnknownError');
});
