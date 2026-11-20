/**
 * Journey 5: purchases inside and over the limits.
 *
 * No real money and no real card: the card is the test number 4111 1111 1111
 * 1111 and the merchant is an HTTPS page this script serves on 127.0.0.1 with a
 * self-signed certificate. The product only buys on https, on the standard
 * port, from a named host, and the agent's browser opens only a host whose
 * name resolves and whose address passes the destination rule, so the
 * merchant is shop.rt-merchant.localhost (every *.localhost name resolves to
 * loopback) and the owner names it in fetch.allowedPrivateHosts, as an owner
 * lets the agent reach a machine of their own. The browser is pointed at the
 * merchant's port by its flags (`--host-resolver-rules` maps the name to the
 * loopback port and every other name to nothing, `--ignore-certificate-errors`
 * accepts the self-signed certificate). No product check is relaxed.
 *
 * The browser is one the owner started with a loopback remote-debugging port
 * and the agent attached to, the kind of browser a purchase can outlive a
 * daemon crash in (a browser the daemon launched itself ends with it).
 *
 * The decision model is the scripted one on loopback (fake-decision.ts) under
 * Hybrid; every decision it was asked is written beside the results.
 *
 * Each purchase is made as the product makes it: a turn of a daemon-hosted
 * Agent session (the model is scripted) attaches the browser tool, opens the
 * checkout in a new tab, reads its element refs with a snapshot, and calls
 * payments.checkout.begin through agent_operator_method with that page.
 *
 *  - limits at 0: the purchase asks the owner and offers to set the limit;
 *  - that purchase, waiting on the owner, survives a daemon crash and an ordinary restart;
 *  - inside the limits: completes without asking, submits once to the merchant;
 *  - over a limit: stops, naming the limit and by how much;
 *  - a total that changed at checkout: not submitted;
 *  - the decision model answers what nobody can read: nothing is bought and
 *    the owner is told;
 *  - with no decision model (judgment.policy No Decision Model) a purchase
 *    inside the limits asks the owner, saying what could not be checked
 *    (that it is not a subscription), and nothing is submitted unasked.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_ENTRY, Journey, api, approvePending, freePort, invoke, nativeTurnStatus, operatorToken, runProduct, sendNativeHostedTurn, short, stage, waitFor } from './lib.ts';
import { textOf, type ChatMessage } from './fake-model.ts';
import { answerAsAModelWould, startFakeDecision } from './fake-decision.ts';

const journey = new Journey('j5-purchases');
const MERCHANT_HOST = 'shop.rt-merchant.localhost';
const submissions: Array<{ path: string; body: string }> = [];
const decision = startFakeDecision();
// The scripted decision model answers as a model would (fake-decision.ts): the cart line is the item asked for and
// the page is unchanged after the card is typed; no recurring charge, no lookalike link, the merchant a retailer.
answerAsAModelWould(decision);
const s = await stage('j5', { judgment: { endpoint: decision.url, policy: 'Hybrid' } });
s.home.allow(decision.port);
const tlsDir = join(s.home.root, 'tls');
mkdirSync(tlsDir, { recursive: true });
const madeCert = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tlsDir, 'key.pem'), '-out', join(tlsDir, 'cert.pem'),
  '-days', '2', '-subj', `/CN=${MERCHANT_HOST}`, '-addext', `subjectAltName=DNS:${MERCHANT_HOST}`], { stdout: 'pipe', stderr: 'pipe' });
const merchant = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  tls: { cert: Bun.file(join(tlsDir, 'cert.pem')), key: Bun.file(join(tlsDir, 'key.pem')) },
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST') {
      submissions.push({ path: url.pathname, body: await request.text() });
      return new Response('<html><body><h1>Thank you</h1><p>Order RT-1001 placed.</p></body></html>', { headers: { 'content-type': 'text/html' } });
    }
    const price = url.searchParams.get('price') ?? '5.00';
    const total = url.searchParams.get('total') ?? price;
    return new Response(`<html><head><title>RT Merchant checkout</title></head><body><h1>Checkout</h1>
<table><tr><th>Item</th><th>Qty</th><th>Price</th></tr><tr><td>Test widget</td><td>1</td><td>$${price}</td></tr></table>
<p>Shipping: Standard $0.00</p><p>Total: $${total}</p>
<form method="post" action="/place-order"><label>Name on card <input autocomplete="cc-name" name="name"></label>
<label>Card number <input autocomplete="cc-number" name="number"></label><label>Expiry <input autocomplete="cc-exp" name="exp"></label>
<label>CVC <input autocomplete="cc-csc" name="csc"></label><button type="submit">Place order</button></form></body></html>`, { headers: { 'content-type': 'text/html' } });
  },
});
s.home.allow(merchant.port!);
const resolverRules = `MAP ${MERCHANT_HOST} 127.0.0.1:${merchant.port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`;
// A browser the daemon launches reads its launcher flags from the isolated XDG config home.
writeFileSync(join(s.home.home, '.config', 'chromium-flags.conf'), `--host-resolver-rules="${resolverRules}"\n--ignore-certificate-errors\n`);
// The owner's browser: started here, debugging port on loopback, its own profile in the scratch folder.
const debugPort = freePort();
s.home.allow(debugPort);
const ownerBrowser = Bun.spawn(['/usr/bin/chromium', '--headless=new', `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${join(s.home.root, 'owner-browser')}`, `--host-resolver-rules=${resolverRules}`, '--ignore-certificate-errors', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-sandbox', 'about:blank'], {
  env: { HOME: s.home.home, XDG_CONFIG_HOME: join(s.home.home, '.config'), PATH: process.env.PATH ?? '/usr/bin' }, stdout: 'ignore', stderr: 'ignore',
});
const cdpEndpoint = `http://127.0.0.1:${debugPort}`;

const daemonSet = (key: string, value: string) => runProduct(s.home, DAEMON_ENTRY, ['config', 'set', key, value]);
const lastCall = (messages: readonly ChatMessage[]) => [...messages].reverse().find((message) => message.role === 'assistant' && message.tool_calls?.length)?.tool_calls?.[0];

try {
  const browserUp = await waitFor(async () => (await fetch(`${cdpEndpoint}/json/version`).then((response) => response.ok, () => false)) ? true : undefined, 15_000, 250);
  journey.check('a loopback HTTPS merchant and the owner\'s browser are ready', 'openssl self-signed certificate for shop.rt-merchant.localhost; Bun TLS server on 127.0.0.1; chromium with a loopback debugging port',
    `openssl exit ${madeCert.exitCode}; merchant port ${merchant.port}; browser pid ${ownerBrowser.pid} on ${cdpEndpoint} ${browserUp === true}`,
    madeCert.exitCode === 0 && typeof merchant.port === 'number' && browserUp === true);
  const settings: Array<[string, string]> = [
    ['payments.enabled', 'true'], ['payments.currency', 'USD'], ['fetch.allowedPrivateHosts', MERCHANT_HOST],
    ...(['shippingAddress', 'billingAddress'] as const).flatMap((kind): Array<[string, string]> => [
      [`payments.${kind}.name`, 'Run Through'], [`payments.${kind}.line1`, '1 Loopback Way'], [`payments.${kind}.city`, 'Localhost'],
      [`payments.${kind}.region`, 'CA'], [`payments.${kind}.postalCode`, '"94000"'], [`payments.${kind}.country`, 'US']]),
  ];
  const written = [];
  for (const [key, value] of settings) written.push(await daemonSet(key, value));
  await s.restartDaemon();
  let owner = operatorToken(s.home);
  journey.check('the owner turns payments on and sets the delivery address', 'goodvibes-daemon config set payments.enabled, currency, shipping and billing address; restart',
    written.filter((run) => run.code !== 0).map((run) => short(run.stdout + run.stderr, 120)).join(' | ') || 'all written', written.every((run) => run.code === 0));

  const budget = await api(s.daemon, owner, 'GET', '/api/payments/budget');
  const item = (budget.body as { item?: { limit?: number } }).item;
  journey.check('with default limits (0) every purchase needs the owner', 'GET /api/payments/budget', `${budget.status} ${short(budget.text, 220)}`,
    budget.status === 200 && item?.limit === 0);
  const card = await api(s.daemon, owner, 'POST', '/api/payments/cards', { label: 'run-through test card', number: '4111111111111111', expiryMonth: 12, expiryYear: 2030, cvv: '123', cardholderName: 'Run Through', kind: 'virtual' });
  const cardId = (card.body as { card?: { id?: string }; id?: string }).card?.id ?? (card.body as { id?: string }).id ?? '';
  journey.check('a test card is stored in the secret store, not returned', 'POST /api/payments/cards (test number)', `${card.status} ${short(card.text, 200)}`,
    card.status < 300 && cardId.length > 0 && !card.text.includes('4111111111111111'));
  await s.registerWorkspace();

  /** One purchase, made as the Agent makes it in a hosted session. */
  const purchase = async (requestId: string, price: string, statedTotal: string, pageTotal = statedTotal): Promise<{ begin: string; state: Record<string, unknown> | undefined }> => {
    const marker = `RTJ5${requestId.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;
    const url = `https://${MERCHANT_HOST}/checkout?price=${price}&total=${pageTotal}`;
    s.model.script(marker, (step, messages) => {
      const tools = messages.filter((message) => message.role === 'tool').map((message) => textOf(message.content));
      const last = tools.at(-1) ?? '';
      // A tool offered in one line is loaded by the first call and sent again, as a model does.
      if (/listed in one line/.test(last)) { const call = lastCall(messages)!; return { calls: [{ name: call.function.name, args: JSON.parse(call.function.arguments) as Record<string, unknown> }] }; }
      // Attach to the owner's browser, open the checkout in a tab of its own, read it, buy.
      const results = tools.filter((text) => !/listed in one line/.test(text));
      const all = results.join('\n');
      if (all.includes('"methodId": "payments.checkout.begin"')) return { text: 'The purchase is with the checkout now.' };
      if (results.length === 0) return { calls: [{ name: 'browser', args: { action: 'attach', cdpEndpoint } }] };
      const browserSession = /"sessionId"\s*:\s*"([^"]+)"/.exec(results[0]!)?.[1];
      if (results.length === 1) return { calls: [{ name: 'browser', args: { action: 'new_tab', sessionId: browserSession, url } }] };
      const pageId = /"pageId"\s*:\s*"([^"]+)"/.exec(results[1]!)?.[1];
      const ref = (name: string) => new RegExp(`"ref"\\s*:\\s*"(e\\d+)"\\s*,\\s*"role"\\s*:\\s*"textbox"\\s*,\\s*"name"\\s*:\\s*"${name}"`).exec(all)?.[1];
      if (!ref('Card number')) return { calls: [{ name: 'browser', args: { action: 'snapshot', sessionId: browserSession, pageId } }] };
      const button = /"ref"\s*:\s*"(e\d+)"\s*,\s*"role"\s*:\s*"button"/.exec(all)?.[1];
      void step;
      return { calls: [{ name: 'agent_operator_method', args: { methodId: 'payments.checkout.begin', input: {
        requestId, sessionId: browserSession, pageId, merchantDomain: 'rt-merchant.localhost', checkoutUrl: url, item: 'Test widget', cardId,
        requestedLines: [{ label: 'Test widget', quantity: 1 }], lines: [{ label: 'Test widget', quantity: '1', unitPrice: price }],
        shippingOptions: [{ label: 'Standard', cost: '0.00' }], statedTotal, currency: 'USD',
        cardFields: [{ field: 'cardholderName', ref: ref('Name on card') }, { field: 'number', ref: ref('Card number') }, { field: 'expiry', ref: ref('Expiry') }, { field: 'cvv', ref: ref('CVC') }],
        placeOrderTarget: button,
      } } }] };
    });
    const turn = await sendNativeHostedTurn(s.daemon, owner, `${marker} buy one test widget`, undefined, true);
    await waitFor(async () => { await approvePending(s.daemon, owner); const state = await nativeTurnStatus(s.daemon, owner, turn); return state.state === 'completed' || state.state === 'failed' ? true : undefined; }, 60_000);
    const begin = s.model.requests.filter((entry) => entry.marker === marker).flatMap((entry) => entry.messages.filter((message) => message.role === 'tool').map((message) => textOf(message.content)))
      .find((text) => text.includes('payments.checkout.begin')) ?? 'no begin result';
    const settled = await waitFor(async () => {
      const status = await api(s.daemon, owner, 'GET', `/api/payments/purchase/status?purchaseId=${encodeURIComponent(requestId)}`);
      const operation = ((status.body as { operations?: Array<Record<string, unknown>> }).operations ?? [])[0];
      const windows = (status.body as { windows?: unknown[] }).windows ?? [];
      return operation && (operation.state !== 'running' || windows.length > 0) ? { ...operation, windows } : undefined;
    }, 45_000, 500);
    return { begin, state: settled };
  };

  // 1. Limits at 0.
  const atZero = await purchase('rt-zero', '5.00', '5.00');
  const inboxAtZero = (await invoke(s.daemon, owner, 'inbox.list', {})).text;
  journey.check('at 0 limits the purchase asks the owner and offers to set the limit', 'hosted Agent turn: browser navigate + snapshot, agent_operator_method payments.checkout.begin (5.00); inbox.list',
    `begin ${short(atZero.begin, 200)}; purchase ${short(atZero.state ?? 'no state', 300)}; inbox ${short(inboxAtZero, 1500)}; merchant submissions ${submissions.length}`,
    submissions.length === 0 && atZero.state?.state !== 'failed' && /limit/i.test(inboxAtZero) && !/did not go through/.test(inboxAtZero));

  // A restart while the purchase waits: first the daemon is killed (a crash), and the window must come back.
  await s.restartDaemon({ crash: true });
  owner = operatorToken(s.home);
  await waitFor(async () => (((await api(s.daemon, owner, 'GET', '/api/payments/purchase/status?purchaseId=rt-zero')).body as { windows?: unknown[] }).windows ?? []).length > 0 ? true : undefined, 30_000);
  const after = await api(s.daemon, owner, 'GET', '/api/payments/purchase/status?purchaseId=rt-zero');
  const inboxAfter = (await invoke(s.daemon, owner, 'inbox.list', {})).text;
  journey.check('a purchase waiting on the owner survives a daemon crash', 'kill the daemon (SIGKILL) and start it again; payments.purchase.status rt-zero; inbox.list',
    `status ${short(after.text, 600)}; inbox ${short(inboxAfter, 300)}`,
    after.status === 200 && ((after.body as { windows?: unknown[] }).windows ?? []).length > 0 && !/"state":"(failed|interrupted|refused)"/.test(after.text));

  // Then an ordinary restart (the daemon stopped and started, settings unchanged): the window comes back again.
  await s.restartDaemon();
  owner = operatorToken(s.home);
  await waitFor(async () => (((await api(s.daemon, owner, 'GET', '/api/payments/purchase/status?purchaseId=rt-zero')).body as { windows?: unknown[] }).windows ?? []).length > 0 ? true : undefined, 30_000);
  const afterStop = await api(s.daemon, owner, 'GET', '/api/payments/purchase/status?purchaseId=rt-zero');
  const openItems = (((await invoke(s.daemon, owner, 'inbox.list', {})).body as { items?: Array<{ status: string; kind?: string }> }).items ?? [])
    .filter((entry) => entry.status === 'open' && entry.kind === 'purchase');
  journey.check('a purchase waiting on the owner survives an ordinary daemon restart', 'stop the daemon and start it again; payments.purchase.status rt-zero; inbox.list',
    `status ${short(afterStop.text, 400)}; open purchase items in the inbox ${openItems.length}`,
    afterStop.status === 200 && ((afterStop.body as { windows?: unknown[] }).windows ?? []).length > 0 && !/"state":"(failed|interrupted|refused)"/.test(afterStop.text)
      && openItems.length === 1);

  // 2. The owner answers: the daily limit through the offer, the waiting purchase declined.
  const items = ((await invoke(s.daemon, owner, 'inbox.list', {})).body as { items?: Array<{ id: string; status: string; detail?: string; kind?: string }> }).items ?? [];
  const offer = items.find((entry) => entry.status === 'open' && entry.kind === 'question' && /payments\.budget\.dailyItem/.test(entry.detail ?? ''));
  const offerAnswer = offer ? await invoke(s.daemon, owner, 'inbox.answer', { itemId: offer.id, text: '20' }) : undefined;
  const zeroStatus = await api(s.daemon, owner, 'GET', '/api/payments/purchase/status?purchaseId=rt-zero');
  const zeroWindow = ((zeroStatus.body as { windows?: Array<{ windowId?: string; id?: string }> }).windows ?? [])[0];
  const declined = zeroWindow ? await api(s.daemon, owner, 'POST', '/api/payments/purchase/deny', { purchaseId: 'rt-zero', windowId: zeroWindow.windowId ?? zeroWindow.id, confirm: true }, { 'x-goodvibes-explicit-user-request': 'true' }) : undefined;
  // The owner's "no" is on the purchase's record before it is reported accepted: the daemon is killed the moment the answer came back.
  await s.restartDaemon({ crash: true });
  owner = operatorToken(s.home);
  const budgetAfter = await api(s.daemon, owner, 'GET', '/api/payments/budget');
  journey.check('answering the offer sets the daily limit; the owner declines the waiting purchase', 'inbox.answer { text: 20 } on the limit offer; payments.purchase.deny on its window; GET /api/payments/budget',
    `offer ${offerAnswer?.status} ${short(offerAnswer?.text ?? 'no offer', 160)}; deny ${declined?.status} ${short(declined?.text ?? 'no window', 160)}; budget ${short(budgetAfter.text, 200)}`,
    offerAnswer?.status === 200 && (budgetAfter.body as { item?: { limit?: number } }).item?.limit === 2000 && declined !== undefined && declined.status < 300 && submissions.length === 0);
  await Bun.sleep(3_000);
  const afterDeny = await api(s.daemon, owner, 'GET', '/api/payments/purchase/status?purchaseId=rt-zero');
  journey.check('a purchase the owner declined is not resumed after a crash right after the answer', 'payments.purchase.deny; SIGKILL the daemon at once; start it again; payments.purchase.status rt-zero',
    `status ${short(afterDeny.text, 500)}; merchant submissions ${submissions.length}`,
    afterDeny.status === 200 && ((afterDeny.body as { windows?: unknown[] }).windows ?? []).length === 0 && submissions.length === 0
      && !/"state":"(accepted|running)"/.test(afterDeny.text));
  // The per-purchase ceiling and the overage allowance are set in settings. The owner names the merchant as a
  // retailer he trusts: an in-budget purchase there is told to him (a veto window, here the shortest, one minute)
  // and goes ahead unless he objects.
  const limits = [await daemonSet('payments.budget.perPurchaseCeiling', '20'), await daemonSet('payments.budget.dailyOverage', '5'),
    await daemonSet('payments.majorRetailersAdditional', 'rt-merchant.localhost'), await daemonSet('payments.windows.vetoMinutes', '1')];
  await s.restartDaemon();
  owner = operatorToken(s.home);
  const before = submissions.length;
  const inside = await purchase('rt-inside', '5.00', '5.00');
  await waitFor(() => submissions.length > before ? true : undefined, 150_000, 1_000);
  await Bun.sleep(5_000);
  const insideAfter = await api(s.daemon, owner, 'GET', '/api/payments/purchase/status?purchaseId=rt-inside');
  journey.check('inside the limits a purchase completes without asking and submits once', 'limits 20 / 20 / 5; the same purchase flow (5.00); the one-minute veto window passes',
    `limits ${limits.map((run) => run.code).join(',')}; window ${short(inside.state ?? 'no state', 700)}; after ${short(insideAfter.text, 400)}; merchant submissions ${submissions.length - before}`,
    limits.every((run) => run.code === 0) && submissions.length - before === 1
    && ((inside.state?.windows as Array<{ kind?: string }> | undefined) ?? []).every((window) => window.kind !== 'approval'));

  // 3. Over a limit.
  const overBefore = submissions.length;
  const over = await purchase('rt-over', '30.00', '30.00');
  journey.check('over a limit the purchase stops and names the limit and by how much', 'the same purchase flow (30.00) with a 20 ceiling',
    `purchase ${short(over.state ?? 'no state', 400)}; begin ${short(over.begin, 200)}; submissions ${submissions.length - overBefore}`,
    submissions.length === overBefore && /limit|ceiling/i.test(JSON.stringify(over.state ?? {}) + over.begin) && /10(\.00)?\b/.test(JSON.stringify(over.state ?? {}) + over.begin));

  // The owner declines the over-limit purchase, so the next one is not held behind it.
  const overWindow = ((over.state?.windows as Array<{ windowId?: string }> | undefined) ?? [])[0];
  if (overWindow?.windowId) await api(s.daemon, owner, 'POST', '/api/payments/purchase/deny', { purchaseId: 'rt-over', windowId: overWindow.windowId, confirm: true }, { 'x-goodvibes-explicit-user-request': 'true' });

  // 4. A total that changed at checkout.
  const changedBefore = submissions.length;
  const changed = await purchase('rt-changed', '5.00', '5.00', '9.00');
  await Bun.sleep(3_000);
  journey.check('a total that changed at checkout is not submitted', 'the same purchase flow: the model read 5.00, the page now shows a 9.00 total',
    `purchase ${short(changed.state ?? 'no state', 400)}; submissions ${submissions.length - changedBefore}`,
    submissions.length === changedBefore && changed.state !== undefined && /total|mismatch|changed|differ/i.test(JSON.stringify(changed.state)));

  // 5. The decision model answers, but nothing it says can be read: inside the limits nothing is bought, and the owner is told.
  decision.unreadable = true;
  const unreadableBefore = submissions.length;
  const unreadable = await purchase('rt-unreadable', '5.00', '5.00');
  await Bun.sleep(65_000); // longer than the one-minute veto window: a purchase that would go ahead has gone by now
  decision.unreadable = false;
  const unreadableStatus = await api(s.daemon, owner, 'GET', '/api/payments/purchase/status?purchaseId=rt-unreadable');
  const unreadableInbox = (await invoke(s.daemon, owner, 'inbox.list', {})).text;
  const unreadableWindows = (unreadable.state?.windows as Array<{ kind?: string; notice?: string; windowId?: string }> | undefined) ?? [];
  journey.check('when the decision model\'s answers cannot be read, nothing is bought and the owner is told', 'scripted decision model answers every question unreadably; the same purchase flow (5.00) inside the limits; wait past the veto window',
    `purchase ${short(unreadable.state ?? 'no state', 500)}; after ${short(unreadableStatus.text, 400)}; inbox ${short(unreadableInbox, 600)}; submissions ${submissions.length - unreadableBefore}`,
    submissions.length === unreadableBefore && unreadable.state !== undefined
      && (unreadableWindows.some((window) => window.kind === 'approval') || /could not|unreadable|not read|failed/i.test(JSON.stringify(unreadable.state) + unreadableStatus.text)));
  const unreadableWindow = unreadableWindows[0];
  if (unreadableWindow?.windowId) await api(s.daemon, owner, 'POST', '/api/payments/purchase/deny', { purchaseId: 'rt-unreadable', windowId: unreadableWindow.windowId, confirm: true }, { 'x-goodvibes-explicit-user-request': 'true' });

  // 6. No decision model: inside the limits the purchase still asks, and says what was not checked.
  const policySet = await daemonSet('judgment.policy', 'No Decision Model');
  await s.restartDaemon();
  owner = operatorToken(s.home);
  const noModelBefore = submissions.length;
  const noModel = await purchase('rt-nomodel', '5.00', '5.00');
  await Bun.sleep(3_000);
  const noModelWindows = (noModel.state?.windows as Array<{ kind?: string; notice?: string; windowId?: string }> | undefined) ?? [];
  journey.check('with no decision model a purchase inside the limits asks the owner and says why', 'judgment.policy No Decision Model; restart; the same purchase flow (5.00) inside the limits',
    `policy set ${policySet.code}; windows ${short(noModelWindows.map((window) => ({ kind: window.kind, notice: window.notice })), 900)}; submissions ${submissions.length - noModelBefore}`,
    policySet.code === 0 && submissions.length === noModelBefore && noModelWindows.length > 0 && noModelWindows.every((window) => window.kind === 'approval')
      && noModelWindows.some((window) => /no decision model is in use/.test(window.notice ?? '') && /not a subscription/.test(window.notice ?? '')));
  const noModelWindow = noModelWindows[0];
  if (noModelWindow?.windowId) await api(s.daemon, owner, 'POST', '/api/payments/purchase/deny', { purchaseId: 'rt-nomodel', windowId: noModelWindow.windowId, confirm: true }, { 'x-goodvibes-explicit-user-request': 'true' });
} catch (error) {
  journey.check('journey ran to the end', 'j5', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  writeFileSync(join(s.base, 'j5-decisions.json'), JSON.stringify(decision.requests, null, 2));
  await s.close();
  merchant.stop(true);
  decision.stop();
  ownerBrowser.kill();
}
journey.finish(s.base);
