import { expect, test } from 'bun:test';
import { retainCheckoutInvocation } from '../platform/src/platform/payments/host/checkout-invocation.js';
import { HandlerError, type HandlerContextEnvelope } from '../platform/src/platform/payments/host/handler-plumbing.js';
import type { PaymentsHandlerDeps } from '../platform/src/platform/payments/host/register.js';
import type { BrowserCheckoutSeam } from '../platform/src/platform/control-plane/routes/browser-composition.js';
import type { NativeExecutionAuthority, NativePairedSnapshot } from '../platform/src/platform/security/http-auth.js';

function fixture() {
  let allowed = true, leader = true;
  const values = new Map<string, unknown>([['payments.enabled', true]]);
  const seam = {} as BrowserCheckoutSeam; let selected = seam;
  const paired: NativePairedSnapshot = { kind: 'pairing-token', tokenId: 'owner', principalId: 'pairing:owner', authorityId: 'pairing:owner',
    authorityRevision: 'original', scopes: ['write:payments'] };
  let current: NativePairedSnapshot | null = paired;
  const native: NativeExecutionAuthority = { current: () => current, async withCurrent(_expected, work) {
    return work(() => { if (!current) throw new Error('Private revoked token'); return current; });
  } };
  const abort = new AbortController();
  const context: HandlerContextEnvelope = { signal: abort.signal, principalId: paired.principalId, principalKind: 'token',
    admin: true, scopes: ['write:payments'], explicitUserRequest: true, authToken: 'private-fixture-bearer',
    nativeExecutionAuthority: native, isAuthorized: () => allowed };
  // Only the actual dependencies used by this restriction are supplied.
  const deps = { config: { get: (key: string) => values.get(key) }, isPaymentsLeader: () => leader,
    checkout: { seam: () => selected } } as unknown as PaymentsHandlerDeps;
  const owner = retainCheckoutInvocation(deps, seam, context);
  return { owner, context, values, abort, deps, seam, revoke: () => { allowed = false; }, handoff: () => { leader = false; },
    replacePairing: () => { current = { ...paired, authorityRevision: 'replacement' }; },
    replaceSeam: () => { selected = {} as BrowserCheckoutSeam; } };
}

test('an unchanged actual transport/configuration observation remains usable', () => {
  const f = fixture(); expect(() => f.owner.assertCurrent()).not.toThrow();
});

test.each(['revocation', 'pairing', 'leader', 'seam', 'budget', 'merchant-policy', 'context', 'authorization-callback'] as const)(
  '%s changes retire checkout authority without exposing private transport state', kind => {
    const f = fixture();
    if (kind === 'revocation') f.revoke();
    if (kind === 'pairing') f.replacePairing();
    if (kind === 'leader') f.handoff();
    if (kind === 'seam') f.replaceSeam();
    if (kind === 'budget') f.values.set('payments.budget.dailyItem', 2);
    if (kind === 'merchant-policy') f.values.set('payments.majorRetailersExcluded', 'example.com');
    if (kind === 'context') Reflect.set(f.context, 'principalId', 'pairing:other');
    if (kind === 'authorization-callback') Reflect.set(f.context, 'isAuthorized', () => true);
    const error = (() => { try { f.owner.assertCurrent(); } catch (error) { return error; } return null; })();
    expect(error).toBeInstanceOf(HandlerError);
    expect(String(error)).not.toContain('private-fixture-bearer');
  },
);

test('the original cancellation signal cannot be replaced by editing the context', () => {
  const f = fixture(); Reflect.set(f.context, 'signal', new AbortController().signal);
  expect(() => f.owner.assertCurrent()).toThrow(HandlerError);
  const cancelled = fixture(); cancelled.abort.abort(); expect(() => cancelled.owner.assertCurrent()).toThrow();
});

test('missing live authorization cannot be supplied by scopes and a claimed owner flag', () => {
  const f = fixture(); Reflect.set(f.context, 'isAuthorized', undefined);
  expect(() => f.owner.assertCurrent()).toThrow(HandlerError);
  expect(() => retainCheckoutInvocation(f.deps, f.seam, f.context)).toThrow(HandlerError);
});
