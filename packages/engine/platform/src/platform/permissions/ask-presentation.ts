/**
 * What every ask says, once: the question, where, what it acts on, the
 * consequence sentence, the choices, whether an answer can be remembered,
 * why the person is asked, and the rest behind Details. The terminal's ask
 * card, the web UI (inline in the chat and in Work) and every chat channel
 * render this and build no words of their own.
 *
 * It sits beside the approval reading (control-plane/approval-lifecycle.ts
 * `ApprovalReading`: state, allowed actions, deadline, who decides) and adds
 * only words and choices; it never decides whether something is allowed. The
 * consequence comes from facts only (ask-consequence.ts).
 *
 * Pure: no I/O. Cost per ask: one parse of each command string it carries.
 */
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { toolActivityFallback, toolCallActivity } from '@goodvibes-jev/engine/contracts';
import { toolActivityOf } from '../tools/registry.js';
import { extractHostname } from '../tools/fetch/trust-tiers.js';
import { extractPathArgs } from '../runtime/permissions/rules/path-scope.js';
import { ownerOnlyReason } from '../gate/classify.js';
import { archetypeDisplayName } from '../agents/archetypes.js';
import type { OwnerItem } from '../control-plane/owner-inbox.js';
import type { PermissionPromptRequest } from './prompt.js';
import type { RememberTier } from './approval-rules.js';
import { buildPermissionApprovalBrief } from './briefs/build.js';
import { execRunPlace, permissionSubject } from './subject.js';
import { composeConsequence, folderName, readingAnswer, undoFactOf, commandEffect, type SandboxFact } from './ask-consequence.js';
import type { ModeInForceWords } from './decision-model-readiness.js';

export type AskKind =
  | 'run-command' | 'answer-command-prompt' | 'change-files' | 'fetch' | 'start-agent' | 'hand-off-work'
  | 'change-setting' | 'mcp-tool' | 'other-tool' | 'purchase' | 'question' | 'decision' | 'claim' | 'queued-action' | 'report';

export interface AskChoice {
  readonly id: 'once' | 'remember' | 'no' | 'apply-selected' | `option:${number}` | 'own-words' | 'object' | 'acknowledge';
  /** "Yes, once" | "Yes, and don't ask again…" | "No" | "Hello" | "Something else…" */
  readonly label: string;
  /** The terminal key: 'y' | 'a' | 'n' | '1'..'8'. */
  readonly key?: string | undefined;
  /** The selected button when the card opens. */
  readonly default?: true | undefined;
  readonly danger?: true | undefined;
  /** For an `option:<n>` choice: the option's own value, as the inbox answers it. */
  readonly value?: string | undefined;
}

export interface RememberTierView {
  readonly tier: RememberTier;
  /** "This exact command" | "Any bun command in this project" */
  readonly label: string;
  /** "bun test" | "bun …" | "forgotten when this session ends" */
  readonly detail: string;
}

export interface AskPresentation {
  readonly kind: AskKind;
  /** ▲ amber | ▲ red | ? cyan */
  readonly mark: 'ask' | 'cannot-undo' | 'question';
  /** "Run this command?" | "Delete files? This can't be undone." | "A question for you" */
  readonly question: string;
  /** "sample-app" | "in ~/projects/sample-app" */
  readonly place?: { readonly short: string; readonly full: string } | undefined;
  readonly subject?: { readonly kind: 'command' | 'paths' | 'urls' | 'text' | 'money'; readonly lines: readonly string[] } | undefined;
  /** A question's own text ("Which greeting should be the default?"). */
  readonly body?: string | undefined;
  /** `text` for the terminal; `withPlace` with the folder folded in, for the web UI ("Runs your tests in garden-planner. Changes no files outside it."). */
  readonly consequence?: { readonly text: string; readonly withPlace: string; readonly tone: 'plain' | 'cannot-undo' } | undefined;
  readonly choices: readonly AskChoice[];
  readonly remember:
    | { readonly offered: true; readonly tiers: readonly RememberTierView[] }
    | { readonly offered: false; readonly why: string };
  /** The card takes a typed reason to refuse ("or type why not"). */
  readonly typeToRefuse: boolean;
  /** A purchase window's deadline: a veto window "goes ahead" at `at`; an approval window "waits for you" until it. */
  readonly countdown?: { readonly verb: string; readonly at: number } | undefined;
  /** "the agent in "Tidy the seed notes"": who asked, from which chat. */
  readonly origin?: { readonly sessionTitle?: string | undefined; readonly by: string } | undefined;
  /** "Why am I asked?": the mode in force and the rule, in a sentence or two. */
  readonly why: string;
  /** Everything else, behind d / Details. */
  readonly details: readonly { readonly label: string; readonly value: string }[];
  /** One line for lists, channels and notifications: "Run bun test?" */
  readonly title: string;
}

/** The facts an ask is worded from, held by the surface that shows it. */
export interface AskFacts {
  readonly workingDirectory?: string | undefined;
  readonly homeDirectory?: string | undefined;
  /** The exec sandbox the call runs in. */
  readonly sandbox?: SandboxFact | undefined;
  /** Whether the workspace checkpoint holds a copy of this path (it snapshots the workspace at each turn end). */
  readonly checkpointCovers?: ((path: string) => boolean) | undefined;
  /** A setting's name as people read it ("the sandbox"). */
  readonly settingLabel?: ((key: string) => string | undefined) | undefined;
  readonly sessionTitle?: ((sessionId: string) => string | undefined) | undefined;
  /** The session the ask was raised in (the approval record's or the inbox item's). */
  readonly sessionId?: string | undefined;
  /** The chat the person is looking at; an ask from another chat names its title. */
  readonly currentSessionId?: string | undefined;
  readonly modeInForce: ModeInForceWords;
  /** A purchase window's facts, by purchase id (payments/window-view.ts and the operation view). */
  readonly purchase?: ((purchaseId: string) => PurchaseAskFacts | undefined) | undefined;
}

export interface PurchaseAskFacts {
  readonly kind: 'approval' | 'veto';
  /** "a drip irrigation kit" */
  readonly item?: string | undefined;
  /** "$38.40" */
  readonly price?: string | undefined;
  readonly merchant?: string | undefined;
  readonly deadlineMs: number;
  /** Whether it fits the daily budget; absent when the budget does not say. */
  readonly withinBudget?: boolean | undefined;
}

const CANNOT_UNDO = 'This can\'t be undone.';
const NOT_REMEMBERED = 'always asks · can\'t be remembered';

/** "~/projects/sample-app" for a path under the home directory. */
function tilde(path: string, home: string | undefined): string {
  if (!home) return path;
  const root = home.replace(/\/+$/, '');
  return path === root ? '~' : path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path;
}

function placeOf(directory: string | undefined, home: string | undefined): AskPresentation['place'] {
  if (!directory) return undefined;
  return { short: folderName(directory), full: `in ${tilde(directory, home)}` };
}

function clipLine(text: string, max = 60): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The imperative of a tool's running words: "Searching" → "Search". */
const IMPERATIVES: Readonly<Record<string, string>> = {
  Searching: 'Search', Running: 'Run', Checking: 'Check', Writing: 'Write', Updating: 'Update', Stopping: 'Stop',
  Reading: 'Read', Messaging: 'Message', Inspecting: 'Inspect', Fetching: 'Fetch', Editing: 'Edit', Analyzing: 'Analyze', Using: 'Use',
};

/** "Search the web?" from the tool's own display words; "Use <name>?" for a tool that declares none. */
function toolQuestion(tool: string, args: Record<string, unknown>): string {
  const words = toolCallActivity(toolActivityOf(tool), args) ?? toolActivityFallback(tool);
  const verb = IMPERATIVES[words.doing] ?? 'Use';
  const object = verb === 'Use' && !IMPERATIVES[words.doing] ? (tool.includes('__') ? tool.split('__').pop()! : tool) : words.object;
  return `${verb}${object ? ` ${object}` : ''}?`;
}

/** Which kind of ask a permission request is. */
export function askKindOf(request: Pick<PermissionPromptRequest, 'tool' | 'args' | 'attribution' | 'category'>): AskKind {
  const attribution = request.attribution;
  if (attribution?.kind === 'exec-prompt') return 'answer-command-prompt';
  if (attribution?.kind === 'fetch-localhost') return 'fetch';
  if (attribution?.kind === 'mcp-server') return 'mcp-tool';
  const tool = request.tool;
  const mode = typeof request.args['mode'] === 'string' ? request.args['mode'] : undefined;
  if (tool === 'exec' || attribution?.kind === 'sandbox-escalation') return 'run-command';
  if (tool === 'write' || tool === 'edit') return 'change-files';
  if (tool === 'fetch') return 'fetch';
  if (tool === 'agent' && (mode === 'spawn' || mode === 'batch-spawn')) return 'start-agent';
  if (tool === 'delegate' || (tool === 'agent' && mode === 'message')) return 'hand-off-work';
  if (tool === 'goodvibes_settings') return 'change-setting';
  if (tool === 'mcp' || tool.startsWith('mcp__')) return 'mcp-tool';
  return 'other-tool';
}

function whoAsked(request: PermissionPromptRequest): string | undefined {
  const attribution = request.attribution;
  switch (attribution?.kind) {
    case 'background-agent': return attribution.template ? `the ${lowerFirst(archetypeDisplayName(attribution.template))}` : 'the agent';
    case 'mcp-server': return `the ${attribution.serverName} tool server`;
    case 'sandbox-escalation': return 'the sandbox';
    case 'exec-prompt': return 'a running command';
    default: return undefined;
  }
}

function originOf(by: string | undefined, facts: AskFacts): AskPresentation['origin'] {
  const sessionId = facts.sessionId;
  const elsewhere = sessionId !== undefined && sessionId !== facts.currentSessionId;
  const sessionTitle = elsewhere ? facts.sessionTitle?.(sessionId) : undefined;
  if (by === undefined && sessionTitle === undefined) return undefined;
  return { by: by ?? 'GoodVibes', ...(sessionTitle !== undefined ? { sessionTitle } : {}) };
}

function rememberOf(request: PermissionPromptRequest, cannotUndo: boolean): AskPresentation['remember'] {
  if (cannotUndo) return { offered: false, why: NOT_REMEMBERED };
  const tiers = request.rememberOptions ?? [];
  if (tiers.length === 0) return { offered: false, why: request.ownerOnly === 'channel-request' ? 'asked one call at a time · can\'t be remembered' : NOT_REMEMBERED };
  return { offered: true, tiers: tiers.map((option) => ({ tier: option.tier, label: option.label, detail: option.detail })) };
}

function approvalChoices(kind: AskKind, remember: AskPresentation['remember'], cannotUndo: boolean, tool: string): AskChoice[] {
  if (kind === 'answer-command-prompt') {
    return [{ id: 'once', label: 'Send the answer', key: 'y', default: true }, { id: 'no', label: 'No', key: 'n' }];
  }
  const yes: AskChoice = kind === 'change-files' && tool === 'edit'
    ? { id: 'apply-selected', label: 'Apply selected', key: 'y', ...(cannotUndo ? { danger: true as const } : { default: true as const }) }
    : { id: 'once', label: 'Yes, once', key: 'y', ...(cannotUndo ? { danger: true as const } : { default: true as const }) };
  return [
    yes,
    ...(remember.offered ? [{ id: 'remember' as const, label: 'Yes, and don\'t ask again…', key: 'a' }] : []),
    { id: 'no', label: 'No', key: 'n', ...(cannotUndo ? { default: true as const } : {}) },
  ];
}

/** "Run this command?" and the rest of the 3.4 table for a permission request. */
function questionOf(kind: AskKind, request: PermissionPromptRequest, facts: Pick<AskFacts, 'workingDirectory' | 'settingLabel'>, subjectValues: readonly string[]): { question: string; title: string } {
  const args = request.args;
  switch (kind) {
    case 'run-command': {
      const n = subjectValues.length;
      return { question: n > 1 ? `Run these ${n} commands?` : 'Run this command?', title: n === 1 ? `Run ${clipLine(subjectValues[0]!)}?` : n > 1 ? `Run ${n} commands?` : 'Run a command?' };
    }
    case 'answer-command-prompt': {
      const command = request.attribution?.kind === 'exec-prompt' ? request.attribution.command : undefined;
      return { question: 'A command is asking for input', title: command ? `${clipLine(command, 40)} is asking for input` : 'A command is asking for input' };
    }
    case 'change-files': {
      const paths = extractPathArgs(args);
      const folder = request.workingDirectory ?? facts.workingDirectory;
      const outside = folder !== undefined && paths.some((path) => {
        const rel = relative(folder, resolve(folder, path));
        return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
      });
      const n = new Set(paths).size;
      const question = outside ? 'Change a file outside this folder?' : n > 1 ? `Change these ${n} files?` : 'Change this file?';
      return { question, title: n === 1 ? `Change ${basename(paths[0]!)}?` : n > 1 ? `Change ${n} files?` : question };
    }
    case 'fetch': {
      const urls = subjectValues;
      const host = request.attribution?.kind === 'fetch-localhost' ? request.attribution.host : urls[0] ? extractHostname(urls[0]) ?? undefined : undefined;
      return { question: urls.length > 1 ? `Open these ${urls.length} web addresses?` : 'Open this web address?', title: host ? `Open ${host}?` : 'Open a web address?' };
    }
    case 'start-agent': return { question: 'Start a helper agent?', title: 'Start a helper agent?' };
    case 'hand-off-work': {
      const name = typeof args['agentId'] === 'string' ? 'the agent' : typeof args['target'] === 'string' ? args['target'] : 'another agent';
      return { question: `Hand this work to ${name}?`, title: `Hand work to ${name}?` };
    }
    case 'change-setting': {
      const key = typeof args['key'] === 'string' ? args['key'] : undefined;
      const label = key ? facts.settingLabel?.(key) : undefined;
      if (!label) return { question: 'Change a setting?', title: 'Change a setting?' };
      const name = lowerFirst(label);
      const value = args['value'];
      const question = args['mode'] === 'reset' ? `Reset ${name} to its default?`
        : value === true ? `Turn ${name} on?` : value === false ? `Turn ${name} off?` : `Change ${name} to ${clipLine(String(JSON.stringify(value) ?? ''), 40)}?`;
      return { question, title: question };
    }
    case 'mcp-tool': {
      const server = request.attribution?.kind === 'mcp-server' ? request.attribution.serverName
        : typeof args['server'] === 'string' ? args['server'] : request.tool.startsWith('mcp__') ? request.tool.split('__')[1] ?? 'a tool server' : 'a tool server';
      const toolName = typeof args['tool'] === 'string' ? args['tool'] : request.tool.startsWith('mcp__') ? request.tool.split('__').pop() ?? 'a tool' : 'a tool';
      const question = `Let ${server} use ${toolName}?`;
      return { question, title: question };
    }
    default: {
      const question = toolQuestion(request.tool, args);
      return { question, title: question };
    }
  }
}

function subjectOf(kind: AskKind, request: PermissionPromptRequest, values: readonly string[]): AskPresentation['subject'] {
  if (values.length === 0) return undefined;
  if (kind === 'answer-command-prompt' && request.attribution?.kind === 'exec-prompt') {
    return { kind: 'command', lines: [request.attribution.command, request.attribution.prompt] };
  }
  const subject = permissionSubject(request.tool, request.args);
  switch (subject.kind) {
    case 'command': return { kind: 'command', lines: subject.values };
    case 'path': return { kind: 'paths', lines: subject.values };
    case 'url': return { kind: 'urls', lines: subject.values };
    case 'task': return { kind: 'text', lines: subject.values };
    default: return kind === 'change-setting' ? undefined : { kind: 'text', lines: subject.values };
  }
}

function modeWhy(facts: AskFacts): string {
  const mode = facts.modeInForce;
  // The mode's own sentence says what is in force and why (decision-model-readiness.ts).
  return mode.inForce !== undefined ? mode.sentence : `${mode.chosen}: ${mode.asksBefore}`;
}

/**
 * The question of a permission ask on its own ("Run this command?", "Delete
 * files? This can't be undone."), for a surface that shows only the heading.
 */
export function approvalQuestion(request: PermissionPromptRequest, facts: Pick<AskFacts, 'workingDirectory' | 'settingLabel'> = {}): string {
  const kind = askKindOf(request);
  const subjectValues = permissionSubject(request.tool, request.args).values;
  const words = questionOf(kind, request, facts, subjectValues);
  if (!undoFactOf(request.tool, request.args, request.analysis.reading, request.ownerOnly).cannotUndo) return words.question;
  const destroys = kind === 'run-command' && subjectValues.length === 1 ? commandEffect(subjectValues[0]!)?.undoQuestion : undefined;
  return `${destroys ?? words.question} ${CANNOT_UNDO}`;
}

/**
 * The words of a permission ask (an approval request raised by the gate, a
 * sandbox escalation, a command's terminal prompt, an MCP server's question).
 */
export function presentApprovalAsk(request: PermissionPromptRequest, facts: AskFacts): AskPresentation {
  const kind = askKindOf(request);
  const subjectValues = permissionSubject(request.tool, request.args).values;
  const reading = request.analysis.reading;
  const undo = undoFactOf(request.tool, request.args, reading, request.ownerOnly);
  const cannotUndo = undo.cannotUndo;
  const runPlace = request.tool === 'exec' ? execRunPlace(request.args).workingDirectory : undefined;
  const directory = runPlace ?? request.workingDirectory ?? facts.workingDirectory;
  const place = placeOf(directory, facts.homeDirectory);
  const words = questionOf(kind, request, facts, subjectValues);
  const commands = kind === 'run-command' ? subjectValues : [];
  const destroys = commands.length === 1 ? commandEffect(commands[0]!)?.undoQuestion : undefined;
  const question = cannotUndo ? `${destroys ?? words.question} ${CANNOT_UNDO}` : words.question;
  const hosts = kind === 'fetch'
    ? [...new Set(subjectValues.flatMap((url) => extractHostname(url) ?? []))].concat(request.attribution?.kind === 'fetch-localhost' ? [request.attribution.host] : [])
    : undefined;
  const consequence = composeConsequence({
    toolName: request.tool, args: request.args, reading, undo,
    ...(directory !== undefined ? { workingDirectory: directory } : {}),
    ...(place ? { placeShort: place.short } : {}),
    ...(kind === 'run-command' && facts.sandbox ? { sandbox: facts.sandbox } : {}),
    ...(facts.checkpointCovers ? { checkpointCovers: facts.checkpointCovers } : {}),
    ...(hosts && hosts.length > 0 ? { hosts: [...new Set(hosts)] } : {}),
    weakensSetting: kind === 'change-setting' && readingAnswer(reading, 'weakensSecurity') === 'yes',
  });
  const remember = rememberOf(request, cannotUndo);
  const by = whoAsked(request);
  const origin = originOf(by, facts);

  const why = [
    modeWhy(facts),
    request.ownerOnly !== undefined ? `Only you decide this: ${ownerOnlyReason(request.ownerOnly)}.` : undefined,
    cannotUndo ? 'It can\'t be undone, so it asks every time; to let it run without asking, add a permission rule with /permissions.' : undefined,
  ].filter((part): part is string => part !== undefined).join(' ');

  const brief = buildPermissionApprovalBrief(request);
  const analysis = request.analysis;
  const notChecked = reading === undefined && !cannotUndo
    ? `Not checked: ${facts.modeInForce.because === undefined || facts.modeInForce.because === 'no decision model set' ? 'no decision model is set' : facts.modeInForce.because}, so GoodVibes can't tell whether this can be undone.`
    : undefined;
  const sandbox = facts.sandbox;
  const details: { label: string; value: string }[] = [
    { label: 'Tool', value: request.tool },
    ...(directory ? [{ label: 'Directory', value: directory }] : []),
    ...(kind === 'run-command' && sandbox ? [{ label: 'Sandbox', value: sandbox.enforced
      ? `on: writes only to ${sandbox.writableRoots.join(', ') || 'nothing'}${sandbox.network ? '' : ', no network'}` : 'off' }] : []),
    { label: 'Decision', value: facts.modeInForce.inForce !== undefined ? `${facts.modeInForce.chosen} · ${facts.modeInForce.inForce}` : facts.modeInForce.chosen },
    ...(notChecked ? [{ label: 'Undo', value: notChecked }] : []),
    ...(analysis.sideEffects && analysis.sideEffects.length > 0 ? [{ label: 'Effects', value: analysis.sideEffects.join(', ') }] : []),
    ...analysis.reasons.map((reason) => ({ label: 'Review', value: reason })),
    { label: 'Checklist', value: brief.checklist },
    ...(request.tool === 'exec' ? execRunPlace(request.args).commandLines.map((line) => ({ label: 'Runs', value: line })) : []),
    { label: 'Arguments', value: JSON.stringify(request.args) },
  ];

  return {
    kind,
    mark: cannotUndo ? 'cannot-undo' : 'ask',
    question,
    ...(place ? { place } : {}),
    ...(subjectOf(kind, request, subjectValues) ? { subject: subjectOf(kind, request, subjectValues)! } : {}),
    ...(consequence ? { consequence } : {}),
    choices: approvalChoices(kind, remember, cannotUndo, request.tool),
    remember,
    typeToRefuse: kind !== 'answer-command-prompt',
    ...(origin ? { origin } : {}),
    why,
    details,
    title: cannotUndo ? `${words.title} ${CANNOT_UNDO}` : words.title,
  };
}

/** A question's choices: its options by number, then the person's own words. */
function optionChoices(options: readonly string[], ownWords: string): AskChoice[] {
  const listed = options.slice(0, 8).map((option, index): AskChoice => ({
    id: `option:${index}`, label: option, key: String(index + 1), value: option, ...(index === 0 ? { default: true as const } : {}),
  }));
  return [...listed, { id: 'own-words', label: ownWords, ...(listed.length === 0 ? { default: true as const } : {}) }];
}

const DECISION_LABELS: Readonly<Record<string, string>> = {
  keep: 'Keep it as decided', undo: 'Undo the change', never: 'Never allow calls like it', always: 'Always allow calls like it', ask: 'Always ask me',
};

function metadataText(item: OwnerItem, key: string): string | undefined {
  const value = item.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

/**
 * The words of an owner-inbox item: a question, a decision Jev made, a
 * channel claim, a purchase window, an action held for the owner, a report.
 * An approval item is worded by presentApprovalAsk from its request, passed as
 * `request`; without it the item's own title stands.
 */
export function presentInboxAsk(item: OwnerItem, facts: AskFacts, request?: PermissionPromptRequest): AskPresentation {
  const withSession: AskFacts = item.sessionId !== undefined && facts.sessionId === undefined ? { ...facts, sessionId: item.sessionId } : facts;
  if (item.kind === 'approval' && request) return presentApprovalAsk(request, withSession);
  // An agent's question names it as "the agent"; any other asker (Jev, a channel, a schedule) by its own name.
  const askedBy = item.askedBy === undefined ? undefined : /^agent\b/i.test(item.askedBy) ? 'the agent' : item.askedBy;
  const origin = originOf(askedBy, withSession);
  const base = { ...(origin ? { origin } : {}), why: modeWhy(facts) };
  const noRemember = { offered: false as const, why: 'answered once' };
  switch (item.kind) {
    case 'question':
      return {
        ...base, kind: 'question', mark: 'question', question: 'A question for you', body: item.title,
        ...(item.detail ? { subject: { kind: 'text' as const, lines: [item.detail] } } : {}),
        choices: optionChoices(item.options, item.options.length > 0 ? 'Something else…' : 'Answer in your own words'),
        remember: noRemember, typeToRefuse: false,
        why: `${origin ? `${capitalize(origin.by)} asked you this` : 'This was left for you'}; it waits in your inbox until you answer, and nothing is waiting on a yes or no.`,
        details: [{ label: 'Asked', value: new Date(item.createdAt).toISOString() }, ...(item.askedBy ? [{ label: 'Asked by', value: item.askedBy }] : [])],
        title: clipLine(item.title, 80),
      };
    case 'decision': {
      const tool = metadataText(item, 'tool');
      const verdict = metadataText(item, 'verdict') ?? 'decided';
      const noun = tool === 'exec' ? 'command' : tool === 'write' || tool === 'edit' ? 'file change' : tool === 'fetch' ? 'web request' : 'action';
      const question = `Jev ${verdict} a ${noun} for you`;
      return {
        ...base, kind: 'decision', mark: 'question', question, body: firstLine(item.detail).replace(/^Why: /, ''),
        choices: item.options.map((option, index): AskChoice => ({
          id: `option:${index}`, label: DECISION_LABELS[option] ?? capitalize(option), key: String(index + 1), value: option, ...(index === 0 ? { default: true as const } : {}),
        })),
        remember: noRemember, typeToRefuse: false,
        why: 'Jev decided this in your place; you can keep it, undo it, or set a standing rule for calls like it.',
        details: [{ label: 'Decided', value: item.title }, { label: 'Detail', value: item.detail }],
        title: question,
      };
    }
    case 'claim':
      return {
        ...base, kind: 'claim', mark: 'ask', question: item.title, body: firstLine(item.detail),
        consequence: { text: item.title.startsWith('Make ') ? 'They become the owner of this chat app here.' : 'They are added to who may reach you here.',
          withPlace: item.title.startsWith('Make ') ? 'They become the owner of this chat app here.' : 'They are added to who may reach you here.', tone: 'plain' },
        choices: [{ id: 'once', label: 'Accept', key: 'y', default: true, value: 'accept' }, { id: 'no', label: 'Decline', key: 'n', value: 'decline' }],
        remember: noRemember, typeToRefuse: false,
        why: 'Someone new wrote to you on a chat app; only you choose who it answers.',
        details: [{ label: 'Detail', value: item.detail }, ...(item.askedBy ? [{ label: 'From', value: item.askedBy }] : [])],
        title: item.title,
      };
    case 'queued-action': {
      const summary = firstLine(item.detail);
      return {
        ...base, kind: 'queued-action', mark: 'ask', question: 'Let this held action run?',
        ...(summary ? { subject: { kind: 'text' as const, lines: [summary] } } : {}),
        consequence: { text: 'It runs when the work carries on.', withPlace: 'It runs when the work carries on.', tone: 'plain' },
        choices: [{ id: 'once', label: 'Yes, let it run', key: 'y', default: true, value: 'approve' }, { id: 'no', label: 'No', key: 'n', value: 'dismiss' }],
        remember: noRemember, typeToRefuse: false,
        why: 'Just vibes held this for you instead of interrupting the work.',
        details: [{ label: 'Detail', value: item.detail }],
        title: summary ? `Let it run: ${clipLine(summary, 50)}?` : 'Let a held action run?',
      };
    }
    case 'purchase': {
      const purchaseId = metadataText(item, 'purchaseId');
      const purchase = purchaseId !== undefined ? facts.purchase?.(purchaseId) : undefined;
      const windowKind = purchase?.kind ?? (item.options.includes('go') ? 'veto' : item.options.includes('approve') ? 'approval' : undefined);
      const question = purchase?.item && purchase.price ? `Buy ${purchase.item} for ${purchase.price}?`
        : windowKind === 'veto' ? 'Let this purchase go ahead?' : windowKind === 'approval' ? 'Approve this purchase?' : 'A purchase update';
      // A veto window opens only for a purchase inside the budget (payments/merchant-recourse.ts windowForPurchase:
      // anything above it gets an approval window), so a veto window is inside it by construction.
      const withinBudget = purchase?.withinBudget ?? (windowKind === 'veto' ? true : undefined);
      const budget = withinBudget === true ? 'Inside your daily budget.' : withinBudget === false ? 'Over your daily budget.' : undefined;
      const deadline = purchase?.deadlineMs ?? item.expiresAt;
      const choices: AskChoice[] = windowKind === 'veto'
        ? [{ id: 'acknowledge', label: 'Let it go ahead', key: 'y', value: 'go' }, { id: 'object', label: 'Stop it', key: 'n', default: true, value: 'stop' }]
        : windowKind === 'approval'
          ? [{ id: 'once', label: 'Yes, buy it', key: 'y', value: 'approve' }, { id: 'no', label: 'No', key: 'n', default: true, value: 'deny' }]
          : [{ id: 'acknowledge', label: 'OK', key: 'y', default: true, value: 'ok' }];
      return {
        ...base, kind: 'purchase', mark: 'ask', question,
        ...(purchase?.merchant ? { subject: { kind: 'money' as const, lines: [purchase.merchant] } } : {}),
        body: firstLine(item.detail),
        ...(budget ? { consequence: { text: budget, withPlace: budget, tone: 'plain' as const } } : {}),
        choices, remember: noRemember, typeToRefuse: false,
        // A veto window goes ahead by itself at its deadline; an approval window only waits (silence refuses it).
        ...(deadline !== undefined && windowKind !== undefined ? { countdown: { verb: windowKind === 'veto' ? 'goes ahead' : 'waits for you', at: deadline } } : {}),
        why: windowKind === 'veto' ? 'A purchase inside your limits goes ahead unless you stop it before the time runs out.'
          : 'A purchase over what you allow without asking needs your yes.',
        details: [{ label: 'Notice', value: item.detail }, ...(deadline !== undefined ? [{ label: windowKind === 'veto' ? 'Goes ahead at' : 'Waits until', value: new Date(deadline).toISOString() }] : [])],
        title: question,
      };
    }
    case 'report':
      return {
        ...base, kind: 'report', mark: 'question', question: item.title, body: firstLine(item.detail),
        choices: [{ id: 'acknowledge', label: 'Mark as read', key: 'y', default: true, value: 'read' }],
        remember: noRemember, typeToRefuse: false,
        why: 'A scheduled run or a trigger answered while no one was watching; its answer waits here.',
        details: [{ label: 'Report', value: item.detail }],
        title: item.title,
      };
    case 'approval':
    default:
      return {
        ...base, kind: 'other-tool', mark: 'ask', question: item.title, body: firstLine(item.detail),
        choices: [{ id: 'once', label: 'Yes, once', key: 'y', default: true }, { id: 'no', label: 'No', key: 'n' }],
        remember: noRemember, typeToRefuse: true,
        details: [{ label: 'Detail', value: item.detail }],
        title: item.title,
      };
  }
}
