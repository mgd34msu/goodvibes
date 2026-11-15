/** Authenticated native delivery; authority is supplied solely by the transport. */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { NATIVE_HOSTED_TURN_SCOPES, NativeHostedTurnError, type NativeHostedTurnHost } from '../../hosted-sessions/native-turn-host.js';
import { nativeHostedTurnRequestSchema, nativeHostedTurnStartRequestSchema, nativeHostedTurnLookupSchema, nativeHostedSessionRequestSchema, nativeHostedSessionLookupSchema } from '../../hosted-sessions/native-turn-wire.js';
import { GatewayVerbError, withholdCommittedResult } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { isNativeOwner, requireNativeOwner } from './native-owner.js';
function authorize(invocation: GatewayMethodInvocation) {
  return requireNativeOwner(invocation, NATIVE_HOSTED_TURN_SCOPES, 'Native hosted delivery');
}
export function registerNativeHostedTurnGatewayMethods(catalog: GatewayMethodCatalog, host: NativeHostedTurnHost): void {
  const discovery = catalog.get('workLedger.turn.session');
  if (!discovery) throw new Error('Missing native hosted session descriptor');
  catalog.register(discovery, async invocation => {
    if (invocation.isAuthorized?.(['read:sessions']) !== true) throw new GatewayVerbError('Session discovery requires current read:sessions authority', 'FORBIDDEN', 403);
    const parsed = nativeHostedSessionRequestSchema.safeParse(readInvocationParams(invocation));
    if (!parsed.success) throw new GatewayVerbError('Invalid session identity', 'INVALID_ARGUMENT', 400);
    try {
      const result = await host.session(parsed.data.sessionId, invocation.nativeExecutionAuthority, { isAuthorized: () => isNativeOwner(invocation, NATIVE_HOSTED_TURN_SCOPES) });
      if (invocation.isAuthorized?.(['read:sessions']) !== true) throw new GatewayVerbError('Session discovery authority changed', 'FORBIDDEN', 403);
      return nativeHostedSessionLookupSchema.parse(result);
    } catch (error) {
      if (error instanceof GatewayVerbError) throw error;
      if (error instanceof NativeHostedTurnError) throw new GatewayVerbError(error.message, `NATIVE_TURN_${error.code.replaceAll('-', '_').toUpperCase()}`, error.code === 'forbidden' ? 403 : 409);
      throw new GatewayVerbError('Native session ownership is unavailable. No legacy fallback was selected.', 'NATIVE_TURN_UNAVAILABLE', 503);
    }
  }, { replace: true });
  for (const operation of ['start', 'startAgent', 'status', 'cancel'] as const) {
    const descriptor = catalog.get(`workLedger.turn.${operation}`);
    if (!descriptor) throw new Error('Missing native hosted turn descriptor');
    catalog.register(descriptor, async invocation => {
      try {
        const authority = authorize(invocation), input = readInvocationParams(invocation);
        if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 2048) throw new GatewayVerbError('Native hosted turn identity exceeds the limit', 'INVALID_ARGUMENT', 400);
        const parsed = (operation === 'start' || operation === 'startAgent' ? nativeHostedTurnStartRequestSchema : nativeHostedTurnRequestSchema).safeParse(input);
        if (!parsed.success) throw new GatewayVerbError('Invalid native hosted turn identity', 'INVALID_ARGUMENT', 400);
        invocation.signal?.throwIfAborted();
        const result = await host[operation](parsed.data, authority, { ...(invocation.signal ? { signal: invocation.signal } : {}), isAuthorized: () => isNativeOwner(invocation, NATIVE_HOSTED_TURN_SCOPES) });
        if (operation === 'status') authorize(invocation);
        else {
          try { authorize(invocation); } catch (revoked) { withholdCommittedResult(revoked, `The ${operation} request was applied.`); }
        }
        return nativeHostedTurnLookupSchema.parse(result);
      } catch (error) {
        if (error instanceof GatewayVerbError) throw error;
        if (error instanceof NativeHostedTurnError) throw new GatewayVerbError(error.message, `NATIVE_TURN_${error.code.replaceAll('-', '_').toUpperCase()}`,
          error.code === 'forbidden' ? 403 : error.code === 'invalid' ? 400 : ['stale', 'not-turn', 'recovery-required'].includes(error.code) ? 409 : 503);
        throw new GatewayVerbError('Native hosted turn outcome is unknown. Inspect the original input before continuing.', 'NATIVE_TURN_UNAVAILABLE', 503);
      }
    }, { replace: true });
  }
}
