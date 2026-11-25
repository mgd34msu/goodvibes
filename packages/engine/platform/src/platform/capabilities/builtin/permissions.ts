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
import type { UserPermissionRuleStore } from '../../permissions/user-rule-store.js';
import { summarizeError } from '../../utils/native-error-summary.js';
import { CapabilityRefusal, type CapabilityDefinition, type InputDescription } from '../types.js';

/** What adding a rule needs: the one rule store. */
export interface PermissionRulesCapabilityServices {
  readonly permissionRules: Pick<UserPermissionRuleStore, 'add'>;
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
    ? `Added: ${record.rule.description}. Every tool that can reach a shell is refused a command that runs it, in every permission mode including yolo, in every project.`
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
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'revoke', example: { command: 'git push' },
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
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'revoke', example: { effect: 'deny', kind: 'class', target: 'rm' },
  async run(values, services, caller) {
    // A project rule is scoped to the folder of the program that asked.
    if (!caller.workingDirectory) throw new CapabilityRefusal('No rule was added: no project folder was given to scope it to.', 'A rule that refuses a command everywhere needs none: "Never run a command".');
    return addRule(services, [values.effect!, values.kind!, values.target!.trim()], caller.workingDirectory);
  },
};
