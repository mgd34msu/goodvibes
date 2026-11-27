/**
 * Hooks, managed by the daemon on the project's own hooks file (the file each
 * program's turns already read and fire from: `tools.hooksFile` resolved in
 * the project, default `<project>/hooks.json`). Firing a hook and reading the
 * file again before an event stay with each program that runs turns; a
 * change made here is read by that program before its next hook fires.
 *
 * The hook trace (hooks/trace.ts) is the daemon's one record of the hooks that
 * ran in every program: which, when, on what, and what each did.
 * `hooks.reload` is the one hooks capability of the program holding the
 * conversation: it reads the file again into that program's own dispatcher.
 */
import { resolve } from 'node:path';
import { currentRecordReach } from '@goodvibes/engine/daemon-api';
import { callerPathOf, fileWorkRefusal } from '../path-inputs.js';
import type { HookApi } from '../../hooks/hook-api.js';
import { HOOK_TRACE_PROGRAM_WORDS, hookRunOutcome, type HookTraceRecord } from '../../hooks/trace-words.js';
import { HooksFileAwaitingTrustError } from '../../hooks/workbench.js';
import { hookPatternProblem } from '../../hooks/contracts.js';
import type { HookType } from '../../hooks/types.js';
import { noteListChanged } from '../../runtime/list-changes.js';
import { projectIdentityOf } from '../../workspace/project-identity.js';
import { CapabilityRefusal, REPLACED_DONE, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';

/** What the hooks capabilities need: the hook API for the caller's project, and the hook trace. */
export interface HooksCapabilityServices {
  readonly hooks: {
    /** The hook API over the hooks file of the project at `workingDirectory` (the daemon's own when absent). */
    forProject(workingDirectory: string | undefined): HookApi;
    /** The hook trace, newest first; one project's runs when `project` is given. */
    trace(options: { readonly project?: string | undefined; readonly limit?: number | undefined }): readonly HookTraceRecord[];
    /** Add runs a terminal program posted (`hooks.trace.post`); answers how many were new. */
    record(runs: readonly HookTraceRecord[]): number;
  };
}

/** What `hooks.reload` needs: this program's own dispatcher and the file it reads. */
export interface HooksReloadServices {
  readonly hookFile: {
    /** Read the hooks file again into this program's dispatcher; answers the file read. */
    reload(): Promise<string>;
  };
}

/** The managed hooks, the entries that can be switched on or off (the terminal's list reads them from hooks.contracts). */
export const MANAGED_HOOKS_LIST = 'hooks.managed' as ListName;
/** The managed hooks and chains: the entries that can be removed. */
export const MANAGED_ENTRIES_LIST = 'hooks.managed-entries' as ListName;

const HOOK: InputDescription = {
  id: 'hook', label: 'Hook', help: 'The managed hooks', kind: 'choice', choices: { list: MANAGED_HOOKS_LIST }, required: true, typed: { position: 1 },
};
const ENTRY: InputDescription = {
  id: 'hook', label: 'Hook', help: 'The managed hooks and chains', kind: 'choice', choices: { list: MANAGED_ENTRIES_LIST }, required: true, typed: { position: 1 },
};
const NAME: InputDescription = {
  id: 'name', label: 'Name', help: 'A short name you choose', kind: 'text', freeTextReason: 'a name you choose', required: true, typed: { position: 1 },
};
const FILE: InputDescription = {
  id: 'path', label: 'File', help: 'A hooks bundle file', kind: 'path', freeTextReason: 'a file path on this machine', required: true, typed: { position: 1 },
};
const HOOK_TYPES: readonly FixedChoice[] = [
  { value: 'command', label: 'Run a command' },
  { value: 'prompt', label: 'Ask the model' },
  { value: 'agent', label: 'Start an agent' },
  { value: 'http', label: 'Call a web address' },
  { value: 'ts', label: 'Run a TypeScript file' },
];

function toggleRefusal(api: HookApi, name: string): CapabilityRefusal {
  if (api.workbench.listManagedChains().some((chain) => chain.name === name)) {
    return new CapabilityRefusal(`${name} is a chain; a chain cannot be switched on or off.`, 'Remove it to take it out of the hooks file.');
  }
  return new CapabilityRefusal(`No managed hook named ${name}.`, 'The Hooks list shows the managed hooks file and its entries.', 'NOT_FOUND');
}

function managedOf(api: HookApi) {
  return api.workbench.listManagedHooks().flatMap(({ pattern, hook }) => hook.name
    ? [{ name: hook.name, pattern, type: hook.type, enabled: hook.enabled !== false, state: hook.enabled === false ? 'off' : 'on', detail: `${pattern} (${hook.type})`, ...(hook.description ? { description: hook.description } : {}) }] : []);
}

/**
 * The file a path input names, as capabilities/path-inputs.ts places it for this caller: inside its checked project for
 * anyone but the person; a relative path with no project is refused.
 */
function pathOf(_api: HookApi, caller: CapabilityCaller, path: string): string {
  return callerPathOf(caller, path);
}

/**
 * Run a write; a folder not trusted yet keeps the file written but its hooks
 * from running, and that is said. Every screen showing the hooks is told the
 * file changed (LIST_CHANGED `tools`).
 */
async function written<T>(caller: CapabilityCaller, work: () => Promise<T>): Promise<{ readonly value: T | undefined; readonly held: boolean; readonly rejected: readonly string[] }> {
  // The hooks file is its project's: only that project's screens read again.
  const project = caller.workingDirectory ? { project: projectIdentityOf(caller.workingDirectory) } : {};
  try {
    const value = await work();
    noteListChanged({ list: 'tools', change: 'changed', ...project });
    return { value, held: false, rejected: [] };
  } catch (error) {
    if (!(error instanceof HooksFileAwaitingTrustError)) throw error;
    noteListChanged({ list: 'tools', change: 'changed', ...project });
    // An import carries what its bundle left out on the error (hook-api.ts).
    const rejected = (error as { readonly rejected?: unknown }).rejected;
    return { value: undefined, held: true, rejected: Array.isArray(rejected) ? rejected.filter((entry): entry is string => typeof entry === 'string') : [] };
  }
}

/** A hook point's problem in a person's words: the typed command it names becomes the list that shows the points. */
const pointWords = (problem: string): string => problem.replace(/;?\s*the Hook points tab of Tools and extensions lists them\.?$/, '').replace(/\.$/, '');

/** What a hook of each kind does, for a sentence. */
const HOOK_KIND_WORDS: Readonly<Record<string, string>> = { command: 'runs a command', prompt: 'asks a model', agent: 'starts an agent', http: 'calls an address', ts: 'runs a script' };
const HELD_WORDS =' This folder is not trusted yet, so its hooks run nothing until you trust it (Permissions and safety, Trust this folder).';

export const HOOKS_CONTRACTS: CapabilityDefinition<HooksCapabilityServices> = {
  capability: { id: 'hooks.contracts', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'contracts', label: 'See the hook points and your hooks', word: 'contracts',
  inputs: [{ id: 'filter', label: 'Only those about', help: 'Words to narrow the list', kind: 'text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'all of them' }, typed: { tail: true } }],
  sentence: 'Shows each hook point {filter}, what a hook there may do, and the managed hooks file.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { filter: 'tool' },
  async run(values, services, caller) {
    const api = services.hooks.forProject(caller.workingDirectory);
    const workbench = api.workbench;
    workbench.load();
    const filter = (values.filter ?? '').trim().toLowerCase();
    const contracts = await api.contracts(filter);
    const managed = managedOf(api);
    const chains = workbench.listManagedChains().map((chain) => ({ name: chain.name, steps: chain.steps.length, points: chain.steps.map((step) => step.match), ...(chain.description ? { description: chain.description } : {}) }));
    const data = {
      file: workbench.getFilePath(), managed, chains,
      // Every entry that can be removed: the managed hooks, then the chains.
      entries: [...managed.map((hook) => ({ name: hook.name, detail: hook.detail, state: hook.state })),
        ...chains.map((chain) => ({ name: chain.name, detail: `chain of ${chain.steps} step${chain.steps === 1 ? '' : 's'}`, state: 'chain' }))],
      contracts: contracts.map((contract) => contract.pattern),
      points: contracts.map((contract) => ({
        pattern: contract.pattern, description: contract.description, authority: contract.authority, mode: contract.executionMode,
        canDeny: contract.canDeny, canChangeInput: contract.canMutateInput, canAddContext: contract.canInjectContext, failure: contract.failurePolicy,
      })),
    };
    if (contracts.length === 0) return { text: filter.length === 0 ? 'No hook contracts registered.' : `No hook contracts matched "${filter}".`, data };
    const lines: string[] = [`Hook Contracts (${contracts.length}):`];
    for (const contract of contracts) {
      // The decision model could not say whether this entry fits the filter; it is listed, marked, rather than dropped.
      lines.push(`  ${contract.pattern}${contract.unsure ? ' (unsure match)' : ''}`);
      lines.push(`    authority=${contract.authority} mode=${contract.executionMode} deny=${contract.canDeny ? 'yes' : 'no'} mutate=${contract.canMutateInput ? 'yes' : 'no'} inject=${contract.canInjectContext ? 'yes' : 'no'} policy=${contract.failurePolicy}`);
      lines.push(`    ${contract.description}`);
    }
    lines.push('Each hook runs under its own "timeout" (default 30 s, 60 s for an agent hook).');
    lines.push('', `Managed hooks file: ${workbench.getFilePath()}`, `Managed entries: hooks=${managed.length} chains=${chains.length}`);
    return { text: lines.join('\n'), data };
  },
};

function toggle(enabled: boolean): CapabilityDefinition<HooksCapabilityServices> {
  return {
    capability: { id: enabled ? 'hooks.enable' : 'hooks.disable', group: 'tools', home: 'daemon', repeat: 'safe' },
    actionId: enabled ? 'enable' : 'disable', label: enabled ? 'Switch a hook on' : 'Switch a hook off', word: enabled ? 'enable' : 'disable',
    inputs: [HOOK],
    sentence: enabled ? 'The hook {hook} is switched back on and runs at its hook point again, until you change it.' : 'The hook {hook} is switched off and stops running at its hook point, until you change it.', done: '',
    // Switching a hook on makes what it runs (a command, a script, an agent, a call) run by itself at its hook point,
    // outside the command gate and the sandbox: it loosens a protection. Switching one off does not.
    touches: 'this-machine', lasts: 'kept', risk: enabled ? 'loosens-a-protection' : 'none', undoneBy: enabled ? 'disable' : 'enable', example: { hook: 'lint-before-commit' },
    async run(values, services, caller) {
      const api = services.hooks.forProject(caller.workingDirectory);
      const name = values.hook!;
      const { value, held } = await written(caller, () => api.workbench.toggle(name, enabled));
      // The file was written when the folder is only waiting on trust.
      if (!held && !value) throw toggleRefusal(api, name);
      return {
        text: `Switched ${enabled ? 'on' : 'off'} managed hook ${name}.${held ? HELD_WORDS : ''}`,
        data: { hook: name, enabled, file: api.workbench.getFilePath(), ...(held ? { awaitingTrust: true } : {}) },
      };
    },
  };
}

export const HOOKS_ENABLE = toggle(true);
export const HOOKS_DISABLE = toggle(false);

export const HOOKS_SCAFFOLD: CapabilityDefinition<HooksCapabilityServices> = {
  capability: { id: 'hooks.scaffold', group: 'tools', home: 'daemon', repeat: 'unsafe' },
  actionId: 'scaffold', label: 'Make a hook', word: 'scaffold',
  inputs: [
    NAME,
    { id: 'match', label: 'When it runs', help: 'The hook point it runs at, as the Hook points list names it (Pre:tool:exec)', kind: 'text', freeTextReason: 'a hook point pattern', required: true, typed: { position: 2 } },
    { id: 'type', label: 'What it does', help: 'What the hook runs', kind: 'choice', choices: HOOK_TYPES, required: true, typed: { flag: '--type' } },
  ],
  sentence: 'A managed hook {name} of kind {type} that runs at {match} is added to the hooks file, switched off until you fill in what it runs and switch it on.', done: '',
  // A hook added to the hooks file is a thing that runs by itself later (once filled in and switched on): it loosens a protection.
  touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'remove', example: { name: 'lint-before-commit', match: 'Pre:tool:exec', type: 'command' },
  async run(values, services, caller) {
    const api = services.hooks.forProject(caller.workingDirectory);
    const name = values.name!.trim();
    if (!name) throw new CapabilityRefusal('Give the hook a name.');
    if (managedOf(api).some((hook) => hook.name === name) || api.workbench.listManagedChains().some((chain) => chain.name === name)) {
      throw new CapabilityRefusal(`A managed hook or chain named ${name} is already in the hooks file; nothing was added.`, 'Choose another name, or change that one.');
    }
    const point = values.match!.trim();
    const problem = hookPatternProblem(point);
    if (problem) throw new CapabilityRefusal(`Nothing was added: ${pointWords(problem)}.`, 'The Hook points list names every point a hook can run at.');
    const { held } = await written(caller, () => api.workbench.scaffoldHook(name, point, values.type as HookType));
    return {
      text: `Made managed hook ${name} at ${values.match} in ${api.workbench.getFilePath()}; fill in what it runs there, then switch it on.${held ? HELD_WORDS : ''}`,
      data: { hook: name, point: values.match, type: values.type, file: api.workbench.getFilePath(), enabled: false, ...(held ? { awaitingTrust: true } : {}) },
    };
  },
};

export const HOOKS_CHAIN: CapabilityDefinition<HooksCapabilityServices> = {
  capability: { id: 'hooks.chain', group: 'tools', home: 'daemon', repeat: 'unsafe' },
  actionId: 'chain', label: 'Make a chain of hook points', word: 'chain',
  inputs: [
    NAME,
    { id: 'events', label: 'Hook points in order', help: 'Hook points, separated by commas', kind: 'text', freeTextReason: 'hook point patterns', required: true, typed: { position: 2 } },
  ],
  sentence: 'A managed chain {name} over {events} is added to the hooks file until you change it.', done: '',
  // A chain runs its action by itself when its hook points fire in order: it loosens a protection.
  touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'remove', example: { name: 'review-then-commit', events: 'Post:turn:end,Pre:tool:exec' },
  async run(values, services, caller) {
    const api = services.hooks.forProject(caller.workingDirectory);
    const name = values.name!.trim();
    const matches = values.events!.split(',').map((entry) => entry.trim()).filter(Boolean);
    if (matches.length === 0) throw new CapabilityRefusal('Give at least one hook point.');
    const problem = matches.map((match) => hookPatternProblem(match)).find((found) => found !== null);
    if (problem) throw new CapabilityRefusal(`Nothing was added: ${pointWords(problem)}.`, 'The Hook points list names every point a hook can run at.');
    if (managedOf(api).some((hook) => hook.name === name) || api.workbench.listManagedChains().some((chain) => chain.name === name)) {
      throw new CapabilityRefusal(`A managed hook or chain named ${name} is already in the hooks file; nothing was added.`, 'Choose another name, or change that one.');
    }
    const { held } = await written(caller, () => api.workbench.scaffoldChain(name, matches));
    return {
      text: `Made managed hook chain ${name} with ${matches.length} step${matches.length === 1 ? '' : 's'}.${held ? HELD_WORDS : ''}`,
      data: { chain: name, points: matches, file: api.workbench.getFilePath(), ...(held ? { awaitingTrust: true } : {}) },
    };
  },
};

export const HOOKS_REMOVE: CapabilityDefinition<HooksCapabilityServices> = {
  capability: { id: 'hooks.remove', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'remove', label: 'Remove a hook or chain', word: 'remove', inputs: [ENTRY],
  sentence: 'The managed hook or chain {hook} is deleted from the hooks file; save the hooks to a file first to keep a copy.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { hook: 'lint-before-commit' },
  async run(values, services, caller) {
    const api = services.hooks.forProject(caller.workingDirectory);
    const { value, held } = await written(caller, () => api.workbench.remove(values.hook!));
    if (!held && !value) throw new CapabilityRefusal(`No managed hook or chain named ${values.hook}.`, 'The Hooks list shows the managed hooks file and its entries.', 'NOT_FOUND');
    return { text: `Removed managed hook entry ${values.hook}.${held ? HELD_WORDS : ''}`, data: { hook: values.hook, file: api.workbench.getFilePath() } };
  },
};

export const HOOKS_SIMULATE: CapabilityDefinition<HooksCapabilityServices> = {
  capability: { id: 'hooks.simulate', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'simulate', label: 'See which hooks an event would run', word: 'simulate',
  inputs: [{ id: 'event', label: 'Event', help: 'An event path, such as Pre:tool:exec', kind: 'text', freeTextReason: 'an event path', required: true, typed: { position: 1 } }],
  sentence: 'Shows the hooks and chains that {event} would run; nothing runs.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { event: 'Pre:tool:exec' },
  async run(values, services, caller) {
    const result = services.hooks.forProject(caller.workingDirectory).workbench.simulate(values.event!.trim());
    return {
      // Said in sentences: what would run at this point, nothing run.
      text: [
        result.matchedHooks.length === 0 && result.matchedChains.length === 0
          ? `Nothing would run at ${result.eventPath}: no hook or chain matches it.`
          : `At ${result.eventPath}, ${result.matchedHooks.length} hook${result.matchedHooks.length === 1 ? '' : 's'} and ${result.matchedChains.length} chain${result.matchedChains.length === 1 ? '' : 's'} would run; nothing was run.`,
        ...result.matchedHooks.map((entry) => `Hook ${entry.name} (${entry.pattern}, ${HOOK_KIND_WORDS[entry.type] ?? entry.type}).`),
        ...result.matchedChains.map((entry) => `Chain ${entry.name} (${entry.stepMatches} of its steps match).`),
      ].join('\n'),
      data: { event: result.eventPath, hooks: result.matchedHooks.map((entry) => ({ ...entry })), chains: result.matchedChains.map((entry) => ({ ...entry })) },
    };
  },
};

export const HOOKS_EXPORT: CapabilityDefinition<HooksCapabilityServices> = {
  capability: { id: 'hooks.export', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'export', label: 'Save the hooks to a file', word: 'export',
  inputs: [{ ...FILE, file: 'written', help: 'Where to write the bundle', required: { default: '', defaultMeans: 'the hooks file itself' } }],
  sentence: 'Every managed hook and chain is written to {path} as a bundle: a copy to back up, or to move to another machine.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { path: 'hooks-bundle.json' },
  // Written only inside the caller's project (path-inputs.ts, at every door and here); the person may name any place himself.
  async run(values, services, caller) {
    const api = services.hooks.forProject(caller.workingDirectory);
    const target = values.path ? pathOf(api, caller, values.path) : api.workbench.getFilePath();
    const saved = await api.workbench.export(target);
    return { text: `Saved the managed hooks to ${saved}`, data: { path: saved } };
  },
};

export const HOOKS_INSPECT: CapabilityDefinition<HooksCapabilityServices> = {
  capability: { id: 'hooks.inspect', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'inspect', label: 'Look inside a hooks bundle', word: 'inspect', inputs: [FILE],
  sentence: 'Shows how many hooks and chains {path} holds and their hook points; nothing is installed.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { path: 'hooks-bundle.json' },
  // A read with no risk runs for any caller without a question, so it reads only inside the caller's checked project.
  async run(values, services, caller) {
    const api = services.hooks.forProject(caller.workingDirectory);
    const source = pathOf(api, caller, values.path!);
    let inspection;
    try {
      inspection = api.workbench.inspect(source);
    } catch (error) {
      // Never the parser's words: they quote the file (path-inputs.ts).
      throw fileWorkRefusal(values.path!, 'a hooks bundle', caller, error, 'Nothing was read from it.');
    }
    return {
      text: [`Hook bundle: ${inspection.path}`, `  hooks: ${inspection.hookCount}`, `  chains: ${inspection.chainCount}`, `  patterns: ${inspection.patterns.join(', ') || '(none)'}`].join('\n'),
      data: { path: inspection.path, hooks: inspection.hookCount, chains: inspection.chainCount, points: [...inspection.patterns] },
    };
  },
};

export const HOOKS_IMPORT: CapabilityDefinition<HooksCapabilityServices> = {
  capability: { id: 'hooks.import', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'import', label: 'Install hooks from a bundle', word: 'import',
  inputs: [FILE, {
    id: 'strategy', label: 'Your hooks now', help: 'Keep the hooks installed now, or replace them all', kind: 'choice',
    choices: [{ value: 'merge', label: 'Keep them and add the bundle\'s' }, { value: 'replace', label: 'Replace them all with the bundle\'s', risk: 'cannot-be-undone', riskDone: REPLACED_DONE }],
    required: { default: 'merge', defaultMeans: 'keep them' }, typed: { flag: '--strategy' },
  }],
  sentence: 'The hooks and chains in {path} are installed, until you change it.', done: '',
  // Installing hooks makes what they run (commands, scripts, agents, calls) run by itself at their hook points, outside
  // the command gate and the sandbox: it loosens a protection, asked of the owner and opening on No.
  touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', example: { path: 'hooks-bundle.json', strategy: 'replace' },
  async run(values, services, caller) {
    const api = services.hooks.forProject(caller.workingDirectory);
    const strategy = values.strategy === 'replace' ? 'replace' : 'merge';
    const source = pathOf(api, caller, values.path!);
    let outcome;
    try {
      outcome = await written(caller, () => api.workbench.import(source, strategy));
    } catch (error) {
      throw fileWorkRefusal(values.path!, 'a hooks bundle', caller, error, 'Nothing was installed.');
    }
    const rejected = (outcome.value ?? outcome.rejected).map(pointWords);
    return {
      text: [
        `Installed managed hooks from ${values.path} (${strategy === 'replace' ? 'replacing all' : 'kept the existing ones'}).${rejected.length > 0 ? ` ${rejected.length} entries in the bundle were left out:` : ''}${outcome.held ? HELD_WORDS : ''}`,
        ...rejected.map((reason) => `  - ${reason}`),
      ].join('\n'),
      data: { path: source, strategy, leftOut: [...rejected] },
    };
  },
};

export const HOOKS_TRACE: CapabilityDefinition<HooksCapabilityServices> = {
  capability: { id: 'hooks.trace', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'trace', label: 'See which hooks ran and what each did', word: 'trace',
  inputs: [{ id: 'limit', label: 'How many', help: 'How many of the latest runs to show', kind: 'number', freeTextReason: 'a whole number', required: { default: '20', defaultMeans: 'the latest 20' }, typed: { flag: '--limit' } }],
  sentence: 'Shows the latest {limit} hook runs in this project: which hook ran, when, on what, in which program, and what it did (let it go on, refused it, changed its input, failed).', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { limit: '20' },
  async run(values, services, caller) {
    const asked = Number.parseInt(values.limit || '20', 10);
    if (!Number.isFinite(asked) || asked < 1) throw new CapabilityRefusal(`How many: "${values.limit}" is not a whole number from 1.`);
    // A caller that is not the owner himself: only runs of a project it may reach, or of none, before the latest are cut.
    const reach = currentRecordReach();
    const project = caller.workingDirectory ? { project: resolve(caller.workingDirectory) } : {};
    const runs = reach
      ? services.hooks.trace({ ...project, limit: Number.MAX_SAFE_INTEGER }).filter((run) => run.project === undefined || reach('project', run.project)).slice(0, asked)
      : services.hooks.trace({ ...project, limit: asked });
    const data = { runs: runs.map((run) => ({ ...run, did: hookRunOutcome(run) })) };
    if (runs.length === 0) return { text: 'No hook has run here yet.', data };
    return {
      text: [
        `Hook runs (${runs.length}, newest first):`,
        ...runs.map((run) => `  ${new Date(run.at).toISOString().slice(0, 19).replace('T', ' ')}  ${run.hook} at ${run.point}${run.on ? ` on ${run.on}` : ''} in ${HOOK_TRACE_PROGRAM_WORDS[run.program]}: ${hookRunOutcome(run)} (${run.durationMs} ms)`),
      ].join('\n'),
      data,
    };
  },
};

export const HOOKS_RELOAD: CapabilityDefinition<HooksReloadServices> = {
  capability: { id: 'hooks.reload', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'reload', label: 'Read the hooks file again', word: 'reload', inputs: [],
  sentence: 'This program reads the managed hooks file again, so edits made by hand take effect now.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    let file: string;
    try {
      file = await services.hookFile.reload();
    } catch (error) {
      if (error instanceof HooksFileAwaitingTrustError) throw new CapabilityRefusal(`${error.path} is in a folder you have not trusted, so its hooks run nothing.`, 'Trust this folder in Permissions and safety to load them.');
      throw new CapabilityRefusal(`The hooks file was not read again: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { text: `Read the managed hooks again from ${file}`, data: { file } };
  },
};
