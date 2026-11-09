import { migrateOperatorTriggers, triggerOperatorStatus, TriggerOperatorError, type TriggerOperatorSupervisor } from '@goodvibes-jev/engine/platform/platform/triggers';
import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import { readTriggerOperatorStatus, readTriggerMigrationResult, TRIGGER_OPERATOR_MESSAGES, type TriggerOperatorFailureKind } from '@goodvibes-jev/engine/platform/platform/triggers/browser';
import { RetainedOperatorConnection } from './retained-operator-connection.js';
import { isPairedOperatorPrincipal } from './native/native-paired-principal.js';
import type { PaymentWindowCommandContext, PaymentWindowCommandPolicy } from './payment-window-command.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';
import type { TerminalSlashCommand } from './command-registry.js';
import type { OpenSelection } from './selection-modal.js';
interface TriggerCommandContext {
  readonly ops: { readonly triggerSupervisor?: TriggerOperatorSupervisor | undefined };
  readonly print: (message: string) => void;
  readonly renderRequest: () => void;
  readonly openSelection?: OpenSelection;
}
const display = (value: string) => stripDangerousAnsi(value).replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
/** One terminal controller; product wrappers supply their actual keyboard owner
 * dispatch check, while bootstrap injects the original local surface manager. */
export function registerTriggerSupervisorCommand<Context extends TriggerCommandContext>(
  registry: { register(command: TerminalSlashCommand<Context>): void },
  policy: { readonly isOwner: (context: Context) => boolean },
): void {
  registry.register({ name: 'triggers', description: 'Inspect this surface’s supervised triggers and explicitly migrate older trigger state',
    usage: '[status|migrate [--older-instances-closed]]', argsHint: 'status|migrate', handler: (args, context) => {
      const mode = args[0] ?? 'status';
      if (!['status', 'migrate'].includes(mode) || args.slice(1).some(arg => arg !== '--older-instances-closed') || mode === 'status' && args.length > 1) {
        context.print('Usage: /triggers [status|migrate [--older-instances-closed]]'); return;
      }
      const supervisor = context.ops.triggerSupervisor;
      if (!supervisor) { context.print('[triggers] This surface has no local trigger supervisor. Use trigger recovery on the owning GoodVibes surface.'); return; }
      const fail = (error: unknown) => { context.print(`[triggers] ${error instanceof TriggerOperatorError ? error.message : 'Could not confirm trigger state. Reopen /triggers status on the owning surface.'}`); context.renderRequest(); };
      try {
        const status = triggerOperatorStatus(supervisor);
        context.print(`[triggers] ${status.message}`);
        for (const record of status.records) context.print(`  ${display(record.label)} (${display(record.id)}) — ${display(record.kind)} / ${display(record.state)}`);
        if (mode === 'status') { if (status.migrationRequired) context.print('Run /triggers migrate after closing all older GoodVibes instances using this surface.'); return; }
        if (!policy.isOwner(context)) { context.print('[triggers] Type /triggers migrate directly in the owner terminal. A model command cannot acknowledge closing older instances.'); return; }
        if (!status.migrationRequired) return;
        const current = () => { if (context.ops.triggerSupervisor !== supervisor) throw new Error('Original supervisor changed'); };
        const migrate = () => { try { current(); const result = migrateOperatorTriggers(supervisor, { olderInstancesClosed: true }); context.print(`[triggers] Migration completed. ${result.status.message}`); context.renderRequest(); } catch (error) { fail(error); } };
        if (args.includes('--older-instances-closed')) { migrate(); return; }
        const open = context.openSelection;
        if (!open) { context.print('[triggers] After closing all older instances, explicitly run /triggers migrate --older-instances-closed. This is your statement, not a liveness check.'); return; }
        const detail = `${status.records.length} saved trigger(s) on this surface.\n\n${status.message}\n\n${status.records.map(record => `${display(record.label)} — ${display(record.kind)} / ${display(record.state)}`).join('\n')}`;
        let offered = true;
        open.call(context, 'Close older instances before migrating triggers', [
          { id: 'keep', label: 'Keep triggers stopped', detail },
          { id: 'migrate', label: 'I closed all older GoodVibes instances — migrate triggers', detail },
        ], { allowSearch: false, primaryVerbLabel: 'Choose' }, result => {
          if (!offered) return; offered = false;
          if (!result || result.action !== 'select' || result.item.id !== 'migrate') return;
          try { current(); if (context.openSelection !== open) throw new Error('Owner view changed'); migrate(); } catch (error) { fail(error); }
        });
      } catch (error) { fail(error); }
    } });
}


/** Client terminals reach the selected daemon through its retained paired
 * connection. The local supervisor controller above remains for Agent hosts. */
export function registerRemoteTriggerSupervisorCommand<Context extends PaymentWindowCommandContext>(
  registry: { register(command: TerminalSlashCommand<Context>): void },
  policy: PaymentWindowCommandPolicy<Context>,
): void {
  registry.register({ name: 'triggers', description: 'Inspect the selected daemon’s supervised triggers and explicitly migrate older trigger state',
    usage: '[status|migrate [--older-instances-closed]]', argsHint: 'status|migrate', async handler(args, context) {
      const mode = args[0] ?? 'status';
      if (!['status', 'migrate'].includes(mode) || args.slice(1).some(arg => arg !== '--older-instances-closed') || mode === 'status' && args.length > 1) {
        context.print('Usage: /triggers [status|migrate [--older-instances-closed]]'); return;
      }
      // Keep the keyboard admission before any await. The retained original
      // picker carries it after command dispatch has removed its transient mark.
      if (mode === 'migrate' && !policy.isOwner(context)) {
        context.print('[triggers] Type /triggers migrate directly in the owner terminal. A model command cannot acknowledge closing older instances.'); return;
      }
      const abort = new AbortController(), open = context.openSelection;
      let connection: RetainedOperatorConnection;
      try { connection = new RetainedOperatorConnection({ owner: () => policy.owner(context), home: () => policy.home(context),
        read: observation => policy.read(context, observation), files: policy.files,
        environment: policy.environment, fetchImpl: policy.fetchImpl, signal: abort.signal }); }
      catch { context.print('[triggers] Check the selected daemon and its paired administrative credential, then reopen /triggers status.'); return; }
      let closed = false, principal: string | undefined;
      const finish = () => { if (closed) return; closed = true; abort.abort(); void connection.close(); };
      const report = (message: string) => { if (!closed) { context.print(message); context.renderRequest(); } };
      const fail = (error: unknown) => {
        let kind: TriggerOperatorFailureKind = 'unavailable';
        if (error instanceof GoodVibesError) {
          const body = error.body;
          const code = body && typeof body === 'object' && 'code' in body ? body.code : error.code;
          for (const candidate of ['other-process', 'migration-required', 'not-required', 'future-version'] as const) {
            if (code === `TRIGGER_${candidate.toUpperCase().replaceAll('-', '_')}`) kind = candidate;
          }
        }
        report(`[triggers] ${TRIGGER_OPERATOR_MESSAGES[kind]}`); finish();
      };
      const authenticate = async (migrating: boolean) => {
        const auth = await connection.run((operator, signal) => operator.control.auth.current({}, { signal }));
        if (!isPairedOperatorPrincipal(auth, migrating ? ['read:watchers', 'write:watchers'] : ['read:watchers'], connection.expectedPrincipalId)
          || principal !== undefined && auth.principalId !== principal) throw new Error('Original administrative watcher principal required');
        principal = auth.principalId;
      };
      const migrate = async () => {
        try {
          if (closed) return;
          connection.assertCurrent();
          if (open && context.openSelection !== open) throw new Error('Original selection owner changed');
          await authenticate(true);
          const result = await connection.run(async (operator, signal) => readTriggerMigrationResult(await operator.transport.requestJson(
            '/api/control-plane/methods/watchers.triggers.migrate/invoke',
            { method: 'POST', body: { body: { confirm: true, olderInstancesClosed: true } }, signal, retry: false },
          )));
          report(`[triggers] Migration completed. ${result.status.message}`); finish();
        } catch (error) { fail(error); }
      };
      try {
        await authenticate(false);
        const status = await connection.run(async (operator, signal) => readTriggerOperatorStatus(await operator.transport.requestJson(
          '/api/control-plane/methods/watchers.triggers.status/invoke', { method: 'POST', body: { body: {} }, signal, retry: false },
        )));
        report(`[triggers] ${status.message}`);
        for (const record of status.records) report(`  ${display(record.label)} (${display(record.id)}) — ${display(record.kind)} / ${display(record.state)}`);
        if (mode === 'status' || !status.migrationRequired) {
          if (status.migrationRequired) report('Run /triggers migrate after closing all older GoodVibes instances using this daemon.');
          finish(); return;
        }
        if (args.includes('--older-instances-closed')) { await migrate(); return; }
        if (!open) { report('[triggers] After closing all older instances, explicitly run /triggers migrate --older-instances-closed. This is your statement, not a liveness check.'); finish(); return; }
        connection.assertCurrent();
        if (context.openSelection !== open) throw new Error('Original selection owner changed');
        let offered = true;
        const detail = `${status.message}\n\n${status.records.map(record => `${display(record.label)} — ${display(record.kind)} / ${display(record.state)}`).join('\n')}`;
        open.call(context, 'Close older instances before migrating daemon triggers', [
          { id: 'keep', label: 'Keep triggers stopped', detail },
          { id: 'migrate', label: 'I closed all older GoodVibes instances — migrate triggers', detail },
        ], { allowSearch: false, primaryVerbLabel: 'Choose', signal: connection.signal }, result => {
          if (!offered || closed) return; offered = false;
          if (!result || result.action !== 'select' || result.item.id !== 'migrate') { finish(); return; }
          void migrate();
        });
      } catch (error) { fail(error); }
    } });
}
