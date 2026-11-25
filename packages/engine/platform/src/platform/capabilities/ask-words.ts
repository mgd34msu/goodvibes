/**
 * ask-words.ts, how an ask for a model's `capability_run` call reads: the
 * capability's own label as the question ("Bind a key to an action?"), its
 * sentence filled from the inputs, and each input on a labelled line, a
 * secret one hidden. Never the call's arguments as JSON. Each program that
 * decides such calls registers it over the catalog it decides by (the
 * terminal programs' own, the daemon's).
 */
import { presentToolAskWith } from '../permissions/tool-ask-words.js';
import { methodAskWords } from '../control-plane/native-mutation-words.js';
import { CAPABILITY_RUN_TOOL } from '../tools/capability/definitions.js';
import type { CapabilityEntry } from './catalog.js';
import { fillSentence, hiddenSecret, lastsWords } from './outcome.js';
import { RISK_WORDS, type FixedChoice } from './types.js';

function valueText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.join(', ');
  return undefined;
}

const clip = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** A thing's title by the id an input carries, from the live list the input chooses from; undefined when not known. */
export type CapabilityValueTitle = (list: string, value: string) => string | undefined;
const titlers = new Set<CapabilityValueTitle>();

/**
 * Name the things an ask's inputs carry by their titles (a session, a schedule, a device, a piece of work): the
 * process that words the ask registers what it can look up at once. Returns the unregister.
 */
export function nameCapabilityValuesWith(titler: CapabilityValueTitle): () => void {
  titlers.add(titler);
  return () => { titlers.delete(titler); };
}

function titleOf(list: string, value: string): string | undefined {
  for (const titler of titlers) {
    try {
      const title = titler(list, value)?.trim();
      if (title && title !== value) return title;
    } catch { /* a lookup that failed names nothing */ }
  }
  return undefined;
}

/**
 * The words of one capability_run call, or undefined when its id names no capability of `lookup`. `methodTitle` reads
 * a daemon method's catalog title: a method named by its id is asked in the words every daemon method a model reaches
 * is asked in (control-plane/native-mutation-words.ts `methodAskWords`).
 */
export function capabilityAskWords(lookup: (id: string) => CapabilityEntry | undefined, args: Readonly<Record<string, unknown>>, methodTitle: (method: string) => string | undefined = () => undefined) {
  const id = typeof args['id'] === 'string' ? args['id'].trim() : '';
  if (!id) return undefined;
  const entry = lookup(id);
  const raw = args['inputs'] && typeof args['inputs'] === 'object' && !Array.isArray(args['inputs']) ? args['inputs'] as Record<string, unknown> : {};
  if (!entry) return methodAskWords(id, raw, methodTitle, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  // A secret input whose `plainWhen` holds for what the call gives is no secret for it (a setting that holds no key):
  // its value is shown, as the call carried it in clear.
  const given = Object.fromEntries(Object.entries(raw).flatMap(([name, value]) => { const text = valueText(value); return text === undefined ? [] : [[name, text]]; }));
  const secret = new Set(entry.inputs.filter((input) => input.kind === 'secret' && input.plainWhen?.(given) !== true).map((input) => input.id));
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const text = valueText(value);
    // A blank value (an optional input left at its default, "this machine's daemon") says nothing: it is not listed.
    // A secret's value arrives hidden already ("(hidden, 12 characters)"); it is never shown, whatever arrived.
    if (text !== undefined && text.trim() !== '' && !/^\(hidden, 0 characters\)$/.test(text)) values[name] = secret.has(name) ? (text.startsWith('(hidden') ? text : hiddenSecret(text)) : clip(text.replace(/\s+/g, ' '), 120);
  }
  // A choice is shown by its label ("Open the menu"); a thing from a live list (a session, a schedule, a device) by its
  // title, never by an id a person does not know.
  const shown = Object.fromEntries(Object.entries(values).map(([name, value]) => {
    const input = entry.inputs.find((candidate) => candidate.id === name);
    const choice = input && Array.isArray(input.choices) ? (input.choices as readonly FixedChoice[]).find((candidate) => candidate.value === value) : undefined;
    if (choice) return [name, choice.label !== value ? choice.label : value];
    const list = input && input.kind !== 'secret' && input.choices && !Array.isArray(input.choices) ? (input.choices as { readonly list: string }).list : undefined;
    const title = list ? titleOf(list, value) : undefined;
    return [name, title ? `"${clip(title.replace(/\s+/g, ' '), 100)}"` : value];
  }));
  // The capability's own risk, in plain words (a choice that raises it counts); none, no line.
  const chosenRisk = entry.inputs.flatMap((input) => Array.isArray(input.choices)
    ? (input.choices as readonly FixedChoice[]).filter((choice) => choice.value === values[input.id] && choice.risk !== undefined).map((choice) => choice.risk!)
    : []).find((risk) => risk !== 'none');
  const risk = chosenRisk ?? entry.risk;
  const riskLine = risk === 'none' ? undefined : `This ${RISK_WORDS[risk]}.`;
  // "This can't be undone." is the ask's own question (permissions/ask-presentation.ts, every surface): said once there,
  // not again among its lines. Any other risk is said here.
  const lines = [
    // What will really happen with these values, when the capability says it differs (a credential's reset).
    fillSentence(entry.sentenceWhen && entry.sentenceWhen.values.includes(values[entry.sentenceWhen.input] ?? '') ? entry.sentenceWhen.sentence : entry.sentence,
      shown, lastsWords(entry, values)),
    ...entry.inputs.flatMap((input) => shown[input.id] !== undefined ? [`${input.label}: ${shown[input.id]}`] : []),
    // An input the capability does not have is shown as given, so nothing the call carries is left out of the ask.
    ...Object.keys(shown).filter((name) => !entry.inputs.some((input) => input.id === name)).map((name) => `${name}: ${shown[name]}`),
    ...(riskLine && risk !== 'cannot-be-undone' ? [riskLine] : []),
  ];
  return { question: `${entry.label}?`, lines, subject: entry.label, doing: actOf(entry.label), risk: riskLine ?? null };
}

/**
 * A label as an act under way, to start a sentence: "Keep this computer awake" is "Keeping this computer awake", "Stop
 * a repeat purchase" "Stopping a repeat purchase". Only a first word written in GERUNDS takes its -ing form, as
 * written there (never made by rule: "forget" is "forgetting", "never" is no verb); any other label is quoted as a
 * name ("\"Never run a command\"").
 */
function actOf(label: string): string {
  const [first = '', ...rest] = label.trim().split(/\s+/);
  const gerund = GERUNDS[first.toLowerCase()];
  // A second act joined on ("Move a meeting or change an event", "Ask and hear the answer") would stay a bare verb
  // after the -ing one, and a label in the person's own voice ("Ask me", "my phone") reads wrong said of him: quoted.
  const words = rest.map((word) => word.toLowerCase().replace(/[^a-z']/g, ''));
  const secondAct = words.some((word, at) => (word === 'and' || word === 'or') && GERUNDS[words[at + 1] ?? ''] !== undefined);
  const ownVoice = words.some((word) => word === 'me' || word === 'my');
  return gerund && !secondAct && !ownVoice ? [gerund, ...rest].join(' ') : `"${label.trim()}"`;
}

/** The -ing form of each verb a capability's label starts with. A label whose first word is not here is quoted. */
const GERUNDS: Readonly<Record<string, string>> = Object.fromEntries(([
  ['see', 'Seeing'], ['save', 'Saving'], ['check', 'Checking'], ['stop', 'Stopping'], ['add', 'Adding'], ['read', 'Reading'],
  ['make', 'Making'], ['change', 'Changing'], ['run', 'Running'], ['start', 'Starting'], ['send', 'Sending'], ['switch', 'Switching'],
  ['mark', 'Marking'], ['set', 'Setting'], ['take', 'Taking'], ['delete', 'Deleting'], ['use', 'Using'], ['remove', 'Removing'],
  ['find', 'Finding'], ['sign', 'Signing'], ['look', 'Looking'], ['go', 'Going'], ['put', 'Putting'], ['open', 'Opening'],
  ['load', 'Loading'], ['search', 'Searching'], ['ask', 'Asking'], ['bring', 'Bringing'], ['import', 'Importing'],
  ['compare', 'Comparing'], ['keep', 'Keeping'], ['write', 'Writing'], ['connect', 'Connecting'], ['install', 'Installing'],
  ['forget', 'Forgetting'], ['give', 'Giving'], ['leave', 'Leaving'], ['rename', 'Renaming'], ['approve', 'Approving'],
  ['choose', 'Choosing'], ['let', 'Letting'], ['answer', 'Answering'], ['resume', 'Resuming'], ['hand', 'Handing'],
  ['move', 'Moving'], ['cancel', 'Cancelling'], ['turn', 'Turning'], ['undo', 'Undoing'], ['drop', 'Dropping'],
  ['remember', 'Remembering'], ['review', 'Reviewing'], ['store', 'Storing'], ['apply', 'Applying'], ['accept', 'Accepting'],
  ['record', 'Recording'], ['jump', 'Jumping'], ['pause', 'Pausing'], ['copy', 'Copying'], ['export', 'Exporting'],
  ['watch', 'Watching'], ['join', 'Joining'], ['revoke', 'Revoking'], ['show', 'Showing'], ['rebuild', 'Rebuilding'],
  ['hold', 'Holding'], ['replace', 'Replacing'], ['unpin', 'Unpinning'], ['publish', 'Publishing'], ['test', 'Testing'],
  ['close', 'Closing'], ['host', 'Hosting'], ['subscribe', 'Subscribing'], ['walk', 'Walking'], ['pick', 'Picking'],
  ['create', 'Creating'], ['deploy', 'Deploying'], ['share', 'Sharing'], ['build', 'Building'], ['benchmark', 'Benchmarking'],
  ['judge', 'Judging'], ['compact', 'Compacting'], ['redo', 'Redoing'], ['pair', 'Pairing'], ['reject', 'Rejecting'],
  ['cut', 'Cutting'], ['retire', 'Retiring'], ['attach', 'Attaching'], ['comment', 'Commenting'], ['refresh', 'Refreshing'],
  ['resolve', 'Resolving'], ['revise', 'Revising'], ['suggest', 'Suggesting'], ['commit', 'Committing'],
  ['disconnect', 'Disconnecting'], ['dismiss', 'Dismissing'], ['describe', 'Describing'], ['end', 'Ending'], ['bind', 'Binding'],
  ['tidy', 'Tidying'], ['lock', 'Locking'], ['stage', 'Staging'], ['unlock', 'Unlocking'], ['browse', 'Browsing'],
  ['roll', 'Rolling'], ['uninstall', 'Uninstalling'], ['update', 'Updating'], ['block', 'Blocking'], ['reconnect', 'Reconnecting'],
  ['collect', 'Collecting'], ['correct', 'Correcting'], ['link', 'Linking'], ['say', 'Saying'], ['scan', 'Scanning'],
  ['paste', 'Pasting'], ['allow', 'Allowing'], ['pin', 'Pinning'], ['lift', 'Lifting'], ['quarantine', 'Quarantining'],
  ['finish', 'Finishing'], ['withdraw', 'Withdrawing'], ['step', 'Stepping'], ['research', 'Researching'], ['count', 'Counting'],
  ['schedule', 'Scheduling'], ['point', 'Pointing'], ['enforce', 'Enforcing'], ['restrict', 'Restricting'], ['probe', 'Probing'],
  ['trust', 'Trusting'], ['branch', 'Branching'], ['fold', 'Folding'], ['continue', 'Continuing'], ['upload', 'Uploading'],
  ['settle', 'Settling'], ['list', 'Listing'], ['skip', 'Skipping'], ['receive', 'Receiving'], ['refuse', 'Refusing'],
  ['edit', 'Editing'], ['speak', 'Speaking'], ['listen', 'Listening'], ['clear', 'Clearing'], ['try', 'Trying'],
  ['throw', 'Throwing'], ['propose', 'Proposing'], ['tie', 'Tying'],
  // Second acts that labels join on ("... and summarize it", "... and hear the answer", "... and get a link").
  ['summarize', 'Summarizing'], ['hear', 'Hearing'], ['get', 'Getting'], ['tell', 'Telling'],
] as const).map(([verb, gerund]) => [verb, gerund]));

/**
 * Word the asks for `capability_run` calls from this catalog (the last one registered in a process is used);
 * `methodTitle` reads a daemon method's title, for a method named by its id.
 */
export function presentCapabilityRunAsks(lookup: (id: string) => CapabilityEntry | undefined, methodTitle?: (method: string) => string | undefined): () => void {
  return presentToolAskWith(CAPABILITY_RUN_TOOL, (args) => capabilityAskWords(lookup, args, methodTitle));
}
