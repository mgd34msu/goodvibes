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
import type { TerminalCommandRegistry } from './command-registry.js';
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

/** Register `/permissions` with where this app keeps its rules. */
export function registerPermissionsCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, deps: PermissionsDeps<Ctx>): void {
  depsOf = deps as PermissionsDeps<unknown>;
  const context = (ctx: Ctx): PermissionsCommandContext => ({ ...deps(ctx), print: (text) => ctx.print(text) });
  registry.register(defineCommand<Ctx>({
    name: 'permissions',
    title: 'Permissions',
    summary: 'See which permission settings are in force, and the rules that decide calls without asking',
    group: 'Permissions',
    report: 'show',
    actions: [
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
