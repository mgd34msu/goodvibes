/**
 * Permissions: what GoodVibes asks you about now and why, the permission
 * settings in force (both the program holding the conversation's: its mode in
 * force is this conversation's), and the rules that decide a call without
 * asking. The rules are one file every program and the daemon read
 * (`~/.goodvibes/shared/permission-rules.json`); adding one is done by the
 * daemon, and each program's gate takes the change in on its next check.
 * Listing and removing a rule run through the daemon's own methods
 * (`permissions.rules.list`, `permissions.rules.delete`).
 */
import { basename } from 'node:path';
import { ownerRuleRecord } from '../../gate/policy/permissions-runtime.js';
import { modeInForceLine, type ModeInForceWords } from '../../permissions/decision-model-readiness.js';
import { projectIdentity, type UserPermissionRuleStore } from '../../permissions/user-rule-store.js';
import { summarizeError } from '../../utils/native-error-summary.js';
import { CapabilityRefusal, type CapabilityDefinition, type InputDescription } from '../types.js';

/** What adding a rule (and placing a carried one) needs: the one rule store. */
export interface PermissionRulesCapabilityServices {
  readonly permissionRules: Pick<UserPermissionRuleStore, 'add'> & Partial<Pick<UserPermissionRuleStore, 'list'>>;
}

/** What the two reads of this conversation's permissions need, from the program holding it. */
export interface PermissionsSessionServices {
  readonly permissionsHere?: {
    /** The mode in force in this conversation, and why it differs from the one chosen. */
    modeWords(): ModeInForceWords;
    /** The permission settings in force here and where each comes from, in lines. */
    settingsInForce(): string;
    /** How many permission rules are in effect. */
    ruleCount(): number;
  } | undefined;
}

/** The one step that puts the chosen mode in force, from why it is not. */
function causeOf(words: ModeInForceWords): string | undefined {
  const because = words.because ?? '';
  if (because === 'no decision model set') return 'No decision model is set up, so GoodVibes asks you itself. Choose one in Settings: /settings open judgment.model.';
  if (because === 'not measured yet') return `${words.chosen} is only the default here and has not been measured on your decision model. Choose it yourself, or another mode, in Settings: /settings open permissions.mode.`;
  if (because === 'an old auto-approve setting is on') return 'An old auto-approve setting runs everything without asking. Choosing a mode in Settings clears it: /settings open permissions.mode.';
  if (because.startsWith('decision model')) return 'The decision model is not answering, so GoodVibes asks you itself. Choose another in Settings: /settings open judgment.model.';
  return undefined;
}

/** "Permissions: <mode in force>. <what it does>" and, when it differs from the choice, the one step that fixes it. */
export function permissionModeWords(words: ModeInForceWords): string {
  const cause = words.inForce ? causeOf(words) : undefined;
  return [
    `Permissions: ${modeInForceLine(words)}. ${words.sentence}`,
    ...(cause ? [cause] : []),
    'Change it in Settings, When GoodVibes asks: /settings open permissions.mode.',
  ].join('\n');
}

function here(services: PermissionsSessionServices): NonNullable<PermissionsSessionServices['permissionsHere']> {
  if (!services.permissionsHere) throw new CapabilityRefusal('This program has no permission settings to show.');
  return services.permissionsHere;
}

export const PERMISSIONS_MODE: CapabilityDefinition<PermissionsSessionServices> = {
  capability: { id: 'permissions.mode', group: 'safety', home: 'session', repeat: 'safe' },
  actionId: 'mode', label: 'See what GoodVibes asks you about now, and why', word: 'mode', inputs: [],
  sentence: 'Shows the permission mode in force: what GoodVibes asks you before it runs a command or changes a file, why it differs from the one you chose, and the setting that changes it.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const words = here(services).modeWords();
    return { text: permissionModeWords(words), data: { chosen: words.chosen, ...(words.inForce ? { inForce: words.inForce } : {}), ...(words.because ? { because: words.because } : {}), line: modeInForceLine(words) } };
  },
};

export const PERMISSIONS_SHOW: CapabilityDefinition<PermissionsSessionServices> = {
  capability: { id: 'permissions.show', group: 'safety', home: 'session', repeat: 'safe' },
  actionId: 'show', label: 'See the permission settings in force', word: 'show', inputs: [],
  sentence: 'Shows the permission mode and settings in force, where each comes from, and how many rules there are.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const permissions = here(services);
    const count = permissions.ruleCount();
    return {
      text: [
        permissions.settingsInForce(),
        '',
        count > 0 ? `${count} permission rule${count === 1 ? '' : 's'} in effect.` : 'No permission rules.',
      ].join('\n'),
      data: { rules: count },
    };
  },
};

async function addRule(services: PermissionRulesCapabilityServices, args: readonly string[], projectRoot: string | null): Promise<{ text: string; data: Record<string, unknown> }> {
  const record = ownerRuleRecord(args, projectRoot, Date.now());
  if (typeof record === 'string') {
    // The typed form's usage is no help to a form or a model: the reason in one line.
    const reason = record.startsWith('Usage:') ? 'that rule cannot be made from what was given' : record;
    throw new CapabilityRefusal(`No rule was added: ${reason}`);
  }
  try {
    await services.permissionRules.add(record);
  } catch (error) {
    throw new CapabilityRefusal(`No rule was added: ${summarizeError(error)}`);
  }
  const text = record.tier === 'never-run'
    ? `Added: ${record.rule.description}. Every tool that can reach a shell is refused a command that runs it, in every permission mode, YOLO included, in every project.`
    // The project by its folder's name: a whole path is a long unbroken run a screen's outcome line leaves out.
    : `Added: ${record.rule.description}, in this project (${basename(record.project ?? '') || 'this folder'}).`;
  return { text, data: { rule: record.rule.id, effect: record.rule.effect, tier: record.tier, ...(record.project !== undefined ? { project: record.project } : {}) } };
}

const COMMAND_INPUT: InputDescription = {
  id: 'command', label: 'Command', help: 'The command, as it starts (git push)', kind: 'text',
  freeTextReason: 'a command as you would type it', required: true, typed: { tail: true },
};

export const PERMISSIONS_NEVER: CapabilityDefinition<PermissionRulesCapabilityServices> = {
  capability: { id: 'permissions.never', group: 'safety', home: 'daemon', repeat: 'unsafe' },
  actionId: 'never', label: 'Never run a command', word: 'never', inputs: [COMMAND_INPUT],
  sentence: 'Every tool is refused a command that runs "{command}", in every permission mode and every project, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'revoke', tightens: true, example: { command: 'git push' },
  async run(values, services) {
    return addRule(services, ['never', ...values.command!.trim().split(/\s+/)], null);
  },
};

export const PERMISSIONS_ADD: CapabilityDefinition<PermissionRulesCapabilityServices> = {
  capability: { id: 'permissions.add', group: 'safety', home: 'daemon', repeat: 'unsafe' },
  actionId: 'add', label: 'Add a permission rule: always allow, ask or refuse', word: 'add',
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
    { id: 'target', label: 'Which', help: 'The command, word, folder or tool', kind: 'text', freeTextReason: 'a command, word, folder or tool name', required: true, typed: { tail: true } },
  ],
  sentence: 'In this project, a call matching {kind} {target} will {effect} until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'revoke',
  // A rule that refuses or asks only tightens; one that runs a call without asking loosens (its choice's risk).
  tightens: { input: 'effect', values: ['deny', 'ask'] }, example: { effect: 'deny', kind: 'class', target: 'rm' },
  async run(values, services, caller) {
    // A project rule is scoped to the folder of the program that asked.
    if (!caller.workingDirectory) throw new CapabilityRefusal('No rule was added: no project folder was given to scope it to.', 'A rule that refuses a command everywhere needs none: "Never run a command".');
    return addRule(services, [values.effect!, values.kind!, values.target!.trim()], caller.workingDirectory);
  },
};

/** The rules in force (safety-methods.ts PERMISSION_RULES_LIST_NAME); a carried one (permissions/daemon-folder-rules-notice.ts) is placed from its row. */
const RULES_IN_FORCE_LIST = 'permissions.rules' as import('../types.js').ListName;

export const PERMISSIONS_PLACE: CapabilityDefinition<PermissionRulesCapabilityServices> = {
  capability: { id: 'permissions.place', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'place', label: 'Keep a carried rule for this project only', word: 'place',
  inputs: [{ id: 'rule', label: 'Rule', help: 'The rules carried from 3.5.0 to every project', kind: 'choice', choices: { list: RULES_IN_FORCE_LIST }, required: true, typed: { position: 1 } }],
  sentence: '{rule}, carried from 3.5.0 to every project, will apply in this project only, until you change it.', done: '',
  // It narrows where a refusal applies: in every other project the calls it refused are decided as usual again.
  touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'revoke',
  ownerOnly: { reason: 'it stops a rule refusing calls in every other project', instead: 'Ask the owner to place it under Permissions and safety, Rules.' },
  example: { rule: 'user-exact-exec-mwwdnn58-8d7p7m' },
  async run(values, services, caller) {
    if (!caller.workingDirectory) throw new CapabilityRefusal('Nothing was changed: no project folder was given to keep the rule for.', 'Choose it from the project it belongs to.');
    const list = services.permissionRules.list;
    if (!list) throw new CapabilityRefusal('This program cannot read the permission rules; nothing was changed.', undefined, 'UNAVAILABLE');
    const record = list().find((entry) => entry.rule.id === values.rule && entry.carried !== undefined);
    if (!record) throw new CapabilityRefusal(`No rule carried from 3.5.0 has the id ${values.rule}; nothing was changed.`, '"See the permission rules" lists them under "Every project (carried from 3.5.0)".', 'NOT_FOUND');
    const { carried: _carried, ...placed } = record;
    try {
      await services.permissionRules.add({ ...placed, project: projectIdentity(caller.workingDirectory) });
      // A refusal (or an ask) also stays where 3.5.0 reads it, every project as before, for a 3.5.0 daemon put back; this
      // version never reads that copy (user-rule-store.ts `keptFor`) and it goes with the rule. An allow is never carried.
      if (record.rule.effect !== 'allow') {
        const { project: _none, ...everywhere } = placed;
        await services.permissionRules.add({ ...everywhere, rule: { ...record.rule, id: `${record.rule.id}~3.5.0` }, keptFor: { release: '3.5.0', of: record.rule.id } });
      }
    } catch (error) {
      throw new CapabilityRefusal(`Nothing was changed: ${summarizeError(error)}`);
    }
    return { text: `${record.rule.description ?? record.rule.id} now applies in ${basename(caller.workingDirectory)} only.`, data: { rule: record.rule.id, project: projectIdentity(caller.workingDirectory) } };
  },
};
