import type { CommandRegistry } from '../command-registry.ts';
import { requireHookApi } from './runtime-services.ts';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';

export function registerHooksRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'hooks',
    aliases: [],
    description: 'Inspect, author, simulate, and reload managed hook workflows',
    usage: '[contracts [filter] | reload | scaffold <name> <match> <type> | chain <name> <event1,event2,...> | remove <name> | enable <name> | disable <name> | simulate <eventPath> | inspect <path> | import <path> [merge|replace] | export [path]]',
    argsHint: '[subcommand]',
    subcommands: {
      contracts: '[filter]', reload: '', scaffold: '<name> <match> <type>', chain: '<name> <event1,event2,...>',
      remove: '<name>', enable: '<name>', disable: '<name>', simulate: '<eventPath>', inspect: '<path>',
      import: '<path> [merge|replace]', export: '[path]',
    },
    confirm(args, ctx) {
      if (args[0] === 'remove' && args[1]) {
        return { title: `Remove hook ${args[1]}?`, detail: `The managed hook or chain ${args[1]} is deleted from the hooks file and cannot be recovered; export first with /hooks export to keep a copy.`, confirmLabel: 'Remove' };
      }
      if (args[0] !== 'import' || !args[1] || args[2] !== 'replace' || args.length > 3) return undefined;
      let detail = 'Replacing discards every managed hook and chain now installed and installs the bundle\'s instead; use merge to keep the existing entries.';
      try {
        const workbench = requireHookApi(ctx).workbench;
        const incoming = workbench.inspect(args[1]);
        detail = `Replacing discards every managed hook and chain now in ${workbench.getFilePath()} (${workbench.listManagedHooks().length} hooks, ${workbench.listManagedChains().length} chains) and installs the bundle's ${incoming.hookCount} hooks and ${incoming.chainCount} chains. Use merge to keep the existing entries.`;
      } catch {
        // The handler reports an unreadable bundle or a missing hook service itself.
      }
      return { title: `Replace all managed hooks with ${args[1]}?`, detail, confirmLabel: 'Replace' };
    },
    async handler(args, ctx) {
      const hookApi = requireHookApi(ctx);
      const workbench = hookApi.workbench;
      if (args.length === 0 && ctx.openHooksView) {
        ctx.openHooksView();
        return;
      }

      const subcommand = (args[0] ?? 'contracts').toLowerCase();
      if (subcommand === 'reload') {
        await workbench.reload();
        ctx.print(`Reloaded managed hooks from ${workbench.getFilePath()}`);
        return;
      }
      if (subcommand === 'scaffold') {
        const [name, match, type] = args.slice(1);
        if (!name || !match || !type) throw commandRefusal('Usage: /hooks scaffold <name> <match> <command|prompt|agent|http|ts>');
        if (!['command', 'prompt', 'agent', 'http', 'ts'].includes(type)) {
          throw commandRefusal(`Unknown hook type: ${type}`, 'The type is command, prompt, agent, http or ts', 'USAGE');
        }
        const hook = await workbench.scaffoldHook(name, match, type as Parameters<typeof workbench.scaffoldHook>[2]);
        ctx.print(`Scaffolded managed hook ${hook.name} at ${match} in ${workbench.getFilePath()}`);
        return;
      }
      if (subcommand === 'chain') {
        const name = args[1];
        const matches = args[2]?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
        if (!name || matches.length === 0) throw commandRefusal('Usage: /hooks chain <name> <event1,event2,...>');
        const chain = await workbench.scaffoldChain(name, matches);
        ctx.print(`Scaffolded managed hook chain ${chain.name} with ${chain.steps.length} step(s).`);
        return;
      }
      if (subcommand === 'remove') {
        const name = args[1];
        if (!name) throw commandRefusal('Usage: /hooks remove <name>');
        const removed = await workbench.remove(name);
        if (!removed) throw commandRefusal(`No managed hook or chain named ${name}.`, '/hooks contracts lists the managed hooks file and its entries', 'NOT_FOUND');
        ctx.print(`Removed managed hook workflow entry ${name}.`);
        return;
      }
      if (subcommand === 'enable' || subcommand === 'disable') {
        const name = args[1];
        if (!name) throw commandRefusal(`Usage: /hooks ${subcommand} <name>`);
        const changed = await workbench.toggle(name, subcommand === 'enable');
        if (!changed) throw commandRefusal(`No managed hook named ${name}.`, '/hooks contracts lists the managed hooks file and its entries', 'NOT_FOUND');
        ctx.print(`${subcommand === 'enable' ? 'Enabled' : 'Disabled'} managed hook ${name}.`);
        return;
      }
      if (subcommand === 'simulate') {
        const eventPath = args[1];
        if (!eventPath) throw commandRefusal('Usage: /hooks simulate <eventPath>');
        const result = workbench.simulate(eventPath);
        ctx.print([
          `Hook simulation for ${result.eventPath}`,
          `  matched hooks: ${result.matchedHooks.length}`,
          ...result.matchedHooks.map((entry) => `    ${entry.name}  ${entry.pattern}  ${entry.type}`),
          `  matched chains: ${result.matchedChains.length}`,
          ...result.matchedChains.map((entry) => `    ${entry.name}  stepMatches=${entry.stepMatches}`),
        ].join('\n'));
        return;
      }
      if (subcommand === 'export') {
        const path = await workbench.export(args[1] ?? workbench.getFilePath());
        ctx.print(`Exported managed hooks to ${path}`);
        return;
      }
      if (subcommand === 'inspect') {
        const path = args[1];
        if (!path) throw commandRefusal('Usage: /hooks inspect <path>');
        const inspection = workbench.inspect(path);
        ctx.print([
          `Hook bundle inspection: ${inspection.path}`,
          `  hooks: ${inspection.hookCount}`,
          `  chains: ${inspection.chainCount}`,
          `  patterns: ${inspection.patterns.join(', ') || '(none)'}`,
        ].join('\n'));
        return;
      }
      if (subcommand === 'import') {
        const path = args[1];
        const strategyWords = args.slice(2);
        const strategyWord = strategyWords[0] ?? 'merge';
        if (!path || strategyWords.length > 1 || (strategyWord !== 'merge' && strategyWord !== 'replace')) {
          throw commandRefusal(path && strategyWords.length > 0
            ? `Unknown import strategy "${strategyWords.join(' ')}": use merge or replace. Nothing was imported.`
            : 'Usage: /hooks import <path> [merge|replace]', undefined, 'USAGE');
        }
        const strategy = strategyWord;
        const rejected = await workbench.import(path, strategy);
        ctx.print([
          `Imported managed hooks from ${path} using ${strategy} strategy.${rejected.length > 0 ? ` ${rejected.length} entries in the bundle were left out:` : ''}`,
          ...rejected.map((reason) => `  - ${reason}`),
        ].join('\n'));
        return;
      }

      const filter = (subcommand === 'contracts' ? args.slice(1) : args).join(' ').trim().toLowerCase();
      const contracts = await hookApi.contracts(filter);

      if (contracts.length === 0) {
        ctx.print(filter.length === 0 ? 'No hook contracts registered.' : `No hook contracts matched "${filter}".`);
        return;
      }

      const lines: string[] = [`Hook Contracts (${contracts.length}):`];
      for (const contract of contracts) {
        // The decision model could not say whether this entry fits the filter; it is listed, marked, rather than dropped.
        lines.push(`  ${contract.pattern}${contract.unsure ? ' (unsure match)' : ''}`);
        lines.push(`    authority=${contract.authority} mode=${contract.executionMode} deny=${contract.canDeny ? 'yes' : 'no'} mutate=${contract.canMutateInput ? 'yes' : 'no'} inject=${contract.canInjectContext ? 'yes' : 'no'} timeout=${contract.timeoutMs}ms policy=${contract.failurePolicy}`);
        lines.push(`    ${contract.description}`);
      }
      const managedHooks = workbench.listManagedHooks();
      const managedChains = workbench.listManagedChains();
      lines.push('');
      lines.push(`Managed hooks file: ${workbench.getFilePath()}`);
      lines.push(`Managed entries: hooks=${managedHooks.length} chains=${managedChains.length}`);
      ctx.print(lines.join('\n'));
    },
  });
}
