/** Authenticated conversation admission only. Source text cannot select host authority. */
import { NativeSelectedDiffError } from '../../workflow/work-ledger/native-diff-context.js';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { WORK_LEDGER_WRITE_SCOPE } from '../method-catalog-native-work-submission.js';
import { WORK_LEDGER_READ_SCOPE } from '../method-catalog-work-ledger.js';
import { NativeConversationStorageError } from '../../workflow/work-ledger/native-intake-types.js';
import { NativeConversationIntakeError, type NativeConversationIntakeHost } from '../../workflow/work-ledger/native-intake.js';
import {
  nativeConversationIntakeCaptureRequestSchema, nativeConversationIntakeLookupRequestSchema, nativeConversationIntakeTransitionRequestSchema,
  nativeConversationIntakeResultSchema, nativeConversationIntakeLookupResultSchema,
} from '../../workflow/work-ledger/native-intake-wire.js';
import { GatewayVerbError, withholdCommittedResult } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { requireNativeOwner } from './native-owner.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { readRefusal } from '@goodvibes/engine/errors';
const SCOPES = [WORK_LEDGER_READ_SCOPE, WORK_LEDGER_WRITE_SCOPE] as const;
function authorize(invocation: GatewayMethodInvocation) {
  return requireNativeOwner(invocation, SCOPES, 'Native intake');
}
export function registerNativeConversationIntakeGatewayMethods(catalog: GatewayMethodCatalog, host: Pick<NativeConversationIntakeHost, 'capture' | 'get' | 'admit' | 'resume' | 'cancel'>): void {
  for (const operation of ['capture', 'get', 'admit', 'resume', 'cancel'] as const) {
    const method = `workLedger.intake.${operation}`;
    const descriptor = catalog.get(method);
    if (!descriptor) throw new Error(`Missing native intake descriptor: ${method}`);
    catalog.register(descriptor, async invocation => {
      try {
        const authority = authorize(invocation); const input = readInvocationParams(invocation);
        invocation.signal?.throwIfAborted();
        const options = { ...(invocation.signal ? { signal: invocation.signal } : {}), isAuthorized: () => invocation.isAuthorized?.(SCOPES) === true };
        if (operation === 'capture') {
          const parsed = nativeConversationIntakeCaptureRequestSchema.safeParse(input);
          if (!parsed.success) throw new GatewayVerbError('Invalid native conversation source', 'INVALID_ARGUMENT', 400);
          const result = await host.capture(parsed.data, authority, options);
          invocation.signal?.throwIfAborted();
          try { authorize(invocation); } catch (revoked) { withholdCommittedResult(revoked, 'The capture was recorded.'); }
          return nativeConversationIntakeResultSchema.parse(result);
        }
        if (operation === 'get') {
          const parsed = nativeConversationIntakeLookupRequestSchema.safeParse(input);
          if (!parsed.success) throw new GatewayVerbError('Invalid native intake lookup', 'INVALID_ARGUMENT', 400);
          const result = await host.get(parsed.data, authority, options);
          invocation.signal?.throwIfAborted(); authorize(invocation); return nativeConversationIntakeLookupResultSchema.parse(result);
        }
        const parsed = nativeConversationIntakeTransitionRequestSchema.safeParse(input);
        if (!parsed.success) throw new GatewayVerbError('Invalid native intake source identity', 'INVALID_ARGUMENT', 400);
        const result = await host[operation](parsed.data, authority, options);
        invocation.signal?.throwIfAborted();
        try { authorize(invocation); } catch (revoked) { withholdCommittedResult(revoked, `The ${operation} request was applied.`); }
        return nativeConversationIntakeResultSchema.parse(result);
      } catch (error) {
        if (error instanceof GatewayVerbError) throw error;
        if (error instanceof NativeSelectedDiffError) throw new GatewayVerbError(`Selected diff ${error.code}; inspect the current changes before submitting a new original`, `NATIVE_SELECTED_DIFF_${error.code.toUpperCase()}`, error.code === 'oversize' ? 413 : error.code === 'unsupported' ? 400 : 409);
        if (error instanceof NativeConversationIntakeError) {
          const status = ['unsupported-authority', 'forbidden'].includes(error.code) ? 403 : error.code === 'invalid' ? 400
            : ['stale', 'conflict', 'request-conflict', 'recovery-required'].includes(error.code) ? 409 : error.code === 'not-found' ? 404 : 503;
          throw new GatewayVerbError(error.code === 'indeterminate'
            ? 'Native intake outcome is unknown. Look up the original input before choosing recovery.'
            // A refused request says why (host-written text: the file limit, an unknown attachment, a malformed request).
            : error.code === 'invalid' ? error.message : `Native conversation intake ${error.code}`, `NATIVE_INTAKE_${error.code.replaceAll('-', '_').toUpperCase()}`, status);
        }
        if (error instanceof NativeConversationStorageError) {
          // The record on disk, not the request, is what is wrong: a record
          // written by a newer daemon needs an upgrade, and an unreadable one
          // needs the owner. Neither is cured by retrying the same input.
          const stored = error.code === 'future-version'
            ? { status: 409, text: 'A stored conversation record was written by a newer version of this daemon. Upgrade the daemon, then retry.' }
            : error.code === 'invalid'
              ? { status: 500, text: 'A stored conversation record is unreadable. Retrying the same input will not help; check the daemon storage.' }
              : error.code === 'not-found'
                ? { status: 404, text: 'No stored conversation record matches this input.' }
                : error.code === 'conflict' || error.code === 'cancelled'
                  ? { status: 409, text: `The stored conversation record is ${error.code === 'cancelled' ? 'cancelled' : 'in conflict with this request'}; look up the original input before choosing a move. ${error.message}` }
                  : { status: 503, text: 'Conversation storage is unavailable or closing. Retain the original input identity and retry.' };
          logger.error('Native conversation storage refused the intake', { operation, code: error.code });
          throw new GatewayVerbError(stored.text, `NATIVE_INTAKE_STORAGE_${error.code.replaceAll('-', '_').toUpperCase()}`, stored.status);
        }
        // A refusal that names its own state and next step (an unregistered or
        // declined workspace) is decided before anything is recorded: answer it
        // as itself, so the caller can say what to do instead of "unavailable".
        const carried = readRefusal(error);
        if (carried) throw new GatewayVerbError(`${carried.reason}: ${carried.state}.${carried.next.length > 0 ? ` ${carried.next.join(' ')}` : ''}`, carried.code, carried.status ?? 409);
        logger.error('Native conversation intake failed', { operation, error: summarizeError(error) });
        throw new GatewayVerbError(`Native conversation intake failed: ${summarizeError(error)}; retain the original input identity`, 'NATIVE_INTAKE_UNAVAILABLE', 503);
      }
    }, { replace: true });
  }
}
