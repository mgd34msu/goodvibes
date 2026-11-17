/**
 * /state, this app's runtime store as the platform's snapshot reader shows it
 * (runtime/state-snapshot.ts): JSON-safe, credential-masked and bounded, the
 * same shape the daemon's `runtime.state.get` returns for its own store.
 */
import type { CommandRegistry } from '../command-registry.ts';
import { formatRuntimeStateSnapshot, snapshotRuntimeState } from '@/runtime/index.ts';

export function registerStateRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'state',
    description: 'Show what this app\'s runtime store holds now, by domain (session, conversation, agents, tasks, permissions...), for debugging',
    usage: '[domain...]',
    argsHint: '[domain...]',
    effect: 'read-only',
    handler(args, ctx) {
      const store = ctx.platform.runtimeStore;
      if (!store) {
        ctx.print('Runtime state is not available here: this command context has no runtime store.');
        return;
      }
      const domains = args.flatMap((arg) => arg.split(',')).map((name) => name.trim()).filter((name) => name.length > 0);
      const snapshot = snapshotRuntimeState(store, domains.length > 0 ? { domains } : {});
      ctx.print(formatRuntimeStateSnapshot(snapshot, `Runtime State (${new Date(snapshot.capturedAt).toISOString()})`));
    },
  });
}
