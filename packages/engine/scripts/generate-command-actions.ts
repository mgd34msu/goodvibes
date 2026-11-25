#!/usr/bin/env bun
/**
 * Writes packages/engine/contracts/artifacts/command-actions.json: every
 * action of every described slash command as data (its name, blanks, the
 * lists they choose from with the operator method that returns them, its
 * sentence, risk, how long it lasts, its typed line, and the operator method
 * that runs it or why only a terminal can). The web UI draws its action sheets
 * from it (products/webui/scripts/generate-command-actions.ts), so a sheet
 * says what the terminal says.
 *
 * `--check` writes nothing and fails when the file is stale or when an action
 * or a list names an operator method the contract does not have. Part of
 * `bun run refresh:contracts` and `bun run contracts:check`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  daemonCapabilityAction, linePattern, listByName, riskWords, sessionCapabilityAction, type ActionDescription, type CommandDescription, type InputDescription,
} from '../terminal-shell/src/command-actions/index.ts';
import { DAEMON_CAPABILITIES, METHOD_CAPABILITIES, SESSION_CAPABILITIES, type CapabilityDefinition } from '../platform/src/platform/capabilities/index.ts';
import { loadDescribedCommands } from './command-actions-registries.ts';

const ENGINE_ROOT = join(import.meta.dir, '..');
export const COMMAND_ACTIONS_ARTIFACT = join(ENGINE_ROOT, 'contracts/artifacts/command-actions.json');
const OPERATOR_CONTRACT = join(ENGINE_ROOT, 'contracts/artifacts/operator-contract.json');

function inputData(input: InputDescription): Record<string, unknown> {
  return {
    id: input.id,
    label: input.label,
    help: input.help,
    kind: input.kind,
    ...(input.choices ? { choices: input.choices } : {}),
    ...(input.freeTextReason ? { freeTextReason: input.freeTextReason } : {}),
    required: input.required,
    typed: input.typed,
    ...(input.step !== undefined ? { step: input.step } : {}),
    ...(input.showWhen ? { showWhen: input.showWhen } : {}),
  };
}

function actionData(command: CommandDescription<never>, action: ActionDescription<never>): Record<string, unknown> {
  return {
    id: action.id,
    // An action that has moved beside its handler carries its capability declaration (id, group, home, repeat).
    ...(action.capability ? { capability: action.capability } : {}),
    label: action.label,
    ...(action.button ? { button: action.button } : {}),
    word: action.word,
    line: [`/${command.name}`, linePattern(action)].filter(Boolean).join(' '),
    sentence: action.sentence,
    done: action.done,
    touches: action.touches,
    lasts: action.lasts,
    risk: action.risk,
    ...(action.risk !== 'none' ? { riskWords: riskWords(action.risk) } : {}),
    ...(action.ownerOnly ? { ownerOnly: action.ownerOnly } : {}),
    ...(action.undoneBy ? { undoneBy: action.undoneBy } : {}),
    operator: action.operator ?? { terminalOnly: 'Done from a terminal app.' },
    inputs: action.inputs.map(inputData),
    ...(action.stepTitles && action.stepTitles.length > 0 ? { stepTitles: action.stepTitles } : {}),
  };
}

/** Never called: the data of a capability's action is read, never run, here. */
const NOT_RUN = { daemon: () => { throw new Error('the generator runs nothing'); }, caller: () => ({}) } as const;

/**
 * Every moved capability no registered slash command carries (capabilities/builtin), grouped by the command it names,
 * as the same action a slash command would carry: the web UI draws such a capability's sheet from its own definition
 * and runs it through `capabilities.run` (one that runs where the conversation is says so). Kept apart from
 * `commands`, which are the typed slash commands: these are not typed anywhere.
 */
function commandlessCapabilities(described: readonly CommandDescription<never>[]): readonly CommandDescription<never>[] {
  const carried = new Set(described.flatMap((command) => command.actions.flatMap((action) => action.capability ? [action.capability.id] : [])));
  const byName = new Map<string, { name: string; title: string; summary: string; group: string; actions: ActionDescription<never>[] }>();
  const add = (command: { readonly name: string; readonly title: string }, id: string, action: ActionDescription<never>): void => {
    if (carried.has(id)) return;
    carried.add(id);
    const held = byName.get(command.name) ?? { name: command.name, title: command.title, summary: command.title, group: 'Capabilities', actions: [] };
    held.actions.push(action);
    byName.set(command.name, held);
  };
  for (const moved of [...DAEMON_CAPABILITIES, ...METHOD_CAPABILITIES]) {
    add(moved.command, moved.definition.capability.id, daemonCapabilityAction<never>(moved.definition as unknown as CapabilityDefinition<never>, NOT_RUN as never) as ActionDescription<never>);
  }
  for (const moved of SESSION_CAPABILITIES) {
    add(moved.command, moved.definition.capability.id, sessionCapabilityAction<never, never>(moved.definition, () => undefined as never, { terminalOnly: 'It acts on a terminal program\'s open conversation, so it is done there.' }) as ActionDescription<never>);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function commandData(command: CommandDescription<never>): Record<string, unknown> {
  return {
    name: command.name,
    title: command.title,
    summary: command.summary,
    group: command.group,
    ...(command.report ? { report: command.report } : {}),
    actions: command.actions.map((action) => actionData(command, action)),
  };
}

export async function buildCommandActionsArtifact(): Promise<string> {
  const commands = await loadDescribedCommands();
  const capabilities = commandlessCapabilities(commands);
  const listNames = new Set<string>();
  for (const command of [...commands, ...capabilities]) for (const action of command.actions) for (const input of action.inputs) {
    if (input.choices && !Array.isArray(input.choices)) listNames.add((input.choices as { readonly list: string }).list);
  }
  const lists = Object.fromEntries([...listNames].sort().map((name) => [name, listByName(name).operator]));
  const artifact = {
    $comment: 'Generated by packages/engine/scripts/generate-command-actions.ts from the slash command descriptions; regenerate with bun run refresh:contracts.',
    commands: commands.map(commandData),
    // The capabilities no slash command carries, by the command each names (never typed: only drawn as sheets).
    capabilities: capabilities.map(commandData),
    lists,
  };
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

/** Operator methods an action or list names that the committed contract does not have. */
function unknownMethods(text: string): string[] {
  if (!existsSync(OPERATOR_CONTRACT)) return [];
  const contract = JSON.parse(readFileSync(OPERATOR_CONTRACT, 'utf8')) as { readonly operator?: { readonly methods?: readonly { readonly id: string }[] }; readonly methods?: readonly { readonly id: string }[] };
  const ids = new Set((contract.operator?.methods ?? contract.methods ?? []).map((method) => method.id));
  if (ids.size === 0) return [];
  const artifact = JSON.parse(text) as { commands: { name: string; actions: { id: string; operator: { method?: string } }[] }[]; lists: Record<string, { method?: string }> };
  const missing: string[] = [];
  for (const command of artifact.commands) for (const action of command.actions) {
    if (action.operator.method && !ids.has(action.operator.method)) missing.push(`/${command.name} ${action.id}: ${action.operator.method}`);
  }
  for (const [name, list] of Object.entries(artifact.lists)) if (list.method && !ids.has(list.method)) missing.push(`list ${name}: ${list.method}`);
  return missing;
}

if (import.meta.main) {
  const text = await buildCommandActionsArtifact();
  const missing = unknownMethods(text);
  if (missing.length > 0) {
    console.error(`[command-actions] names operator methods the contract does not have:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    const current = existsSync(COMMAND_ACTIONS_ARTIFACT) ? readFileSync(COMMAND_ACTIONS_ARTIFACT, 'utf8') : '';
    if (current !== text) {
      console.error('[command-actions] contracts/artifacts/command-actions.json is stale; run `bun run refresh:contracts`');
      process.exit(1);
    }
  } else {
    writeFileSync(COMMAND_ACTIONS_ARTIFACT, text);
    console.log(`[command-actions] wrote ${COMMAND_ACTIONS_ARTIFACT}`);
  }
}
