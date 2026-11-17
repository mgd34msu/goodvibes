/**
 * Journey 5: purchases inside and over the limits, against a loopback
 * merchant this script serves (no real card, no real money: the card is a
 * test number and the merchant only records what is submitted to it).
 *
 *  - with the per-purchase and daily limits at their default 0, the budget
 *    says every purchase needs the owner;
 *  - the daemon's own browser opens the merchant's checkout page (the page a
 *    purchase is made on); without it no purchase can run, and the step says
 *    why;
 *  - a purchase begun with limits at 0 asks the owner and offers to set the
 *    limit; within limits it completes once at the merchant; over a limit it
 *    names the limit and the amount; a changed total is not submitted; a
 *    purchase waiting on the owner survives a daemon restart.
 */
import { DAEMON_ENTRY, Journey, api, invoke, operatorToken, runProduct, short, stage } from './lib.ts';

const journey = new Journey('j5-purchases');
const submissions: Array<{ path: string; body: string }> = [];
const merchant = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST') { submissions.push({ path: url.pathname, body: await request.text() }); return new Response('<html><body><h1>Order placed</h1><p>Order RT-1</p></body></html>', { headers: { 'content-type': 'text/html' } }); }
    const price = url.searchParams.get('price') ?? '5.00';
    const total = url.searchParams.get('total') ?? price;
    return new Response(`<html><body><h1>Checkout</h1><table><tr><td>Test widget</td><td>1</td><td>$${price}</td></tr></table><p>Total: $${total}</p>
<form method="post" action="/place-order"><label>Name <input autocomplete="cc-name" name="name"></label><label>Card number <input autocomplete="cc-number" name="number"></label>
<label>Expiry <input autocomplete="cc-exp" name="exp"></label><label>CVC <input autocomplete="cc-csc" name="csc"></label><button type="submit">Place order</button></form></body></html>`, { headers: { 'content-type': 'text/html' } });
  },
});
const s = await stage('j5');
s.home.allow(merchant.port!);

try {
  let owner = operatorToken(s.home);
  // Payment settings are the daemon's own: the owner sets them with goodvibes-daemon config set.
  const daemonSet = async (key: string, value: string) => runProduct(s.home, DAEMON_ENTRY, ['config', 'set', key, value]);
  const enabled = [await daemonSet('payments.enabled', 'true'), await daemonSet('payments.currency', 'USD')];
  await s.restartDaemon();
  owner = operatorToken(s.home);
  journey.check('the owner turns payments on', 'goodvibes-daemon config set payments.enabled true; payments.currency USD; restart',
    enabled.map((run) => `${run.code} ${short(run.stdout + run.stderr, 100)}`).join(' | '), enabled.every((run) => run.code === 0));
  const budget = await api(s.daemon, owner, 'GET', '/api/payments/budget');
  const item = (budget.body as { item?: { limit?: number } }).item;
  const overage = (budget.body as { overage?: { limit?: number } }).overage;
  journey.check('with default limits (0) every purchase needs the owner', 'GET /api/payments/budget', `${budget.status} ${short(budget.text, 260)}`,
    budget.status === 200 && item?.limit === 0 && overage?.limit === 0);

  const card = await api(s.daemon, owner, 'POST', '/api/payments/cards', { label: 'run-through test card', number: '4111111111111111', expiryMonth: 12, expiryYear: 2030, cvv: '123', cardholderName: 'Run Through', kind: 'virtual' });
  const cardId = (card.body as { card?: { id?: string }; id?: string }).card?.id ?? (card.body as { id?: string }).id ?? '';
  journey.check('a test card is stored in the secret store, not returned', 'POST /api/payments/cards (test number 4111 1111 1111 1111)', `${card.status} ${short(card.text, 200)}`,
    card.status < 300 && !card.text.includes('4111111111111111') && !card.text.includes('"123"'));

  const launched = await api(s.daemon, owner, 'POST', '/api/browser/navigate', { url: `http://127.0.0.1:${merchant.port}/checkout`, headless: true });
  const pageId = (launched.body as { pageId?: string; page?: { id?: string } }).pageId ?? (launched.body as { page?: { id?: string } }).page?.id;
  journey.check('the daemon\'s browser opens the merchant checkout page', `POST /api/browser/navigate { url: loopback merchant }`, `${launched.status} ${short(launched.text, 300)}`,
    launched.status === 200 && typeof pageId === 'string');
  if (launched.status !== 200 || typeof pageId !== 'string') {
    journey.check('purchases inside and over the limits (not run)', 'needs the daemon browser on the merchant page',
      'not run: the daemon could not open its browser on this machine (see the step above), and every purchase is typed into a page that browser holds', false);
  } else {
    const session = await invoke(s.daemon, owner, 'sessions.hosted.create', { workspaceRoot: s.home.workspace, originSurface: 'agent', title: 'purchase' });
    const sessionId = (session.body as { session?: { id?: string } }).session?.id ?? '';
    // The element refs of the checkout page, as the Agent reads them with a snapshot.
    const refsFor = async (page: string): Promise<{ cardFields: Array<{ field: string; ref: string }>; place: string }> => {
      const snap = await api(s.daemon, owner, 'POST', '/api/browser/snapshot', { pageId: page });
      const elements = (snap.body as { elements?: Array<{ ref: string; role: string; name: string }> }).elements ?? [];
      const ref = (name: string) => elements.find((element) => element.role === 'textbox' && element.name === name)?.ref ?? '';
      return {
        cardFields: [{ field: 'cardholderName', ref: ref('Name') }, { field: 'number', ref: ref('Card number') }, { field: 'expiry', ref: ref('Expiry') }, { field: 'cvv', ref: ref('CVC') }],
        place: elements.find((element) => element.role === 'button')?.ref ?? '',
      };
    };
    const begin = async (requestId: string, unitPrice: string, statedTotal: string): Promise<{ status: number; text: string; body: unknown }> => {
      const opened = await api(s.daemon, owner, 'POST', '/api/browser/navigate', { url: `http://127.0.0.1:${merchant.port}/checkout?price=${unitPrice}&total=${statedTotal}`, headless: true });
      const page = (opened.body as { pageId?: string }).pageId ?? '';
      const refs = await refsFor(page);
      return api(s.daemon, owner, 'POST', '/api/payments/checkout/begin', {
        requestId, sessionId, pageId: page, merchantDomain: '127.0.0.1', checkoutUrl: `http://127.0.0.1:${merchant.port}/checkout`, item: 'Test widget',
        requestedLines: [{ label: 'Test widget', quantity: 1 }], lines: [{ label: 'Test widget', quantity: '1', unitPrice }],
        shippingOptions: [{ label: 'Standard', cost: '0.00' }], statedTotal, currency: 'USD', twoDigitYear: true, expirySeparator: '/',
        cardFields: refs.cardFields, placeOrderTarget: refs.place, cardId,
      // The owner asked for this purchase in an app, which says so on the request.
      }, { 'x-goodvibes-explicit-user-request': 'true' });
    };
    const inboxText = async () => (await invoke(s.daemon, owner, 'inbox.list', {})).text;

    const atZero = await begin('rt-purchase-zero', '5.00', '5.00');
    await Bun.sleep(2_000);
    const zeroInbox = await inboxText();
    journey.check('with limits at 0 a purchase asks the owner and offers to set the limit', 'payments.checkout.begin (5.00) with default limits; inbox.list',
      `begin ${atZero.status} ${short(atZero.text, 300)}; inbox ${short(zeroInbox, 300)}; submitted ${submissions.length}`,
      atZero.status < 500 && submissions.length === 0 && /limit/i.test(zeroInbox + atZero.text));

    await s.restartDaemon();
    const listedAfter = await api(s.daemon, operatorToken(s.home), 'GET', '/api/payments/purchases');
    journey.check('a purchase waiting on the owner survives a daemon restart', 'restart the daemon; GET /api/payments/purchases', `${listedAfter.status} ${short(listedAfter.text, 300)}`,
      listedAfter.status === 200 && listedAfter.text.includes('rt-purchase-zero'));

    const owner2 = operatorToken(s.home);
    const limitRuns = [await daemonSet('payments.budget.perPurchaseCeiling', '20'), await daemonSet('payments.budget.dailyItem', '20'), await daemonSet('payments.budget.dailyOverage', '5')];
    await s.restartDaemon();
    const limits = { status: limitRuns.every((run) => run.code === 0) ? 200 : 500 };
    void owner2;
    const before = submissions.length;
    const inside = await begin('rt-purchase-inside', '5.00', '5.00');
    await Bun.sleep(5_000);
    journey.check('within the limits a purchase completes without asking and submits once', 'set limits 20/20/5; payments.checkout.begin (5.00)',
      `limits ${limits.status}; begin ${inside.status} ${short(inside.text, 300)}; merchant submissions ${submissions.length - before}`,
      limits.status === 200 && inside.status < 300 && submissions.length - before === 1);

    const overBefore = submissions.length;
    const over = await begin('rt-purchase-over', '30.00', '30.00');
    await Bun.sleep(2_000);
    journey.check('over a limit the purchase stops and names the limit and by how much', 'payments.checkout.begin (30.00) with a 20 ceiling',
      `begin ${over.status} ${short(over.text, 400)}; submissions ${submissions.length - overBefore}`,
      submissions.length === overBefore && /ceiling|limit/i.test(over.text) && /10(\.00)?/.test(over.text));

    const changedBefore = submissions.length;
    const changed = await begin('rt-purchase-changed', '5.00', '9.00');
    await Bun.sleep(3_000);
    journey.check('a total that changed at checkout is not submitted', 'payments.checkout.begin (lines 5.00, stated total 9.00)',
      `begin ${changed.status} ${short(changed.text, 300)}; submissions ${submissions.length - changedBefore}`,
      // Not submitted BECAUSE the total differs, not because the purchase never reached the page.
      submissions.length === changedBefore && /total|differ|changed|match/i.test(changed.text) && !/page connection is unavailable/.test(changed.text));
  }
} catch (error) {
  journey.check('journey ran to the end', 'j5', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  await s.close();
  merchant.stop(true);
}
journey.finish(s.base);
