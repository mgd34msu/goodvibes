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
import { toolActivityFallback, toolCallActivity } from '@goodvibes/engine/contracts';
import { toolActivityOf, toolDescriptionOf } from '../tools/registry.js';
import { extractHostname } from '../tools/fetch/trust-tiers.js';
import { extractPathArgs } from '../runtime/permissions/rules/path-scope.js';
import { changesMcpTrust, ownerOnlyReason, type OwnerOnlyKind } from '../gate/classify.js';
import { archetypeDisplayName } from '../agents/archetypes.js';
import type { OwnerItem } from '../control-plane/owner-inbox.js';
import type { PermissionPromptRequest } from './prompt.js';
import type { RememberTier } from './approval-rules.js';
import { buildPermissionApprovalBrief } from './briefs/build.js';
import { execRunPlace, permissionSubject } from './subject.js';
import { composeConsequence, folderName, readingAnswer, undoFactOf, commandEffect, type SandboxFact } from './ask-consequence.js';
import { modeInForceLine, type ModeInForceWords } from './decision-model-readiness.js';
import { HELD_OWNER_ONLY_METADATA } from './held-for-owner.js';
import { PURCHASE_AMOUNT_METADATA, PURCHASE_DEADLINE_METADATA, PURCHASE_ITEM_METADATA, PURCHASE_SHOP_METADATA, PURCHASE_STANDING_METADATA } from '../payments/payment-ports.js';
import { formatMinorUnits } from '../payments/message.js';
import { minorUnitExponent } from '../payments/money-parsing.js';

export type AskKind =
  | 'run-command' | 'answer-command-prompt' | 'change-files' | 'fetch' | 'start-agent' | 'hand-off-work'
  | 'change-setting' | 'mcp-tool' | 'other-tool' | 'purchase' | 'send-message' | 'question' | 'decision' | 'claim' | 'queued-action' | 'report'
  /** A model whose price moved away from free since it was chosen, asked before the first send to it. */
  | 'model-price';

/** The `mode` of the `model` ask PermissionManager.askModelPriceChange raises. */
export const MODEL_PRICE_CHANGE_MODE = 'price-change';

/**
 * The refusal reason a surface sends for "Choose another model" (choice id
 * `choose-model`): the turn is not sent and the person picks another model.
 */
export const MODEL_CHOICE_REASON = 'choose another model';

const MODEL_PRICE_CONSEQUENCE_TEXT = 'Each message to it is charged from now on. A yes is asked once for this change; No sends nothing.';
const MODEL_PRICE_CONSEQUENCE = { text: MODEL_PRICE_CONSEQUENCE_TEXT, withPlace: MODEL_PRICE_CONSEQUENCE_TEXT, tone: 'plain' as const };

export interface AskChoice {
  /** `choose-model`: refuse, and choose another model (a surface sends MODEL_CHOICE_REASON as the reason). */
  readonly id: 'once' | 'remember' | 'no' | 'apply-selected' | `option:${number}` | 'own-words' | 'object' | 'acknowledge' | 'choose-model';
  /** "Yes, once" | "Yes, and remember (choose what)" | "No" | "Hello" | "Something else…" */
  readonly label: string;
  /** The terminal key: 'y' | 'a' | 'n' | '1'..'8'. */
  readonly key?: string | undefined;
  /** The selected button when the card opens. */
  readonly default?: true | undefined;
  readonly danger?: true | undefined;
  /** For an `option:<n>` choice: the option's own value, as the inbox answers it. */
  readonly value?: string | undefined;
  /**
   * The one line an answered ask folds to, for a yes that is not remembered:
   * "You said yes once", or what a lasting change keeps doing ("You switched it
   * off; it stays off until you turn it back on").
   */
  readonly said?: string | undefined;
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
  /** The ask changes a setting so that it protects less (lists put it before ordinary asks). */
  readonly weakensSafety?: true | undefined;
  readonly choices: readonly AskChoice[];
  readonly remember:
    | { readonly offered: true; readonly tiers: readonly RememberTierView[] }
    | { readonly offered: false; readonly why: string };
  /** The card takes a typed reason to refuse (its "w say why" key). */
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

/**
 * The ask's words for a list row or an event: the question, place, subject,
 * consequence, choices, remember tiers, why and title. The details (the tool,
 * the arguments as JSON, the checklist, the review reasons) are left for the
 * read of one item, so a list of asks stays small.
 */
export function compactAskPresentation(presentation: AskPresentation): AskPresentation {
  return { ...presentation, details: [] };
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
  /** The name of the schedule a session runs for, when a schedule's run made it ("Order filters"). */
  readonly scheduleOfSession?: ((sessionId: string) => string | undefined) | undefined;
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

/** Imperatives a regular rule would get wrong ("Analyzing" is "Analyze", "Using" is "Use"). */
const IMPERATIVES: Readonly<Record<string, string>> = {
  Analyzing: 'Analyze', Using: 'Use', Writing: 'Write', Sharing: 'Share', Scheduling: 'Schedule', Creating: 'Create',
  Saving: 'Save', Removing: 'Remove', Changing: 'Change', Managing: 'Manage', Comparing: 'Compare', Generating: 'Generate',
  Consolidating: 'Consolidate', Updating: 'Update', Configuring: 'Configure', Ingesting: 'Ingest', Preparing: 'Prepare',
  Delegating: 'Delegate', Composing: 'Compose', Browsing: 'Browse', Starting: 'Start', Handing: 'Hand',
};

/** The imperative of a running verb: "Searching" → "Search", "Running" → "Run", "Working on" → "Work on". */
function imperativeOf(doing: string): string {
  const [first, ...rest] = doing.split(' ');
  const tail = rest.length > 0 ? ` ${rest.join(' ')}` : '';
  const word = first!;
  const known = IMPERATIVES[word];
  if (known) return `${known}${tail}`;
  if (!word.endsWith('ing') || word.length < 5) return doing;
  const base = word.slice(0, -3);
  // A doubled last consonant (Running, Stopping) is one in the imperative; ll and ss stay.
  if (/([bdfgmnprt])\1$/.test(base)) return `${base.slice(0, -1)}${tail}`;
  // A silent e dropped before -ing (Writing, Sharing): consonant, vowel, consonant other than w, x, y.
  if (/[^aeiou][aeiou][bcdgkmnprstvz]$/i.test(base) && !/(en|er|on|it|et|ol)$/.test(base)) return `${base}e${tail}`;
  return `${base}${tail}`;
}

/** The call's action (else mode) word, when it has one. */
function actionWord(args: Record<string, unknown>): string | undefined {
  return typeof args['action'] === 'string' ? args['action'] : typeof args['mode'] === 'string' ? args['mode'] : undefined;
}

/**
 * The question for tools whose display words do not make one (they declare
 * none, or only a verb), written from what each tool's description says it
 * does. Keyed by the registered name; the call's action picks the sentence.
 */
const TOOL_QUESTIONS: Readonly<Record<string, (args: Record<string, unknown>) => string>> = {
  workflow: () => 'Change an automation (a hook, schedule or trigger)?',
  mcp: (args) => {
    switch (actionWord(args)) {
      case 'set-trust': return `Change how far ${textArg(args, 'serverName') ?? 'a tool server'} is trusted?`;
      case 'set-role': return `Change what ${textArg(args, 'serverName') ?? 'a tool server'} is used for?`;
      case 'approve-quarantine': return `Let ${textArg(args, 'serverName') ?? 'a held tool server'} start working again?`;
      case 'call': return 'Use a tool from a tool server?';
      default: return 'Use a tool server?';
    }
  },
  repl: () => 'Run a snippet of code in the sandbox?',
  control: () => 'Use one of GoodVibes\'s own controls?',
  channel: (args) => /run/.test(actionWord(args) ?? '') ? 'Run an action on a chat app?' : 'Act on a chat app?',
  profile: (args) => ['set', 'record', 'update', 'add', 'forget', 'remove', 'delete'].includes(actionWord(args) ?? '') ? 'Record something about you?' : 'Read what GoodVibes knows about you?',
  occasions: () => 'Change an occasion or trip?',
  agent_notify: () => 'Send a notification?',
  agent_model_compare_candidate: () => 'Run one model for a comparison?',
  agent_research_runs: () => 'Start or update a research run?',
  accounts: () => 'Change the list of your accounts?',
  connected_calendar: (args) => {
    switch (actionWord(args)) {
      case 'create': return 'Add an event to your calendar?';
      case 'update': return 'Change a calendar event?';
      case 'delete': case 'cancel': return 'Delete a calendar event?';
      default: return 'Use your calendar?';
    }
  },
};

/** What a tool does, in a sentence: its description's first sentence, when it opens with a verb. */
function descriptionQuestion(tool: string): string | undefined {
  const description = toolDescriptionOf(tool);
  if (!description) return undefined;
  const first = description.replace(/\s+/g, ' ').trim().split(/(?<=[.!?:;])\s|\s\(|,\s/)[0]!.replace(/[.!?:;]+$/, '').trim();
  // A noun phrase ("The calendars…", "Register of…") is not a question a person can answer.
  if (first === '' || /^(the|a|an|this|these|register|list of)\b/i.test(first) || first.split(' ').length < 2) return undefined;
  const words = first.split(' ');
  let sentence = '';
  for (const word of words) {
    if (`${sentence} ${word}`.trim().length > 60) break;
    sentence = `${sentence} ${word}`.trim();
  }
  return `${capitalize(sentence.replace(/\b(and|or|with|using|through|to|of|the|a|an)$/i, '').trim())}?`;
}

/**
 * A call's amount in the one payments formatter's words (payments/message.ts
 * formatMinorUnits: "$64.00", "CHF 12.00"): from minor units, or a plain or
 * code-prefixed decimal with its currency; an amount already written with a
 * symbol is shown as written.
 */
function moneyWords(args: Record<string, unknown>): string | undefined {
  const minor = [args['totalMinorUnits'], args['amountMinorUnits'], args['priceMinorUnits']].find((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) as number | undefined;
  const raw = textArg(args, 'amount', 'price', 'total', 'cost');
  const coded = raw !== undefined ? /^([A-Z]{3})\s*([\d,]+(?:\.\d+)?)$/.exec(raw) : null;
  const currency = (coded?.[1] ?? textArg(args, 'currency'))?.toUpperCase();
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      if (minor !== undefined) return formatMinorUnits(minor as never, currency as never);
      const decimal = coded?.[2] ?? (raw !== undefined && /^[\d,]+(?:\.\d+)?$/.test(raw) ? raw : undefined);
      if (decimal !== undefined) {
        const units = Math.round(Number(decimal.replace(/,/g, '')) * 10 ** minorUnitExponent(currency as never));
        if (Number.isSafeInteger(units)) return formatMinorUnits(units as never, currency as never);
      }
    } catch { /* an unknown currency is shown as written */ }
  }
  return raw;
}

/** "a, b and 2 more" for a list a sentence names. */
function listShort(items: readonly string[]): string {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, 2).join(', ')} and ${items.length - 2} more`;
}

/** A tool's own name as words ("create_issue" → "create issue"). */
function nameWords(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
}

/**
 * "Search the web?" from the tool's own display words; else a sentence from
 * its description; never the tool's name as if it were words.
 */
function toolQuestion(tool: string, args: Record<string, unknown>): string {
  const written = TOOL_QUESTIONS[tool];
  if (written) return written(args);
  const words = toolCallActivity(toolActivityOf(tool), args);
  if (words?.object) return `${imperativeOf(words.doing)} ${words.object}?`;
  if (tool.includes('__')) {
    // A plugin or MCP tool registered as <source>__<tool>: its title and where it comes from.
    const parts = tool.split('__');
    return `Use ${nameWords(parts[parts.length - 1]!)} from ${parts.slice(tool.startsWith('mcp__') ? 1 : 0, -1).join(' ') || 'a tool server'}?`;
  }
  return descriptionQuestion(tool) ?? (words ? `${imperativeOf(words.doing)}?` : 'Allow this action?');
}

function textArg(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** The recipients a send names, as written ("alex@example.com", "#garden"). */
function recipientsOf(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const name of ['to', 'recipient', 'recipients', 'cc', 'bcc', 'channel', 'chatId', 'chat_id']) {
    const value = args[name];
    if (typeof value === 'string' && value.trim() !== '') out.push(value.trim());
    else if (Array.isArray(value)) for (const entry of value) if (typeof entry === 'string' && entry.trim() !== '') out.push(entry.trim());
  }
  return [...new Set(out)];
}

/** Which kind of ask a permission request is. */
export function askKindOf(request: Pick<PermissionPromptRequest, 'tool' | 'args' | 'attribution' | 'category'> & { readonly ownerOnly?: PermissionPromptRequest['ownerOnly'] }): AskKind {
  const attribution = request.attribution;
  if (attribution?.kind === 'exec-prompt') return 'answer-command-prompt';
  if (attribution?.kind === 'fetch-localhost') return 'fetch';
  if (attribution?.kind === 'mcp-server') return 'mcp-tool';
  const tool = request.tool;
  const args = request.args;
  const mode = typeof args['mode'] === 'string' ? args['mode'] : undefined;
  if (tool === 'exec' || attribution?.kind === 'sandbox-escalation') return 'run-command';
  if (tool === 'write' || tool === 'edit') return 'change-files';
  if (tool === 'fetch') return 'fetch';
  if (tool === 'agent' && (mode === 'spawn' || mode === 'batch-spawn')) return 'start-agent';
  if (tool === 'delegate' || (tool === 'agent' && mode === 'message')) return 'hand-off-work';
  if (tool === 'goodvibes_settings') return 'change-setting';
  if (tool === 'model' && mode === MODEL_PRICE_CHANGE_MODE) return 'model-price';
  // Money and sends are read from what the gate holds them for, whatever the tool is called.
  if (request.ownerOnly === 'spend-over-limit' || request.ownerOnly === 'payment-step') return 'purchase';
  if (request.ownerOnly === 'new-recipient' || request.ownerOnly === 'untrusted-derived-send') return 'send-message';
  // A tool that sets a key to a value under a settings or config name changes a setting.
  if (/setting|config/i.test(tool) && typeof args['key'] === 'string' && ('value' in args || mode === 'reset')) return 'change-setting';
  if (tool === 'mcp' || tool.startsWith('mcp__')) return 'mcp-tool';
  return 'other-tool';
}

function whoAsked(request: PermissionPromptRequest): string | undefined {
  const attribution = request.attribution;
  switch (attribution?.kind) {
    // An agent this chat started, by its display name; everything else this chat's own work asked is GoodVibes's ask.
    case 'background-agent': return attribution.template ? `the ${lowerFirst(archetypeDisplayName(attribution.template))}` : 'the agent';
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

/**
 * The choice that says yes and remembers it. It opens a list of how far the
 * remembering reaches (this command, this tool here, ...), so the label says a
 * choice follows; Enter never picks it.
 */
const REMEMBER_CHOICE_LABEL = 'Yes, and remember (choose what)';

/** The yes for a call that acts once and keeps nothing in force afterwards; a standing change says what it does instead (lastingYesOf). */
export const ONCE_LABEL = 'Yes, once';

/**
 * The owner-only kinds whose ask opens on No in every program (the terminal
 * card, the web card, the inbox card, a held call): a yes that cannot be taken
 * back (a delete nothing restores, an irreversible operator act, money spent, a
 * payment step, a message sent as the owner) or one that weakens a protection
 * (a loosened security, judgment or payment setting; access granted to a
 * person, device, tool server or hook). The one list: every surface reads the
 * choice marked `default`, built from it.
 */
const OPENS_ON_NO: ReadonlySet<OwnerOnlyKind> = new Set<OwnerOnlyKind>([
  'unrecoverable-delete', 'irreversible-operator', 'spend-over-limit', 'payment-step', 'new-recipient', 'untrusted-derived-send',
  'loosen-security', 'grant-access',
]);

/** Whether an ask held for the owner for this owner-only kind opens on No. */
export function ownerOnlyOpensOnNo(ownerOnly: string | undefined): boolean {
  return ownerOnly !== undefined && OPENS_ON_NO.has(ownerOnly as OwnerOnlyKind);
}

/**
 * A yes whose effect lasts after this one call: the button says what it does,
 * the card says how long it stays, and the folded line says what was done.
 */
interface LastingYes {
  readonly label: string;
  readonly lasting: string;
  readonly said: string;
}

/** A setting value as on or off, when it is one. */
function settingOnOff(value: unknown): 'on' | 'off' | undefined {
  return value === true || value === 'on' || value === 'true' ? 'on' : value === false || value === 'off' || value === 'false' ? 'off' : undefined;
}

/**
 * What a yes keeps doing, for the calls whose effect is a standing change: a
 * setting (every goodvibes_settings write is saved to the settings file,
 * tools/goodvibes-runtime/config-routing.ts applyRoutedConfigWrite), a tool
 * server's trust, a hook, an automation, a loosened protection put to the owner,
 * a contract's requirement. Undefined for a call that acts once.
 */
function lastingYesOf(kind: AskKind, request: PermissionPromptRequest): LastingYes | undefined {
  const args = request.args;
  if (kind === 'change-setting') {
    const saved = request.tool === 'goodvibes_settings';
    const sentence = (rest: string): string => (saved ? `Saved to your settings: ${rest}` : capitalize(rest));
    if (args['mode'] === 'reset') {
      return { label: 'Yes, reset it to its default', lasting: sentence('it keeps its default until you change it.'), said: 'You reset it to its default' };
    }
    switch (settingOnOff(args['value'])) {
      case 'off': return { label: 'Yes, switch it off until I turn it back on', lasting: sentence('it stays off until you turn it back on.'), said: 'You switched it off; it stays off until you turn it back on' };
      case 'on': return { label: 'Yes, switch it on until I turn it off', lasting: sentence('it stays on until you turn it off.'), said: 'You switched it on; it stays on until you turn it off' };
      default: return { label: 'Yes, change it until I change it back', lasting: sentence('it keeps the new value until you change it.'), said: 'You changed it; it keeps the new value until you change it' };
    }
  }
  if (changesMcpTrust(request.tool, args)) {
    const what = args['mode'] === 'set-role' ? 'its role' : args['mode'] === 'approve-quarantine' ? 'it back to work' : 'its trust';
    return args['mode'] === 'approve-quarantine'
      ? { label: 'Yes, let it work again', lasting: 'It stays allowed until it is held again.', said: 'You let it work again; it stays allowed until it is held again' }
      : { label: `Yes, change ${what} until I change it back`, lasting: 'It stays this way until you change it back.', said: `You changed ${what}; it stays this way until you change it back` };
  }
  if (request.tool === 'state' && args['mode'] === 'hooks') {
    switch (args['hookAction']) {
      case 'add': return { label: 'Yes, add the hook until I remove it', lasting: 'The hook runs on every event it matches until you remove it.', said: 'You added the hook; it runs until you remove it' };
      case 'enable': return { label: 'Yes, turn the hook on until I turn it off', lasting: 'The hook runs on every event it matches until you turn it off.', said: 'You turned the hook on; it runs until you turn it off' };
      case 'disable': return { label: 'Yes, turn the hook off until I turn it back on', lasting: 'The hook stays off until you turn it back on.', said: 'You turned the hook off; it stays off until you turn it back on' };
      default: return { label: 'Yes, remove the hook', lasting: 'The hook is removed; adding it again asks again.', said: 'You removed the hook' };
    }
  }
  if (request.tool === 'workflow') {
    const action = args['mode'] === 'hook-actions' ? args['hookAction'] : args['mode'] === 'schedule' ? args['scheduleAction'] : undefined;
    if (action === 'add' || action === 'enable') {
      return { label: 'Yes, keep it running until I remove it', lasting: 'It runs each time it is due until you remove it or GoodVibes closes.', said: 'You said yes; it runs until you remove it or GoodVibes closes' };
    }
  }
  if (request.ownerOnly === 'loosen-security') {
    return { label: 'Yes, make this change until I change it back', lasting: 'It stays in force until you change it back.', said: 'You made the change; it stays in force until you change it back' };
  }
  if (request.ownerOnly === 'change-contract') {
    return { label: 'Yes, change what it requires', lasting: 'The contract keeps the new requirement until it is changed again.', said: 'You changed what the contract requires' };
  }
  return undefined;
}

function approvalChoices(kind: AskKind, remember: AskPresentation['remember'], cannotUndo: boolean, tool: string, opensOnNo: boolean, lasting: LastingYes | undefined): AskChoice[] {
  if (kind === 'answer-command-prompt') {
    return [{ id: 'once', label: 'Send the answer', key: 'y', default: true, said: 'You sent the answer' }, { id: 'no', label: 'No', key: 'n' }];
  }
  if (kind === 'model-price') {
    // Money is spent on a yes: it opens on No, as a purchase outside the limits does.
    return [
      { id: 'once', label: 'Yes, keep using it', key: 'y', said: 'You kept using it at its new price' },
      { id: 'no', label: 'No', key: 'n', default: true },
      { id: 'choose-model', label: 'Choose another model', key: 'm' },
    ];
  }
  const opens =cannotUndo ? { danger: true as const } : opensOnNo ? {} : { default: true as const };
  const yes: AskChoice = kind === 'change-files' && tool === 'edit'
    ? { id: 'apply-selected', label: 'Apply selected', key: 'y', ...opens }
    : lasting
      ? { id: 'once', label: lasting.label, key: 'y', ...opens, said: lasting.said }
      : { id: 'once', label: ONCE_LABEL, key: 'y', ...opens, said: 'You said yes once' };
  return [
    yes,
    ...(remember.offered ? [{ id: 'remember' as const, label: REMEMBER_CHOICE_LABEL, key: 'a' }] : []),
    { id: 'no', label: 'No', key: 'n', ...(opensOnNo ? { default: true as const } : {}) },
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
      // The setting by the name the settings list shows it under, quoted: the names are phrases ("Run commands in a sandbox").
      const name = `"${label}"`;
      const value = args['value'];
      const onOff = settingOnOff(value);
      const question = args['mode'] === 'reset' ? `Reset ${name} to its default?`
        : onOff !== undefined ? `Turn ${onOff} ${name}?`
          : `Change ${name} to ${typeof value === 'string' || typeof value === 'number' ? clipLine(String(value), 40) : clipLine(String(JSON.stringify(value) ?? ''), 40)}?`;
      return { question, title: question };
    }
    case 'model-price': {
      const model = textArg(args, 'model') ?? 'This model';
      const price = textArg(args, 'price');
      const question = `${model} is no longer free${price ? `: about ${price}` : ''}. Keep using it?`;
      return { question, title: `${model} is no longer free. Keep using it?` };
    }
    case 'purchase': {
      const item = textArg(args, 'item', 'product', 'title', 'description');
      const shop = textArg(args, 'merchant', 'shop', 'store', 'merchantName', 'merchantDomain', 'site');
      const money = moneyWords(args);
      const question = item ? `Buy ${item}${shop ? ` from ${shop}` : ''}${money ? ` for ${money}` : ''}?`
        : shop && money ? `Pay ${shop} ${money}?` : shop ? `Pay ${shop}?` : money ? `Pay ${money}?` : 'Make this payment?';
      return { question, title: question };
    }
    case 'send-message': {
      const recipients = recipientsOf(args);
      const email = /mail/i.test(request.tool) || recipients.some((recipient) => recipient.includes('@'));
      const to = recipients.length > 0 ? listShort(recipients) : undefined;
      const question = `Send ${email ? 'an email' : 'a message'}${to ? ` to ${to}` : ''}?`;
      return { question, title: question };
    }
    case 'mcp-tool': {
      // The mcp tool's own call names its target as mcp:<server>:<tool>.
      const qualified = typeof args['qualifiedName'] === 'string' ? /^mcp:([^:]+):(.+)$/.exec(args['qualifiedName']) : null;
      if (qualified) {
        const question = `Use ${nameWords(qualified[2]!)} from ${qualified[1]}?`;
        return { question, title: question };
      }
      const server = request.attribution?.kind === 'mcp-server' ? request.attribution.serverName
        : typeof args['server'] === 'string' ? args['server'] : request.tool.startsWith('mcp__') ? request.tool.split('__')[1] : undefined;
      const toolName = typeof args['tool'] === 'string' ? args['tool'] : request.tool.startsWith('mcp__') ? request.tool.split('__').pop() : undefined;
      // The mcp tool's own listing and trust modes have display words of their own.
      if (server === undefined) return { question: toolQuestion(request.tool, args), title: toolQuestion(request.tool, args) };
      const question = toolName ? `Use ${nameWords(toolName)} from ${server}?` : `Answer ${server}'s request?`;
      return { question, title: question };
    }
    default: {
      const question = toolQuestion(request.tool, args);
      return { question, title: question };
    }
  }
}

function subjectOf(kind: AskKind, request: PermissionPromptRequest, values: readonly string[]): AskPresentation['subject'] {
  // A send acts on its subject line; a purchase on the shop; an MCP call on its input, one value per line.
  if (kind === 'send-message') {
    const subject = textArg(request.args, 'subject', 'title');
    return subject ? { kind: 'text', lines: [subject] } : undefined;
  }
  if (kind === 'purchase') {
    const shop = textArg(request.args, 'merchant', 'shop', 'store', 'merchantName', 'merchantDomain', 'site');
    return shop ? { kind: 'money', lines: [shop] } : undefined;
  }
  const mcpInput = kind !== 'mcp-tool' ? undefined
    : request.args['input'] && typeof request.args['input'] === 'object' ? request.args['input'] as Record<string, unknown>
      : request.tool.startsWith('mcp__') ? request.args : undefined;
  if (mcpInput) {
    const lines = Object.entries(mcpInput)
      .map(([key, value]) => `${nameWords(key)}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    return lines.length > 0 ? { kind: 'text', lines } : undefined;
  }
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

/** Where the asked call runs: an exec call's own working directory, else the request's, else the surface's. */
function askDirectory(request: PermissionPromptRequest, facts: Pick<AskFacts, 'workingDirectory'>): string | undefined {
  const runPlace = request.tool === 'exec' ? execRunPlace(request.args).workingDirectory : undefined;
  return runPlace ?? request.workingDirectory ?? facts.workingDirectory;
}

/**
 * The question of a permission ask on its own ("Run this command?", "Delete
 * files? This can't be undone."), for a surface that shows only the heading.
 */
export function approvalQuestion(request: PermissionPromptRequest, facts: Pick<AskFacts, 'workingDirectory' | 'settingLabel'> = {}): string {
  const kind = askKindOf(request);
  const subjectValues = permissionSubject(request.tool, request.args).values;
  const words = questionOf(kind, request, facts, subjectValues);
  const directory = askDirectory(request, facts);
  if (!undoFactOf(request.tool, request.args, request.analysis.reading, request.ownerOnly, directory).cannotUndo) return words.question;
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
  const directory = askDirectory(request, facts);
  const undo = undoFactOf(request.tool, request.args, reading, request.ownerOnly, directory);
  const cannotUndo = undo.cannotUndo;
  const place = placeOf(directory, facts.homeDirectory);
  const words = questionOf(kind, request, facts, subjectValues);
  const commands = kind === 'run-command' ? subjectValues : [];
  const destroys = commands.length === 1 ? commandEffect(commands[0]!)?.undoQuestion : undefined;
  const question = cannotUndo ? `${destroys ?? words.question} ${CANNOT_UNDO}` : words.question;
  const hosts = kind === 'fetch'
    ? [...new Set(subjectValues.flatMap((url) => extractHostname(url) ?? []))].concat(request.attribution?.kind === 'fetch-localhost' ? [request.attribution.host] : [])
    : undefined;
  // The gate's own fact (it holds the call because it loosens a protection) needs no decision model; the reading's answer is the other way to know.
  const weakensSetting = kind === 'change-setting' && (request.ownerOnly === 'loosen-security' || readingAnswer(reading, 'weakensSecurity') === 'yes');
  const lasting = lastingYesOf(kind, request);
  // What weakens a protection or cannot be undone opens on No, wherever it is shown.
  const opensOnNo = cannotUndo || weakensSetting || ownerOnlyOpensOnNo(request.ownerOnly);
  const consequence = composeConsequence({
    toolName: request.tool, args: request.args, reading, undo,
    ...(directory !== undefined ? { workingDirectory: directory } : {}),
    ...(place ? { placeShort: place.short } : {}),
    ...(kind === 'run-command' && facts.sandbox ? { sandbox: facts.sandbox } : {}),
    ...(facts.checkpointCovers ? { checkpointCovers: facts.checkpointCovers } : {}),
    ...(hosts && hosts.length > 0 ? { hosts: [...new Set(hosts)] } : {}),
    weakensSetting,
    ...(lasting ? { lasting: lasting.lasting } : {}),
  });
  const remember: AskPresentation['remember'] = kind === 'model-price' ? { offered: false, why: 'asked once for this price change' } : rememberOf(request, cannotUndo);
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
    { label: 'Decision', value: modeInForceLine(facts.modeInForce) },
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
    ...(place && kind !== 'model-price' ? { place } : {}),
    ...(kind !== 'model-price' && subjectOf(kind, request, subjectValues) ? { subject: subjectOf(kind, request, subjectValues)! } : {}),
    ...(kind === 'model-price' ? { consequence: MODEL_PRICE_CONSEQUENCE } : consequence ? { consequence } : {}),
    ...(weakensSetting ? { weakensSafety: true as const } : {}),
    choices: approvalChoices(kind, remember, cannotUndo, request.tool, opensOnNo, lasting),
    remember,
    typeToRefuse: kind !== 'answer-command-prompt' && kind !== 'model-price',
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
        why: 'Jev, the decision model, decided this in your place; you can keep it, undo it, or set a standing rule for calls like it.',
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
      // A call held for the owner-only kind it is (held-for-owner.ts posts it) opens on No like the ask it stands for.
      const opensOnNo = ownerOnlyOpensOnNo(metadataText(item, HELD_OWNER_ONLY_METADATA));
      return {
        ...base, kind: 'queued-action', mark: 'ask', question: 'Let this held action run?',
        ...(summary ? { subject: { kind: 'text' as const, lines: [summary] } } : {}),
        consequence: { text: 'It runs when the work carries on.', withPlace: 'It runs when the work carries on.', tone: 'plain' },
        choices: [
          { id: 'once', label: 'Yes, let it run', key: 'y', value: 'approve', said: 'You let it run', ...(opensOnNo ? {} : { default: true as const }) },
          { id: 'no', label: 'No', key: 'n', value: 'dismiss', ...(opensOnNo ? { default: true as const } : {}) },
        ],
        remember: noRemember, typeToRefuse: false,
        why: 'Just vibes held this for you instead of interrupting the work.',
        details: [{ label: 'Detail', value: item.detail }],
        title: summary ? `Let it run: ${clipLine(summary, 50)}?` : 'Let a held action run?',
      };
    }
    case 'purchase': {
      const purchaseId = metadataText(item, 'purchaseId');
      // The window's facts as the payments host posted them on the item (payments/host/notifier.ts), else the host's lookup.
      const posted = metadataText(item, PURCHASE_ITEM_METADATA);
      const purchase: Partial<PurchaseAskFacts> | undefined = (purchaseId !== undefined ? facts.purchase?.(purchaseId) : undefined)
        ?? (posted !== undefined ? { item: posted, merchant: metadataText(item, PURCHASE_SHOP_METADATA), price: metadataText(item, PURCHASE_AMOUNT_METADATA) } : undefined);
      const windowKind = purchase?.kind ?? (item.options.includes('go') ? 'veto' : item.options.includes('approve') ? 'approval' : undefined);
      const question = purchase?.item && purchase.price ? `Buy ${purchase.item}${purchase.merchant ? ` from ${purchase.merchant}` : ''} for ${purchase.price}?`
        : windowKind === 'veto' ? 'Let this purchase go ahead?' : windowKind === 'approval' ? 'Approve this purchase?' : 'A purchase update';
      // A veto window opens only for a purchase inside the budget (payments/merchant-recourse.ts windowForPurchase:
      // anything above it gets an approval window), so a veto window is inside it by construction.
      const withinBudget = purchase?.withinBudget ?? (windowKind === 'veto' ? true : undefined);
      const budget = [
        withinBudget === true ? 'Inside your daily budget.' : withinBudget === false ? 'Over your daily budget.' : undefined,
        // The recorded ruling on a stop notice that cannot be delivered (payments/windows.ts), said on the card itself while the window runs.
        windowKind === 'veto' ? 'It goes ahead when the time runs out, even if this notice never reached you.' : undefined,
      ].filter((part): part is string => part !== undefined).join(' ') || undefined;
      // The window's deadline as the host posted it; the item's own expiry is a minute later.
      const postedDeadline = item.metadata?.[PURCHASE_DEADLINE_METADATA];
      const deadline = purchase?.deadlineMs ?? (typeof postedDeadline === 'number' ? postedDeadline : item.expiresAt);
      const choices: AskChoice[] = windowKind === 'veto'
        ? [{ id: 'acknowledge', label: 'Let it go ahead', key: 'y', value: 'go' }, { id: 'object', label: 'Stop it', key: 'n', default: true, value: 'stop' }]
        : windowKind === 'approval'
          ? [{ id: 'once', label: 'Yes, buy it', key: 'y', value: 'approve' }, { id: 'no', label: 'No', key: 'n', default: true, value: 'deny' }]
          : [{ id: 'acknowledge', label: 'OK', key: 'y', default: true, value: 'ok' }];
      // Where it came from: the chat whose turn began it ('From "Plan the spring garden beds"'), or, for a
      // purchase nobody asked for in the moment, the schedule that ran it or the owner's standing authorisation.
      const schedule = item.sessionId !== undefined ? facts.scheduleOfSession?.(item.sessionId) : undefined;
      const standing = item.metadata?.[PURCHASE_STANDING_METADATA] === true;
      const { origin: chatOrigin, ...withoutOrigin } = base;
      const origin = schedule !== undefined ? { by: `your schedule "${schedule}"` }
        : standing ? { by: 'your standing authorisation' } : chatOrigin;
      return {
        ...withoutOrigin, ...(origin ? { origin } : {}), kind: 'purchase', mark: 'ask', question,
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
        choices: [{ id: 'once', label: ONCE_LABEL, key: 'y', default: true, said: 'You said yes once' }, { id: 'no', label: 'No', key: 'n' }],
        remember: noRemember, typeToRefuse: true,
        details: [{ label: 'Detail', value: item.detail }],
        title: item.title,
      };
  }
}
