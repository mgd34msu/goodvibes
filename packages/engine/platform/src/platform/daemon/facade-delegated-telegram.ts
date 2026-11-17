import type { TelegramSourceAccountReader } from '../channels/telegram/source-account.js';
/** Real paired-owner command path and daemon adapter composition; no default grant. */
import { DelegatedTelegramIntake } from './delegated-telegram-intake.js';
import type { ResolvedDaemonFacadeRuntime } from './facade-types.js';
import type { GatewayMethodCatalog } from '../control-plane/method-catalog.js';
import type { GatewayMethodInvocation } from '../control-plane/method-catalog-shared.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/native-error-summary.js';
import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import { PAIRED_OWNER_REQUIRED, requireNativeOwner } from '../control-plane/routes/native-owner.js';
import { readInvocationParams } from '../control-plane/routes/invocation-params.js';
import { NativeInboundReceiverRefusal } from '../control-plane/native-inbound-handoff.js';
import {
  DelegatedIntakeRefusal, delegatedHold, delegatedTelegramResultSchemas, delegatedTelegramConfigureSchema, delegatedTelegramDecisionSchema,
  delegatedTelegramLookupSchema, delegatedTelegramRevokeSchema, delegatedTelegramReleaseSchema, type DelegatedTelegramOperation,
} from '../control-plane/delegated-inbound-wire.js';
import { z } from 'zod/v4';
const scopes = ['read:work-ledger', 'write:work-ledger'] as const;
/** The one native owner rule (routes/native-owner.ts); a token credential, never a login session. */
function owner(invocation: GatewayMethodInvocation) {
  if (invocation.context.principalKind !== 'token') {
    throw new GatewayVerbError('Delegated Telegram intake runs for the owner\'s own machine or a paired device, not a login session. Use the app on the daemon\'s machine or a paired device, then retry.', PAIRED_OWNER_REQUIRED, 403);
  }
  const authority = requireNativeOwner(invocation, scopes, 'Delegated Telegram intake');
  const current = authority.current();
  if (!current) throw new GatewayVerbError('Delegated Telegram intake: the caller\'s owner authority ended while the command started. Retry.', PAIRED_OWNER_REQUIRED, 403);
  return { authority, current };
}
/** Each command's input, parsed once at the top so a malformed one is a 400 for every command. */
const inputSchemas = {
  configure: delegatedTelegramConfigureSchema, decide: delegatedTelegramDecisionSchema, status: delegatedTelegramLookupSchema,
  read: delegatedTelegramLookupSchema, cancel: delegatedTelegramLookupSchema, revoke: delegatedTelegramRevokeSchema,
  release: delegatedTelegramReleaseSchema, list: z.object({}).strict(),
} as const;
const MAX_COMMAND_BYTES = 16_384;
function parseInput<O extends DelegatedTelegramOperation>(operation: O, input: Record<string, unknown>): z.infer<typeof inputSchemas[O]> {
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_COMMAND_BYTES) {
    throw new GatewayVerbError(`The inbound.telegram.${operation} command is larger than ${MAX_COMMAND_BYTES} bytes. Send only the fields the command takes.`, 'INVALID_ARGUMENT', 400);
  }
  const parsed = inputSchemas[operation].safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.map(String).join('.') || undefined;
    throw new GatewayVerbError(`Invalid inbound.telegram.${operation} input${field ? ` at ${field}` : ''}: ${issue?.message ?? 'the input does not match the command'}.`, 'INVALID_ARGUMENT', 400, field);
  }
  return parsed.data as z.infer<typeof inputSchemas[O]>;
}
export function registerDelegatedTelegramCommands(catalog: GatewayMethodCatalog, host: DelegatedTelegramIntake): void {
  // `release` takes a configuration id like `revoke` and returns the chat to normal handling; it is served once the catalog describes it.
  const operations = ['configure', 'decide', 'status', 'revoke', 'list', 'read', 'cancel', ...(catalog.get('inbound.telegram.release') ? ['release' as const] : [])] as const;
  for (const operation of operations) {
    const descriptor = catalog.get(`inbound.telegram.${operation}`);
    if (!descriptor) throw new Error('Missing delegated Telegram command descriptor');
    catalog.register(descriptor, async invocation => {
      const { authority, current } = owner(invocation);
      const input = parseInput(operation, readInvocationParams(invocation));
      try {
        // Never hold the global paired-owner lock across provider/credential I/O.
        const selection = operation === 'configure'
          ? await authority.withCurrent(current, async check => { check(); const attempt = await host.selectConfiguration(input as z.infer<typeof delegatedTelegramConfigureSchema>, authority); check(); return attempt; })
          : undefined;
        const needsProof = operation === 'configure' || (operation === 'decide' && (input as z.infer<typeof delegatedTelegramDecisionSchema>).approved);
        const prepared = needsProof ? await host.prepareAccount(invocation.signal).catch(() => { throw new DelegatedIntakeRefusal('account-proof-unavailable'); }) : null;
        invocation.signal?.throwIfAborted(); owner(invocation);
        return await authority.withCurrent(current, async assertCurrent => {
          invocation.signal?.throwIfAborted(); assertCurrent();
          let result: unknown;
          if (operation === 'configure') result = await host.configure(input as z.infer<typeof delegatedTelegramConfigureSchema>, authority, prepared, selection);
          else if (operation === 'decide') result = await host.decide(input as z.infer<typeof delegatedTelegramDecisionSchema>, authority, prepared);
          else if (operation === 'revoke') result = host.revoke((input as z.infer<typeof delegatedTelegramRevokeSchema>).configurationId, authority);
          else if (operation === 'release') {
            const target = input as z.infer<typeof delegatedTelegramReleaseSchema>;
            result = await host.release('configurationId' in target ? target.configurationId : target, authority);
          } else if (operation === 'list') result = await host.list(authority);
          else {
            const { ref } = input as z.infer<typeof delegatedTelegramLookupSchema>;
            result = operation === 'cancel' ? await host.cancel(ref, authority) : await host.status(ref, authority, operation === 'read');
          }
          invocation.signal?.throwIfAborted(); assertCurrent(); owner(invocation);
          return delegatedTelegramResultSchemas[operation].parse(result);
        });
      } catch (error) {
        // A cancelled request gets no result; it ends as the caller's own abort.
        if (invocation.signal?.aborted) throw error;
        // A refusal is a result an agent can branch on: its reason, its sentence and its next step.
        if (error instanceof DelegatedIntakeRefusal) return delegatedHold(error.reason, { message: error.message });
        if (error instanceof NativeInboundReceiverRefusal) return delegatedHold('review-queue-refused', { message: error.message });
        if (error instanceof GatewayVerbError) throw error;
        logger.warn('Delegated Telegram command failed', { operation, error: summarizeError(error) });
        throw new GatewayVerbError(`inbound.telegram.${operation} failed and changed nothing it could not undo; no message was replayed. The daemon log has the cause.`, 'DELEGATED_INTAKE_HELD', 409);
      }
    }, { replace: true });
  }
}
/**
 * A working-directory change is saved for the next start and moves nothing in
 * this process, so the intake's workspace stays current for its whole life; the
 * swap manager argument is accepted and not needed.
 */
export function composeDelegatedTelegramIntake(runtime: ResolvedDaemonFacadeRuntime, accounts: TelegramSourceAccountReader): DelegatedTelegramIntake {
  const host = new DelegatedTelegramIntake({ broker: runtime.sessionBroker, approvals: runtime.approvalBroker, routes: runtime.routeBindings,
    accounts, workspaceRoot: runtime.runtimeServices.workingDirectory,
    beforeReviewOwnerWrite: () => runtime.runtimeServices.nativeDataWriter?.declare('delegated-review-owner-v2'),
    selectionPath: runtime.runtimeServices.shellPaths.resolveProjectPath('goodvibes', 'channels', 'telegram-delegated-selection.json'),
    receiptPath: runtime.runtimeServices.shellPaths.resolveProjectPath('goodvibes', 'channels', 'telegram-delegated-review.json'),
  });
  registerDelegatedTelegramCommands(runtime.gatewayMethods, host); return host;
}
