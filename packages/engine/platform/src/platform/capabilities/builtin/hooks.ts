/**
 * Hooks, managed by the daemon on the project's own hooks file (the file each
 * program's turns already read and fire from: `tools.hooksFile` resolved in
 * the project, default `<project>/hooks.json`). Firing a hook and reading the
 * file again before an event stay with each program that runs turns; a
 * change made here is read by that program before its next hook fires.
 */
import type { HookApi } from '../../hooks/hook-api.js';
import { HooksFileAwaitingTrustError } from '../../hooks/workbench.js';
import { CapabilityRefusal, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';

/** What the hooks capabilities need: the hook API for the caller's project. */
export interface HooksCapabilityServices {
  readonly hooks: {
    /** The hook API over the hooks file of the project at `workingDirectory` (the daemon's own when absent). */
    forProject(workingDirectory: string | undefined): HookApi;
  };
}

/** The managed hooks, the entries that can be switched on or off (the terminal's list reads them from hooks.contracts). */
export const MANAGED_HOOKS_LIST = 'hooks.managed' as ListName;

const HOOK: InputDescription = {
  id: 'hook', label: 'Hook', help: 'The managed hooks', kind: 'choice', choices: { list: MANAGED_HOOKS_LIST }, required: true, typed: { position: 1 },
};

function toggleRefusal(api: HookApi, name: string): CapabilityRefusal {
  if (api.workbench.listManagedChains().some((chain) => chain.name === name)) {
    return new CapabilityRefusal(`${name} is a chain; a chain cannot be switched on or off.`, `/hooks remove ${name} takes it out of the hooks file`);
  }
  return new CapabilityRefusal(`No managed hook named ${name}.`, '/hooks contracts lists the managed hooks file and its entries', 'NOT_FOUND');
}

function managedOf(api: HookApi) {
  return api.workbench.listManagedHooks().flatMap(({ pattern, hook }) => hook.name
    ? [{ name: hook.name, pattern, type: hook.type, enabled: hook.enabled !== false, state: hook.enabled === false ? 'off' : 'on', detail: `${pattern} (${hook.type})` }] : []);
}

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
    const chains = workbench.listManagedChains().map((chain) => ({ name: chain.name, steps: chain.steps.length }));
    const data = { file: workbench.getFilePath(), managed, chains, contracts: contracts.map((contract) => contract.pattern) };
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
    sentence: enabled ? '{hook} runs at its hook point again, until you change it.' : '{hook} stops running at its hook point, until you change it.', done: '',
    touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: enabled ? 'disable' : 'enable', example: { hook: 'lint-before-commit' },
    async run(values, services, caller) {
      const api = services.hooks.forProject(caller.workingDirectory);
      const name = values.hook!;
      let held = false;
      try {
        if (!(await api.workbench.toggle(name, enabled))) throw toggleRefusal(api, name);
      } catch (error) {
        // The file was written; a folder not trusted yet only keeps its hooks from running until it is.
        if (!(error instanceof HooksFileAwaitingTrustError)) throw error;
        held = true;
      }
      return {
        text: `Switched ${enabled ? 'on' : 'off'} managed hook ${name}.${held ? ' This folder is not trusted yet, so its hooks run nothing until you trust it (/security trust-folder).' : ''}`,
        data: { hook: name, enabled, file: api.workbench.getFilePath(), ...(held ? { awaitingTrust: true } : {}) },
      };
    },
  };
}

export const HOOKS_ENABLE = toggle(true);
export const HOOKS_DISABLE = toggle(false);
