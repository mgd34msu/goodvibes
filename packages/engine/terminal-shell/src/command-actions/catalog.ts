/**
 * What a person and a model read about a described command, both from its
 * description: the help entry (each action with its sentence and its line)
 * and the model's catalogue entry (label, sentence, typed pattern, what it
 * touches, the risk, and why only the owner may run it).
 */
import { fixedChoices, linePattern, renderTypedLine, riskWords, actionSentence, singleAction } from './typed-line.js';
import { LASTS_WORDS, type ActionDescription, type CommandDescription, type InputDescription } from './types.js';

function lastsText(action: ActionDescription<never>): string {
  if (action.lasts === 'not-a-change') return 'changes nothing';
  if (action.lasts === 'session' || action.lasts === 'kept') return LASTS_WORDS[action.lasts];
  return `${LASTS_WORDS.session}, or ${LASTS_WORDS.kept} (${action.lasts.byInput})`;
}

function inputText(input: InputDescription): string {
  const choices = fixedChoices(input);
  const from = choices
    ? `one of ${choices.map((choice) => `${choice.value} (${choice.label})`).join(', ')}`
    : input.choices && 'list' in input.choices
      ? `from the list "${input.choices.list}"${input.choices.allowOther ? `, or another value (${input.choices.allowOther.reason})` : ''}`
      : input.freeTextReason ?? 'typed';
  const need = input.required === true ? 'required' : `default ${input.required.default}: ${input.required.defaultMeans}`;
  return `${input.label}: ${input.help} (${from}; ${need})`;
}

/** The help entry for `/help <command>`: its summary, then each action with its sentence and its line. */
export function renderCommandHelp(description: CommandDescription<never>): string {
  const lines = [`/${description.name}: ${description.title}`, `  ${description.summary}`, ''];
  const single = singleAction(description);
  if (single) {
    const needs = single.inputs.some((input) => input.required === true);
    lines.push(`  /${description.name}${needs ? ' asks for what it needs and then' : ''} ${needs ? 'runs' : 'runs at once'}${single.risk !== 'none' ? ', after asking you' : ''}.`);
  } else {
    lines.push(`  /${description.name} alone opens the list of actions below${description.report ? `; where no list can be shown it runs "${description.actions.find((action) => action.id === description.report)?.label ?? description.report}"` : ''}.`);
  }
  for (const action of description.actions) {
    const risk = riskWords(action.risk);
    lines.push('', `  ${action.label}${risk ? `  (${risk})` : ''}`);
    lines.push(`    ${actionSentence(action, Object.fromEntries(action.inputs.map((input) => [input.id, `<${input.label.toLowerCase()}>`])))}`);
    lines.push(`    ${[`/${description.name}`, linePattern(action)].filter(Boolean).join(' ')}`);
    if (Object.keys(action.example).length > 0) lines.push(`    for example: ${renderTypedLine(description, action.id, action.example)}`);
    if (action.ownerOnly) lines.push(`    only when you type it: ${action.ownerOnly.reason}`);
  }
  return lines.join('\n');
}

/** One action as the model's catalogue gives it. */
export function describeActionForModel(description: CommandDescription<never>, action: ActionDescription<never>): Record<string, unknown> {
  return {
    id: action.id,
    label: action.label,
    word: action.word,
    line: [`/${description.name}`, linePattern(action)].filter(Boolean).join(' '),
    example: renderTypedLine(description, action.id, action.example),
    sentence: action.sentence,
    touches: action.touches,
    lasts: lastsText(action),
    risk: action.risk === 'none' ? 'none' : riskWords(action.risk),
    inputs: action.inputs.map(inputText),
    ...(action.ownerOnly ? { ownerOnly: action.ownerOnly.reason, instead: action.ownerOnly.instead } : {}),
    ...(action.risk === 'loosens-a-protection' && !action.ownerOnly ? { ownerOnly: 'it loosens a protection' } : {}),
  };
}

/** The model's catalogue entry for a described command: per action, what it does and the exact line. */
export function describeCommandForModel(description: CommandDescription<never>): Record<string, unknown> {
  return {
    title: description.title,
    summary: description.summary,
    ...(description.report ? { bareRuns: description.report } : {}),
    actions: description.actions.map((action) => describeActionForModel(description, action)),
  };
}

/** `/help <command>`: a described command's full entry, else its usage and description. */
export function helpForCommand(command: {
  readonly name: string;
  readonly description: string;
  readonly usage?: string | undefined;
  readonly argsHint?: string | undefined;
  readonly described?: CommandDescription<never> | undefined;
}): string {
  if (command.described) return renderCommandHelp(command.described);
  const usage = command.usage ?? command.argsHint;
  return [`/${command.name}${usage ? ` ${usage}` : ''}`, `  ${command.description}`].join('\n');
}
