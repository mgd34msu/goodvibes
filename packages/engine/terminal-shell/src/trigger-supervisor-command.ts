import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import { readTriggerOperatorStatus, TRIGGER_OPERATOR_MESSAGES, type TriggerOperatorFailureKind } from '@goodvibes-jev/engine/platform/platform/triggers/browser';
import { describeRetainedConnectionFailure, RetainedOperatorConnection } from './retained-operator-connection.js';
import { isOwnerOperatorPrincipal } from './native/native-paired-principal.js';
import type { PaymentWindowCommandContext, PaymentWindowCommandPolicy } from './payment-window-command.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';
import type { TerminalSlashCommand } from './command-registry.js';
import { commandRefusal } from './command-confirmation.js';
const display = (value: string) => stripDangerousAnsi(value).replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

/** Client terminals read the selected daemon's trigger supervisor through its
 * retained paired connection. */
export function registerRemoteTriggerSupervisorCommand<Context extends PaymentWindowCommandContext>(
  registry: { register(command: TerminalSlashCommand<Context>): void },
  policy: PaymentWindowCommandPolicy<Context>,
): void {
  registry.register({ name: 'triggers', description: 'Inspect the selected daemon’s supervised triggers',
    usage: '[status]', argsHint: 'status', async handler(args, context) {
      if (args.length > 1 || (args[0] ?? 'status') !== 'status') { throw commandRefusal('Usage: /triggers [status]'); }
      const abort = new AbortController();
      let connection: RetainedOperatorConnection;
      try { connection = new RetainedOperatorConnection({ owner: () => policy.owner(context), home: () => policy.home(context),
        read: observation => policy.read(context, observation), files: policy.files,
        environment: policy.environment, fetchImpl: policy.fetchImpl, signal: abort.signal }); }
      catch (error) { context.print(`[triggers] ${describeRetainedConnectionFailure(error, 'run /triggers status again')}`); return; }
      const report = (message: string) => { context.print(message); context.renderRequest(); };
      try {
        const auth = await connection.run((operator, signal) => operator.control.auth.current({}, { signal }));
        if (!isOwnerOperatorPrincipal(auth, ['read:watchers'], connection.expectedPrincipalId)) throw new Error('Original administrative watcher principal required');
        const status = await connection.run(async (operator, signal) => readTriggerOperatorStatus(await operator.transport.requestJson(
          '/api/control-plane/methods/watchers.triggers.status/invoke', { method: 'POST', body: { body: {} }, signal, retry: false },
        )));
        report(`[triggers] ${status.message}`);
        for (const record of status.records) report(`  ${display(record.label)} (${display(record.id)}) — ${display(record.kind)} / ${display(record.state)}`);
      } catch (error) {
        let kind: TriggerOperatorFailureKind = 'unavailable';
        if (error instanceof GoodVibesError) {
          const body = error.body;
          const code = body && typeof body === 'object' && 'code' in body ? body.code : error.code;
          for (const candidate of ['other-process', 'future-version'] as const) {
            if (code === `TRIGGER_${candidate.toUpperCase().replaceAll('-', '_')}`) kind = candidate;
          }
        }
        report(`[triggers] ${TRIGGER_OPERATOR_MESSAGES[kind]}`);
      } finally {
        abort.abort(); void connection.close();
      }
    } });
}
