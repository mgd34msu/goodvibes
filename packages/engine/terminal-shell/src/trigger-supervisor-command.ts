import { migrateOperatorTriggers, triggerOperatorStatus, TriggerOperatorError, type TriggerOperatorSupervisor } from '@goodvibes-jev/engine/sdk/platform/triggers';
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
