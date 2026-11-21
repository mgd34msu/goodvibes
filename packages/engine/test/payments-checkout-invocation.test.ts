// Proves: A purchase is started or continued by a caller who is not the owner asking, or the owner cannot cancel one.
// Red when: A started purchase keeps its authority after a revocation or a lowered limit, the owner (local or paired) cannot cancel, or a purchase is started or cancelled without the explicit request.
/**
 * Who may start and stop a purchase. An app on the owner's own machine (the
 * transport's 'local' authority) and a paired device may both start and cancel;
 * a call without the owner's explicit request, or with no authority from the
 * transport, may not. Once started, any change to the authority, settings or
 * browser owner retires the purchase's authority.
 *
 * Real `checkout-invocation.ts`, `window-handlers.ts` behind the gateway
 * catalog and its confirmation gate (the cancel), and the payment host's
 * `CheckoutOperations` over its real operations store, journal and purchase
 * ledger, reading the real settings manager, all in temp folders. Stand-in:
 * the transport's authority, and the admitted purchase's checkout run, which
 * waits until it is stopped.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { retainCheckoutInvocation, retainDetachedCheckout } from '../platform/src/platform/payments/host/checkout-invocation.js';
import { purchaseWindowAnswerHandler } from '../platform/src/platform/payments/host/window-handlers.js';
import { UntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.js';
import { CheckoutOperations } from '../platform/src/platform/payments/host/checkout-operations.js';
import { DurablePaymentOperations } from '../platform/src/platform/payments/host/operation-store.js';
import { DurableCheckoutJournal } from '../platform/src/platform/payments/host/checkout-journal-store.js';
import { DaemonPurchaseLedger } from '../platform/src/platform/payments/host/purchase-ledger.js';
import type { BeginCheckoutInput } from '../platform/src/platform/payments/payments-gateway-service.js';
import { registerCatalogHandler, type HandlerContextEnvelope } from '../platform/src/platform/control-plane/host-handlers.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { GatewayVerbError } from '../platform/src/platform/control-plane/routes/gateway-verb-error.js';
import type { PaymentsHandlerDeps } from '../platform/src/platform/payments/host/register.js';
import type { BrowserCheckoutSeam } from '../platform/src/platform/control-plane/routes/browser-composition.js';
import type { NativeExecutionAuthority, NativePairedSnapshot } from '../platform/src/platform/security/http-auth.js';

/** The daemon's settings manager over a temp folder, with payments turned on. */
function settings(): ConfigManager {
  const home = makeProjectTempDir('gv-payments-invocation');
  const configDir = join(home, '.goodvibes', 'goodvibes');
  mkdirSync(configDir, { recursive: true });
  const manager = new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'goodvibes',
    daemonTierPath: join(home, '.goodvibes', 'daemon', 'settings.json'), ownsDaemonTier: true });
  manager.set('payments.enabled', true);
  return manager;
}

function fixture() {
  let allowed = true;
  const config = settings();
  const seam = {} as BrowserCheckoutSeam;
  const paired: NativePairedSnapshot = { kind: 'pairing-token', tokenId: 'owner', principalId: 'pairing:owner', authorityId: 'pairing:owner',
    authorityRevision: 'original', scopes: ['write:payments'] };
  const native: NativeExecutionAuthority = { current: () => paired, async withCurrent(_expected, work) {
    return work(() => paired);
  } };
  const abort = new AbortController();
  const context: HandlerContextEnvelope = { signal: abort.signal, principalId: paired.principalId, principalKind: 'token',
    admin: true, scopes: ['write:payments'], explicitUserRequest: true, authToken: 'private-fixture-bearer',
    nativeExecutionAuthority: native, isAuthorized: () => allowed };
  // Only the actual dependencies used by this restriction are supplied.
  const deps = { config, isPaymentsLeader: () => true,
    checkout: { seam: () => seam } } as unknown as PaymentsHandlerDeps;
  const owner = retainCheckoutInvocation(deps, seam, context);
  return { owner, context, config, abort, deps, seam, revoke: () => { allowed = false; } };
}

test.each(['revocation', 'budget'] as const)(
  '%s changes retire checkout authority without exposing private transport state', kind => {
    const f = fixture();
    if (kind === 'revocation') f.revoke();
    if (kind === 'budget') f.config.set('payments.budget.dailyItem', 2);
    const error = (() => { try { f.owner.assertCurrent(); } catch (error) { return error; } return null; })();
    expect(error).toBeInstanceOf(GatewayVerbError);
    expect(String(error)).not.toContain('private-fixture-bearer');
  },
);

type OwnerKind = 'local' | 'pairing-token';
/** A request as the transport presents it: `kind` null is a caller it gave no owner authority. */
function caller(kind: OwnerKind | null, explicitUserRequest = true): HandlerContextEnvelope {
  const principalId = kind === 'local' ? 'local-owner' : 'pairing:owner';
  const snapshot: NativePairedSnapshot = { kind: kind ?? 'pairing-token', tokenId: 'owner', principalId, authorityId: principalId,
    authorityRevision: 'original', scopes: ['write:payments'] };
  const native: NativeExecutionAuthority = {
    current: () => snapshot,
    async withCurrent(_expected, work) { return work(() => snapshot); },
    issueContinuation: binding => ({ id: `continuation-${randomUUID()}`, binding }),
    revokeContinuation: () => {},
  };
  return { principalId, principalKind: 'token', admin: true, scopes: ['write:payments'],
    explicitUserRequest, authToken: 'private-fixture-bearer', isAuthorized: () => true,
    ...(kind === null ? {} : { nativeExecutionAuthority: native }) };
}

const hosts: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of hosts.splice(0)) await close(); });

/**
 * The payment host's own operations over its real store, journal and purchase
 * ledger in a temp folder. The purchase it admits runs until it is stopped, as
 * a checkout waiting on its page does.
 */
async function paymentHost(kind: OwnerKind | null, explicitUserRequest = true) {
  const context = caller(kind, explicitUserRequest);
  const seam = {} as BrowserCheckoutSeam;
  const deps = { config: settings(), isPaymentsLeader: () => true,
    checkout: { seam: () => seam, untrusted: new UntrustedContentLedger() } } as unknown as PaymentsHandlerDeps;
  const home = makeProjectTempDir('gv-payments-invocation-host');
  const store = new DurablePaymentOperations(join(home, 'payments-operations'));
  const operations = new CheckoutOperations(store, new DurableCheckoutJournal(join(home, 'payments-checkout-journal.json')),
    new DaemonPurchaseLedger({ filePath: join(home, 'payments-purchases.json') }),
    (_input, _id, run) => new Promise((_resolve, reject) => { run.signal.addEventListener('abort', () => reject(run.signal.reason), { once: true }); }));
  hosts.push(() => operations.close());
  await operations.recover();
  const start = () => retainDetachedCheckout(deps, seam, context);
  /** Admit purchase pur-1 on `source`: the caller's own start, or the local owner's when the caller may not start one. */
  const begin = (source = start()) => operations.admit('pur-1', {} as BeginCheckoutInput, source, () => {}, () => {});
  const ownerBegins = () => begin(retainDetachedCheckout(deps, seam, caller('local')));
  // The cancel goes through the real catalog, whose confirmation gate holds the method to its declared `owner-request` before the handler runs.
  const catalog = new GatewayMethodCatalog();
  registerCatalogHandler(catalog, 'payments.purchase.cancel', purchaseWindowAnswerHandler({}, 'cancel', operations));
  const cancel = (operationId: string) => catalog.invoke('payments.purchase.cancel', {
    body: { confirm: true, purchaseId: 'pur-1', operationId }, query: {},
    context: { principalId: context.principalId, principalKind: context.principalKind, admin: context.admin, scopes: context.scopes,
      authToken: context.authToken, metadata: { explicitUserRequest: context.explicitUserRequest } },
    nativeExecutionAuthority: context.nativeExecutionAuthority, isAuthorized: context.isAuthorized });
  // Closing the host joins its work: the stopped purchase has settled. Without the owner's stop it would end interrupted.
  return { start, begin, ownerBegins, cancel, settle: () => operations.close(), state: () => store.get('pur-1')?.state };
}

test.each(['local', 'pairing-token'] as const)('the owner on %s authority can start and cancel a purchase', async kind => {
  const f = await paymentHost(kind);
  expect(f.start().principalId).toBe(kind === 'local' ? 'local-owner' : 'pairing:owner');
  const begun = await f.begin();
  await f.cancel(begun.operationId);
  await f.settle();
  expect(f.state()).toBe('cancelled');
});

test('without the owner\'s explicit request a purchase can be neither started nor cancelled', async () => {
  const f = await paymentHost('local', false);
  expect(() => f.start()).toThrow(GatewayVerbError);
  const begun = await f.ownerBegins(), before = f.state();
  await expect(f.cancel(begun.operationId)).rejects.toBeInstanceOf(GatewayVerbError);
  expect(f.state()).toBe(before);
});
