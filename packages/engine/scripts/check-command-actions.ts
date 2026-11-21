#!/usr/bin/env bun
/**
 * `bun run commands:check`: every slash command of both terminal apps is
 * described the one way (terminal-shell/src/command-actions/), and every
 * description holds to the command standard. Loads both registries without
 * running a handler and fails, naming the command and action, when:
 *
 *  1. an action's name is only its typed word;
 *  2. a blank has no label;
 *  3. a blank offers choices but names no list (or a list no command defines),
 *     or is typed text and gives no reason why it has to be;
 *  4. an action has no sentence, or its sentence leaves out a required blank;
 *  5. an action that changes something does not say how long (an action that
 *     cannot be undone says so with its risk);
 *  6. an action marked risky does not ask (its line asks, or it asks its own
 *     question: `asksItself`), or one that loosens a protection can be run by a
 *     model;
 *  7. an action cannot be reached from the guided path (a blank's list depends
 *     on a blank that comes after it, or on none, or the action shows no form
 *     and has a blank that must be filled);
 *  8. one choice of a blank does what another action does (a reversing word);
 *  9. two actions do the same thing (same word, label or sentence);
 * 10. the same command differs between the two terminal apps;
 * 11. the line the description produces for its own example is not accepted;
 * 12. a command is not built with `defineCommand`: every registered command
 *     is described.
 */
import {
  generatedConfirm,
  listByName,
  parseTypedLine,
  renderTypedLine,
  type ActionDescription,
  type CommandDescription,
} from '../terminal-shell/src/command-actions/index.ts';
import { tokenizeSlashCommand } from '../terminal-shell/src/slash-command-parser.ts';

import { loadCommandRegistries, type RegisteredCommand } from './command-actions-registries.ts';

function placeholders(action: ActionDescription<never>): Record<string, string> {
  return Object.fromEntries(action.inputs.filter((input) => input.required === true && !input.showWhen).map((input) => [input.id, `<${input.id}>`]));
}

export function checkDescription(description: CommandDescription<never>, problems: string[]): void {
  const at = (action: ActionDescription<never> | undefined, text: string) => problems.push(`/${description.name}${action ? ` ${action.word} (${action.id})` : ''}: ${text}`);
  const seen = { id: new Map<string, string>(), word: new Map<string, string>(), label: new Map<string, string>(), sentence: new Map<string, string>() };
  const words = new Set(description.actions.map((action) => action.word));
  if (description.report && !description.actions.some((action) => action.id === description.report && action.inputs.every((input) => input.required !== true))) {
    at(undefined, `its report "${description.report}" is not an action that runs with nothing filled in`);
  }
  // 7: every action is on the first screen or inside one of its groups.
  if (description.firstScreenRows) {
    const listed = new Set<string>();
    for (const row of description.firstScreenRows) {
      for (const id of typeof row === 'string' ? [row] : row.actions) {
        if (!description.actions.some((action) => action.id === id)) at(undefined, `its first screen names "${id}", which is not one of its actions`);
        listed.add(id);
      }
      if (typeof row !== 'string' && row.actions.length === 0) at(undefined, `its first-screen group "${row.label}" has no actions`);
    }
    for (const action of description.actions) if (!listed.has(action.id)) at(action, 'it is neither on the first screen nor in one of its groups, so the guided path cannot reach it');
  }
  for (const action of description.actions) {
    // 1
    if (action.label.trim().toLowerCase() === action.word || !/\s/.test(action.label.trim())) at(action, `its name "${action.label}" is only its typed word; name it for what you get`);
    // 9
    for (const [key, map] of Object.entries(seen) as [keyof typeof seen, Map<string, string>][]) {
      const value = key === 'sentence' ? action.sentence : action[key];
      const other = map.get(value);
      if (other) at(action, `it has the same ${key} as ${other}: two actions do the same thing`);
      map.set(value, action.id);
    }
    // 7: an action that shows no form may not have a blank that must be filled.
    if (action.blanksTypedOnly && action.inputs.some((input) => input.required === true)) at(action, 'it shows no form but has a blank that must be filled, so the guided path cannot fill it');
    // 4
    if (!action.sentence.trim()) at(action, 'it has no sentence');
    for (const input of action.inputs) {
      // A secret is never written into a sentence: it would be shown on screen and kept in the transcript.
      if (input.kind === 'secret' && action.sentence.includes(`{${input.id}}`)) at(action, `its sentence shows the secret blank "${input.label}"; a secret is never shown`);
      if (input.required === true && input.kind !== 'secret' && !input.showWhen && !action.sentence.includes(`{${input.id}}`)) at(action, `its sentence leaves out the required blank "${input.label}" ({${input.id}})`);
    }
    // 5
    if (action.lasts !== 'not-a-change' && action.risk !== 'cannot-be-undone' && !action.sentence.includes('{lasts}') && !/for this session only|until you change it/.test(action.sentence)) {
      at(action, 'it changes something and its sentence does not say how long ("for this session only", "until you change it" or {lasts})');
    }
    if (action.lasts !== 'not-a-change' && action.touches === 'reads') at(action, 'it changes something but says it only reads');
    if (typeof action.lasts === 'object' && !action.inputs.some((input) => input.id === (action.lasts as { byInput: string }).byInput)) {
      at(action, `how long it lasts is decided by "${action.lasts.byInput}", which is not one of its blanks`);
    }
    // 6
    const example = { ...placeholders(action), ...action.example };
    const line = renderTypedLine(description, action.id, example);
    const args = [...tokenizeSlashCommand(line)].slice(1);
    if (action.risk !== 'none' && !action.asksItself) {
      const question = (() => { try { return generatedConfirm(description)(args, {}); } catch { return undefined; } })();
      if (!question) at(action, 'it is marked risky and its line does not ask first');
    }
    if (action.risk === 'loosens-a-protection' && !action.ownerOnly) at(action, 'it loosens a protection and a model could run it: give it ownerOnly with the reason');
    // 2, 3, 7, 8
    action.inputs.forEach((input, index) => {
      if (!input.label.trim()) at(action, `blank "${input.id}" has no label`);
      if (!input.help.trim()) at(action, `blank "${input.label}" has no help line`);
      const typedText = input.kind === 'text' || input.kind === 'long-text';
      if (input.kind === 'choice' && !input.choices) at(action, `blank "${input.label}" offers choices but names no list`);
      if (input.choices && !Array.isArray(input.choices)) {
        const list = input.choices as { readonly list: string; readonly dependsOn?: string | undefined };
        try { listByName(list.list as never); } catch { at(action, `blank "${input.label}" names the list "${list.list}", which no command defines`); }
        if (list.dependsOn !== undefined && !action.inputs.slice(0, index).some((earlier) => earlier.id === list.dependsOn)) {
          at(action, `blank "${input.label}" reads its list for "${list.dependsOn}", which is not an earlier blank, so the guided path cannot reach it`);
        }
      } else if (typedText && !input.freeTextReason) {
        at(action, `blank "${input.label}" is typed text and gives no reason why it has to be`);
      }
      if (Array.isArray(input.choices)) {
        for (const choice of input.choices) {
          if (words.has(choice.value) && choice.value !== action.word) at(action, `choice "${choice.value}" of "${input.label}" is the word of another action: a blank may not do what another action does`);
          if (!choice.label.trim()) at(action, `choice "${choice.value}" of "${input.label}" has no label`);
        }
      }
    });
    // 11
    const parsed = parseTypedLine(description, args);
    if (!('action' in parsed) || parsed.action.id !== action.id || parsed.problem || parsed.missing.length > 0
      || Object.entries(example).some(([id, value]) => (parsed.values[id] ?? '') !== value)) {
      at(action, `the line made from its example (${line}) is not read back as the same action and values`);
    }
  }
}

/** A comparable copy of a description: its data, without the functions. */
function shape(description: CommandDescription<never>): string {
  return JSON.stringify(description, (_key, value: unknown) => typeof value === 'function' ? '[run]' : value);
}

if (import.meta.main) {
  const { tui, agent } = await loadCommandRegistries();
  const problems: string[] = [];
  const byName = new Map<string, { tui?: RegisteredCommand; agent?: RegisteredCommand }>();
  for (const command of tui) byName.set(command.name, { ...byName.get(command.name), tui: command });
  for (const command of agent) byName.set(command.name, { ...byName.get(command.name), agent: command });
  for (const [name, { tui: inTui, agent: inAgent }] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    const described = [inTui?.described, inAgent?.described].filter((entry): entry is CommandDescription<never> => entry !== undefined);
    if (described.length === 0) {
      problems.push(`/${name}: not built with defineCommand; describe it (12)`);
      continue;
    }
    // 10
    if (inTui && inAgent && (!inTui.described || !inAgent.described || shape(inTui.described) !== shape(inAgent.described))) {
      problems.push(`/${name}: the two terminal apps describe it differently (10)`);
    }
    checkDescription(described[0]!, problems);
  }
  if (problems.length > 0) {
    console.error(`commands:check: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('Name the action for what you get, label the blank, give it a list or a reason, write the sentence (packages/engine/terminal-shell/src/command-actions/).');
    process.exit(1);
  }
  console.log(`commands:check: ${byName.size} described.`);
}
