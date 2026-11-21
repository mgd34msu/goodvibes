import type { HookApi } from '@goodvibes/engine/platform/platform/hooks';
import type { TerminalCommandRegistry } from './command-registry.js';
import { commandRefusal } from './command-confirmation.js';
import { requireContextValue } from './command-service-access.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';
import { doAction, listInput, readAction, textInput } from './described-command-kit.js';

/**
 * `/hooks`, described once (command-actions/) for both terminal apps, since
 * both load the hooks file: see the hook points and the managed hooks file,
 * make, switch on or off and remove managed hooks and chains, try which hooks
 * an event would run, and move hooks between machines.
 */

/** What `/hooks` reads from a product's command context. */
export interface HooksCommandContext extends CommandActionContext {
  readonly clients?: { readonly hookApi?: HookApi | undefined } | undefined;
  /** The full-screen hooks view, where the product has one. */
  readonly openHooksView?: (() => void) | undefined;
}

const requireHookApi = (ctx: HooksCommandContext): HookApi => requireContextValue(ctx.clients?.hookApi, 'clients.hookApi');

const TERMINAL_ONLY = 'Managed hooks are kept in this machine\'s hooks file.';

const MANAGED_HOOKS = defineList<HooksCommandContext>({
  name: 'hooks.managed',
  async read(ctx) {
    const workbench = requireHookApi(ctx).workbench;
    return [
      ...workbench.listManagedHooks().flatMap(({ pattern, hook }): ListRow[] => hook.name ? [{ value: hook.name, label: hook.name, detail: `${pattern} (${hook.type})`, state: hook.enabled === false ? 'off' : 'on' }] : []),
      ...workbench.listManagedChains().map((chain): ListRow => ({ value: chain.name, label: chain.name, detail: `chain of ${chain.steps.length} step(s)` })),
    ];
  },
  operator: { terminalOnly: TERMINAL_ONLY },
});
const HOOK = listInput({ id: 'hook', label: 'Hook', help: 'The managed hooks and chains', list: MANAGED_HOOKS });
const FILE = textInput({ id: 'path', label: 'File', help: 'A hooks bundle file', why: 'a file path on this machine', kind: 'path', typed: { position: 1 } });
const HOOK_TYPES = [
  { value: 'command', label: 'Run a command' },
  { value: 'prompt', label: 'Ask the model' },
  { value: 'agent', label: 'Start an agent' },
  { value: 'http', label: 'Call a web address' },
  { value: 'ts', label: 'Run a TypeScript file' },
];

export function registerHooksCommand<Ctx extends HooksCommandContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>): void {
  registry.register(defineCommand<Ctx>({
    name: 'hooks',
    title: 'Hooks',
    summary: 'Run your own steps when things happen: before a tool runs, after a turn, and more',
    group: 'Extensions',
    report: 'contracts',
    firstScreenRows: [
      'contracts', 'open', 'scaffold', 'chain',
      { label: 'Switch a hook on or off, or remove it', actions: ['enable', 'disable', 'remove'] },
      { label: 'Try and move hooks', actions: ['simulate', 'reload', 'export', 'inspect', 'import'] },
    ],
    actions: [
      readAction<Ctx>({
        id: 'contracts', label: 'See the hook points and your hooks', word: 'contracts',
        inputs: [textInput({ id: 'filter', label: 'Only those about', help: 'Words to narrow the list', why: 'your own words', typed: { tail: true }, optional: { default: '', means: 'all of them' } })],
        sentence: 'Shows each hook point {filter}, what a hook there may do, and the managed hooks file.', example: { filter: 'tool' },
        async run(values, ctx) {
          const hookApi = requireHookApi(ctx);
          const workbench = hookApi.workbench;
          const filter = (values.filter ?? '').trim().toLowerCase();
          const contracts = await hookApi.contracts(filter);
          if (contracts.length === 0) return filter.length === 0 ? 'No hook contracts registered.' : `No hook contracts matched "${filter}".`;
          const lines: string[] = [`Hook Contracts (${contracts.length}):`];
          for (const contract of contracts) {
            // The decision model could not say whether this entry fits the filter; it is listed, marked, rather than dropped.
            lines.push(`  ${contract.pattern}${contract.unsure ? ' (unsure match)' : ''}`);
            lines.push(`    authority=${contract.authority} mode=${contract.executionMode} deny=${contract.canDeny ? 'yes' : 'no'} mutate=${contract.canMutateInput ? 'yes' : 'no'} inject=${contract.canInjectContext ? 'yes' : 'no'} timeout=${contract.timeoutMs}ms policy=${contract.failurePolicy}`);
            lines.push(`    ${contract.description}`);
          }
          lines.push('', `Managed hooks file: ${workbench.getFilePath()}`, `Managed entries: hooks=${workbench.listManagedHooks().length} chains=${workbench.listManagedChains().length}`);
          return lines.join('\n');
        },
      }),
      doAction<Ctx>({
        id: 'open', label: 'Open the hooks screen', word: 'open', touches: 'reads',
        sentence: 'Opens the full-screen view of hook points and managed hooks.', operator: { terminalOnly: 'It is a terminal screen.' },
        async run(_values, ctx) {
          if (!ctx.openHooksView) throw commandRefusal('This surface has no hooks screen.', '/hooks contracts lists the same.');
          ctx.openHooksView();
        },
      }),
      {
        id: 'scaffold', label: 'Make a hook', word: 'scaffold',
        inputs: [
          textInput({ id: 'name', label: 'Name', help: 'A short name you choose', why: 'a name you choose', typed: { position: 1 } }),
          textInput({ id: 'match', label: 'When it runs', help: 'The hook point it runs at, as /hooks contracts shows it (Pre:tool:exec)', why: 'a hook point pattern from /hooks contracts', typed: { position: 2 } }),
          { id: 'type', label: 'What it does', help: 'What the hook runs', kind: 'choice', choices: HOOK_TYPES, required: true, typed: { flag: '--type' } },
        ],
        sentence: 'A managed hook {name} of kind {type} that runs at {match} is added to the hooks file, switched on, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'remove',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { name: 'lint-before-commit', match: 'Pre:tool:exec', type: 'command' },
        async run(values, ctx) {
          const workbench = requireHookApi(ctx).workbench;
          const hook = await workbench.scaffoldHook(values.name!, values.match!, values.type as Parameters<typeof workbench.scaffoldHook>[2]);
          return `Made managed hook ${hook.name} at ${values.match} in ${workbench.getFilePath()}; fill in what it runs there.`;
        },
      },
      {
        id: 'chain', label: 'Make a chain of hook points', word: 'chain',
        inputs: [
          textInput({ id: 'name', label: 'Name', help: 'A short name you choose', why: 'a name you choose', typed: { position: 1 } }),
          textInput({ id: 'events', label: 'Hook points in order', help: 'Hook points, separated by commas', why: 'hook point patterns from /hooks contracts', typed: { position: 2 } }),
        ],
        sentence: 'A managed chain {name} over {events} is added to the hooks file until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'remove',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { name: 'review-then-commit', events: 'Post:turn:end,Pre:tool:exec' },
        async run(values, ctx) {
          const matches = values.events!.split(',').map((entry) => entry.trim()).filter(Boolean);
          if (matches.length === 0) throw commandRefusal('Give at least one hook point.');
          const chain = await requireHookApi(ctx).workbench.scaffoldChain(values.name!, matches);
          return `Made managed hook chain ${chain.name} with ${chain.steps.length} step(s).`;
        },
      },
      {
        id: 'enable', label: 'Switch a hook on', word: 'enable', inputs: [HOOK],
        sentence: '{hook} runs at its hook point again, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'disable',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { hook: 'lint-before-commit' },
        async run(values, ctx) {
          if (!(await requireHookApi(ctx).workbench.toggle(values.hook!, true))) throw commandRefusal(`No managed hook named ${values.hook}.`, '/hooks contracts lists the managed hooks file and its entries', 'NOT_FOUND');
          return `Switched on managed hook ${values.hook}.`;
        },
      },
      {
        id: 'disable', label: 'Switch a hook off', word: 'disable', inputs: [HOOK],
        sentence: '{hook} stops running at its hook point, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'enable',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { hook: 'lint-before-commit' },
        async run(values, ctx) {
          if (!(await requireHookApi(ctx).workbench.toggle(values.hook!, false))) throw commandRefusal(`No managed hook named ${values.hook}.`, '/hooks contracts lists the managed hooks file and its entries', 'NOT_FOUND');
          return `Switched off managed hook ${values.hook}.`;
        },
      },
      {
        id: 'remove', label: 'Remove a hook or chain', word: 'remove', inputs: [HOOK],
        sentence: 'The managed hook or chain {hook} is deleted from the hooks file; export first with /hooks export to keep a copy.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { hook: 'lint-before-commit' },
        async run(values, ctx) {
          if (!(await requireHookApi(ctx).workbench.remove(values.hook!))) throw commandRefusal(`No managed hook or chain named ${values.hook}.`, '/hooks contracts lists the managed hooks file and its entries', 'NOT_FOUND');
          return `Removed managed hook entry ${values.hook}.`;
        },
      },
      readAction<Ctx>({
        id: 'simulate', label: 'See which hooks an event would run', word: 'simulate',
        inputs: [textInput({ id: 'event', label: 'Event', help: 'An event path, such as Pre:tool:exec', why: 'an event path', typed: { position: 1 } })],
        sentence: 'Shows the hooks and chains that {event} would run; nothing runs.', example: { event: 'Pre:tool:exec' },
        async run(values, ctx) {
          const result = requireHookApi(ctx).workbench.simulate(values.event!);
          return [
            `Hook simulation for ${result.eventPath}`,
            `  matched hooks: ${result.matchedHooks.length}`,
            ...result.matchedHooks.map((entry) => `    ${entry.name}  ${entry.pattern}  ${entry.type}`),
            `  matched chains: ${result.matchedChains.length}`,
            ...result.matchedChains.map((entry) => `    ${entry.name}  stepMatches=${entry.stepMatches}`),
          ].join('\n');
        },
      }),
      doAction<Ctx>({
        id: 'reload', label: 'Read the hooks file again', word: 'reload',
        sentence: 'The managed hooks file is read again, so edits made by hand take effect now.', operator: { terminalOnly: TERMINAL_ONLY },
        async run(_values, ctx) {
          const workbench = requireHookApi(ctx).workbench;
          await workbench.reload();
          return `Read the managed hooks again from ${workbench.getFilePath()}`;
        },
      }),
      doAction<Ctx>({
        id: 'export', label: 'Save the hooks to a file', word: 'export',
        inputs: [{ ...FILE, help: 'Where to write the bundle', typed: { position: 1 }, required: { default: '', defaultMeans: 'the hooks file itself' } }],
        sentence: 'Every managed hook and chain is written to {path} as a bundle.', operator: { terminalOnly: TERMINAL_ONLY }, example: { path: 'hooks-bundle.json' },
        async run(values, ctx) {
          const workbench = requireHookApi(ctx).workbench;
          return `Saved the managed hooks to ${await workbench.export(values.path || workbench.getFilePath())}`;
        },
      }),
      readAction<Ctx>({
        id: 'inspect', label: 'Look inside a hooks bundle', word: 'inspect', inputs: [FILE],
        sentence: 'Shows how many hooks and chains {path} holds and their hook points; nothing is installed.', example: { path: 'hooks-bundle.json' },
        async run(values, ctx) {
          const inspection = requireHookApi(ctx).workbench.inspect(values.path!);
          return [`Hook bundle: ${inspection.path}`, `  hooks: ${inspection.hookCount}`, `  chains: ${inspection.chainCount}`, `  patterns: ${inspection.patterns.join(', ') || '(none)'}`].join('\n');
        },
      }),
      {
        id: 'import', label: 'Install hooks from a bundle', word: 'import',
        inputs: [FILE, {
          id: 'strategy', label: 'Your hooks now', help: 'Keep the hooks installed now, or replace them all', kind: 'choice',
          choices: [{ value: 'merge', label: 'Keep them and add the bundle\'s' }, { value: 'replace', label: 'Replace them all with the bundle\'s', risk: 'cannot-be-undone' }],
          required: { default: 'merge', defaultMeans: 'keep them' }, typed: { flag: '--strategy' },
        }],
        sentence: 'The hooks and chains in {path} are installed, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { path: 'hooks-bundle.json', strategy: 'replace' },
        async run(values, ctx) {
          const strategy = values.strategy === 'replace' ? 'replace' : 'merge';
          const rejected = await requireHookApi(ctx).workbench.import(values.path!, strategy);
          return [
            `Installed managed hooks from ${values.path} (${strategy === 'replace' ? 'replacing all' : 'kept the existing ones'}).${rejected.length > 0 ? ` ${rejected.length} entries in the bundle were left out:` : ''}`,
            ...rejected.map((reason) => `  - ${reason}`),
          ].join('\n');
        },
      },
    ],
  }));
}
