/**
 * `/permissions`, described once (command-actions/) for both terminal apps:
 * the permission settings in force and where each comes from, and the rules
 * that decide calls without asking (remembered answers and rules you add).
 * The work is the platform's (gate/policy/permissions-runtime.ts); each app
 * says where its rules are kept.
 */
import {
  addOwnerRule,
  revokeRememberedRule,
  showPermissionSettings,
  showRememberedRules,
  type PermissionsCommandContext,
} from '@goodvibes/engine/platform/platform/gate/policy';
import { describeModeInForceWords, modeInForceLine, type ModeInForceWords } from '@goodvibes/engine/platform/platform/permissions';
import type { TerminalCommandRegistry } from './command-registry.js';
import type { CommandReport } from './command-actions/types.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';
import { listInput, readAction, textInput } from './described-command-kit.js';

/** This app's rule store and settings, as the platform's permission functions read them. */
export type PermissionsDeps<Ctx> = (ctx: Ctx) => Omit<PermissionsCommandContext, 'print' | 'openSelection'>;

let depsOf: PermissionsDeps<unknown> | undefined;
const RULES = defineList<unknown>({
  name: 'permissions.rules',
  async read(ctx) {
    return (depsOf?.(ctx).ruleStore?.list() ?? []).map((record): ListRow => ({
      value: record.rule.id,
      label: `${record.tool === '*' ? 'any tool' : record.tool}: ${record.rule.description ?? record.rule.id}`,
      state: record.rule.effect,
    }));
  },
  operator: { method: 'permissions.rules.list', input: {}, rows: { from: 'rules', value: 'id', label: 'description', state: 'effect' } },
});

/**
 * The one step that puts the chosen mode in force, from why it is not: the
 * setting that fixes it, opened by its `/settings open` line.
 */
function causeFix(words: ModeInForceWords): { readonly sentence: string; readonly label: string; readonly line: string } | undefined {
  const because = words.because ?? '';
  if (because === 'no decision model set') return { sentence: 'No decision model is set up, so GoodVibes asks you itself.', label: 'Choose a decision model', line: '/settings open judgment.model' };
  if (because === 'decision models switched off') return { sentence: 'Decision models are switched off, so GoodVibes asks you itself.', label: 'Turn decision models on', line: '/settings open judgment.policy' };
  if (because === 'not measured yet') return { sentence: `${words.chosen} is only the default here and has not been measured on your decision model.`, label: `Choose ${words.chosen} yourself, or another mode`, line: '/settings open permissions.mode' };
  if (because === 'an old auto-approve setting is on') return { sentence: 'An old auto-approve setting runs everything without asking.', label: 'Choose a mode (this clears it)', line: '/settings open permissions.mode' };
  if (because.startsWith('decision model')) return { sentence: 'The decision model is not answering, so GoodVibes asks you itself.', label: 'Choose another decision model', line: '/settings open judgment.model' };
  return undefined;
}

/** What `/permissions mode` reports: the mode in force, why it differs from the choice, and the one fix. */
export function permissionModeReport(words: ModeInForceWords): CommandReport {
  const fix = words.inForce ? causeFix(words) : undefined;
  return {
    verdict: words.inForce ? 'attention' : 'ok',
    headline: `Permissions: ${modeInForceLine(words)}. ${words.sentence} To choose another mode: /settings open permissions.mode.`,
    items: fix ? [{ sentence: fix.sentence, fix: { label: fix.label, line: fix.line } }] : [],
  };
}

/** Register `/permissions` with where this app keeps its rules. */
export function registerPermissionsCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, deps: PermissionsDeps<Ctx>): void {
  depsOf = deps as PermissionsDeps<unknown>;
  const context = (ctx: Ctx): PermissionsCommandContext => ({ ...deps(ctx), print: (text) => ctx.print(text) });
  registry.register(defineCommand<Ctx>({
    name: 'permissions',
    title: 'Permissions',
    summary: 'See which permission settings are in force, and the rules that decide calls without asking',
    group: 'Permissions',
    report: 'mode',
    actions: [
      readAction<Ctx>({
        id: 'mode', label: 'See what GoodVibes asks you about now, and why', word: 'mode',
        sentence: 'Shows the permission mode in force, what it does, why it differs from the one you chose, and the setting that changes it.',
        readsOnlyThisMachine: true,
        rowValue: async (ctx) => modeInForceLine(describeModeInForceWords(deps(ctx).configManager)),
        async run(_values, ctx) { return permissionModeReport(describeModeInForceWords(deps(ctx).configManager)); },
      }),
      readAction<Ctx>({
        id: 'show', label: 'See the permission settings in force', word: 'show',
        sentence: 'Shows the permission mode and settings in force, where each comes from, and how many rules there are.',
        async run(_values, ctx) { showPermissionSettings(context(ctx)); },
      }),
      readAction<Ctx>({
        id: 'rules', label: 'See the permission rules', word: 'rules',
        sentence: 'Lists every rule that decides a call without asking: what it covers, allow or deny, and where.',
        async run(_values, ctx) { showRememberedRules(context(ctx)); },
      }),
      {
        id: 'never', label: 'Never run a command', word: 'never',
        inputs: [textInput({ id: 'command', label: 'Command', help: 'The command, as it starts (git push)', why: 'a command as you would type it', typed: { tail: true } })],
        sentence: 'Every tool is refused a command that runs "{command}", in every permission mode and every project, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'revoke',
        operator: { terminalOnly: 'A rule is added from a terminal app; the web UI can list and remove them.' }, example: { command: 'git push' },
        async run(values, ctx) { await addOwnerRule(context(ctx), ['never', ...values.command!.split(/\s+/)]); },
      },
      {
        id: 'add', label: 'Add a permission rule', word: 'add',
        inputs: [
          { id: 'effect', label: 'Then', help: 'What happens to a matching call', kind: 'choice', required: true, typed: { position: 1 },
            choices: [
              { value: 'allow', label: 'Run it without asking', risk: 'loosens-a-protection' },
              { value: 'ask', label: 'Ask me' },
              { value: 'deny', label: 'Refuse it' },
            ] },
          { id: 'kind', label: 'For', help: 'What the rule covers', kind: 'choice', required: true, typed: { position: 2 },
            choices: [
              { value: 'command', label: 'This exact command' },
              { value: 'class', label: 'Every command starting with a word' },
              { value: 'path', label: 'Writing and editing under a folder' },
              { value: 'tool', label: 'Every call of a tool' },
            ] },
          textInput({ id: 'target', label: 'Which', help: 'The command, word, folder or tool', why: 'a command, word, folder or tool name', typed: { tail: true } }),
        ],
        sentence: 'In this project, a call matching {kind} {target} will {effect} until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'revoke',
        operator: { terminalOnly: 'A rule for this project is added from the terminal app working in it.' }, example: { effect: 'deny', kind: 'class', target: 'rm' },
        async run(values, ctx) { await addOwnerRule(context(ctx), [values.effect!, values.kind!, values.target!]); },
      },
      {
        id: 'revoke', label: 'Remove a permission rule', word: 'revoke',
        inputs: [listInput({ id: 'rule', label: 'Rule', help: 'The rules in force', list: RULES })],
        sentence: '{rule} is removed, so a call it covered is decided as usual again (it may run, or be asked), until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        ownerOnly: { reason: 'a rule may be what stops a command from running', instead: 'Ask the owner to remove it with /permissions revoke.' },
        operator: { method: 'permissions.rules.delete', fields: { ruleId: 'rule' } }, example: { rule: 'owner-never-run-git-1' },
        async run(values, ctx) { await revokeRememberedRule(context(ctx), values.rule!); },
      },
    ],
  }));
}
