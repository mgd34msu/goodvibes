/** Whether the gate has a decision model to hand `jev-decides` calls to, read from settings and from whether it answers. */

import type { ConfigManager } from '../config/manager.js';
import type { ConfigKey } from '../config/schema.js';
import { decisionModelReady, effectivePermissionMode, gatePresetLabel, GATE_PRESETS, normalizePermissionMode, type GatePresetName } from '../gate/presets.js';
import { DECISION_MODEL_SET_KEYS, decisionModelSettings, type DecisionModelSettings } from '../config/decision-model-set.js';
import { requestedDecisionEndpoint, requestedDecisionModel } from '../config/decision-model-request.js';
import { captureJudgmentFallbackSettings } from '../config/judgment-fallback-settings.js';
import { gateDecisionsCalibrated, type DecisionTarget } from '../gate/calibration.js';
import { decisionModelFailure } from '../runtime/decision-policy.js';

/** The settings whose change can turn the decision model the gate relies on ready or not ready. */
export const DECISION_MODEL_READINESS_KEYS = DECISION_MODEL_SET_KEYS satisfies readonly ConfigKey[];

/**
 * Every place a gate decision can be answered: the endpoint and model a
 * request goes to (the one resolver requests use, config/decision-model-request.ts),
 * then each fallback target in order. Settings the request path would refuse
 * are none: nothing measured them.
 */
function decisionTargets(settings: DecisionModelSettings, env: Readonly<Record<string, string | undefined>>): readonly DecisionTarget[] {
  const primary: DecisionTarget = { endpoint: requestedDecisionEndpoint(settings.endpoint, env), model: requestedDecisionModel(settings.model, env) };
  try {
    return [primary, ...captureJudgmentFallbackSettings(settings.fallbacks).map((target) => ({ endpoint: target.endpoint, model: target.model }))];
  } catch {
    return [];
  }
}

export interface DecisionModelReadinessOptions {
  /**
   * The mode in force was chosen by the owner for this session (Shift+Tab, a
   * hosted session's mode, a channel profile) rather than read from settings.
   * Such a choice counts as his, the same as one saved in settings.
   */
  readonly chosen?: boolean | undefined;
  /** The environment requests read TYPESAFE_* from; the process environment when absent, as the gate's own readiness reads it. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /**
   * Take a set model as answering even while its failure episode lasts. Only
   * for comparing modes across one decision: a failure or a recovery flips the
   * mode in force for the next call, never for a call already being decided.
   */
  readonly assumeAnswering?: boolean | undefined;
}

/** Why the gate has no decision model to hand `jev-decides` calls to; undefined when it has one. */
export type DecisionModelUnreadyReason =
  | { readonly kind: 'selected' }
  | { readonly kind: 'not-set' }
  | { readonly kind: 'uncalibrated' }
  | { readonly kind: 'failing'; readonly model: string; readonly what: string; readonly since: number };

function readinessReason(
  configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>,
  options: DecisionModelReadinessOptions,
): DecisionModelUnreadyReason | undefined {
  const env = options.env ?? process.env;
  const settings = decisionModelSettings(key => configManager.get(key));
  if (!decisionModelReady(settings, env)) return settings.policy === 'No Decision Model' ? { kind: 'selected' } : { kind: 'not-set' };
  // A set model counts as working only while it answers: from its first
  // failure until it answers again (runtime/decision-policy.ts, one memory read).
  const failure = options.assumeAnswering === true ? undefined : decisionModelFailure();
  if (failure !== undefined) return { kind: 'failing', model: failure.model, what: failure.what, since: failure.since };
  // The owner's own choice of mode, saved or chosen for the session, stands on
  // a working model; the shipped default hands decisions to Jev only once they
  // were measured on everything that can answer them.
  if (options.chosen === true || configManager.isExplicitlySet?.('permissions.mode') !== false) return undefined;
  return gateDecisionsCalibrated(decisionTargets(settings, env)) ? undefined : { kind: 'uncalibrated' };
}

/**
 * Whether the gate has a decision model to hand `jev-decides` calls to. The
 * gate and every report of the mode in force (the mode-change event, status,
 * `/permissions`, the web UI) read this one answer, so they never disagree.
 */
export function permissionDecisionModelReady(
  configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>,
  options: DecisionModelReadinessOptions = {},
): boolean {
  return readinessReason(configManager, options) === undefined;
}

/** The mode in force for a saved or chosen mode, and why it differs from that mode when it does. */
export interface PermissionModeInForce {
  /** The mode saved in settings, or chosen for the session. */
  readonly chosen: GatePresetName;
  /** The mode the gate decides calls by. */
  readonly mode: GatePresetName;
  /** One sentence saying why `mode` is not `chosen`; absent when they are the same. */
  readonly reason?: string;
}

/**
 * The mode in force for `chosen` (the saved `permissions.mode` when absent),
 * read the way the gate reads it, with the reason it differs. Costs a few
 * settings reads and one memory read; no request.
 */
export function describePermissionModeInForce(
  configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>,
  input: { readonly chosen?: unknown; readonly explicitlyChosen?: boolean | undefined; readonly env?: Readonly<Record<string, string | undefined>> | undefined } = {},
): PermissionModeInForce {
  const fromSettings = input.chosen === undefined;
  const autoApprove = fromSettings && configManager.get('behavior.autoApprove' as ConfigKey) === true;
  const chosen = normalizePermissionMode(fromSettings ? configManager.get('permissions.mode' as ConfigKey) : input.chosen);
  if (autoApprove && chosen !== 'yolo') {
    return { chosen, mode: 'yolo', reason: '"Approve every tool request without asking" is on in your settings, which means YOLO; choosing your setting for when GoodVibes asks in /settings clears it' };
  }
  const why = chosen === 'jev-decides'
    ? readinessReason(configManager, { ...(input.explicitlyChosen === true ? { chosen: true } : {}), ...(input.env ? { env: input.env } : {}) })
    : undefined;
  const mode = effectivePermissionMode(chosen, false, why === undefined);
  if (why === undefined || mode === chosen) return { chosen, mode };
  const reason = why.kind === 'selected'
    ? 'you turned decision models off, so Jev cannot decide and every call it would decide asks you'
    : why.kind === 'not-set'
      ? 'no decision model is set, so every call Jev would decide asks you (to use one, choose a Decision model in /settings open)'
      : why.kind === 'uncalibrated'
        ? 'Jev decides is only the shipped default here and its decisions were not measured on this decision model; choose Jev decides yourself (shift+tab, or /settings open) to use it'
        : `the decision model ${why.model} is not answering (${why.what}, since ${new Date(why.since).toISOString()}); calls Jev would decide ask you until it answers again`;
  return { chosen, mode, reason };
}

/**
 * The mode in force in plain words, for the status bar, the web UI's header
 * chip, first run and the ask card's "Why am I asked?". Every surface renders
 * these words and builds none of its own (modeInForceLine joins them).
 *
 * When the mode in force is the chosen one, a surface shows `chosen`. When it
 * differs, it leads with what is in force and puts the choice second:
 * `inForce`, then `chosenWhen`, then `because` only when it reports a failure
 * (`failure`): "you, for now · Jev decides once a decision model is set". Where that
 * does not fit, `chosenShort` stands for `chosenWhen`: "you, for now · you
 * chose Jev decides".
 */
export interface ModeInForceWords {
  /** The chosen mode's label: "Jev decides". */
  readonly chosen: string;
  /** What is in force when it differs from the chosen mode, written to lead ("Asks: you, for now"); absent when they are the same. */
  readonly inForce?: string;
  /** The chosen mode and the condition it waits on: "Jev decides once a decision model is set"; absent when they are the same. */
  readonly chosenWhen?: string;
  /** The choice in a few words, for where `chosenWhen` does not fit: "you chose Jev decides", "default: Jev decides"; absent when they are the same. */
  readonly chosenShort?: string;
  /** Why it differs, a few words: "no decision model set", "decision model unreachable"; absent when they are the same. */
  readonly because?: string;
  /** True when `because` reports the decision model failing or out of reach rather than a choice; absent otherwise. */
  readonly failure?: boolean;
  /** What the mode in force does, one or two sentences: the explanation behind the chip. */
  readonly sentence: string;
  /** What GoodVibes asks you before, in one sentence, true for the mode in force and the per-tool settings. */
  readonly asksBefore: string;
}

/**
 * The words `what` takes (judgment port/model-failure.ts) when the decision
 * model could not be reached or did not answer at all, as opposed to answering
 * wrongly or refusing a key.
 */
const UNREACHABLE_FAILURE = /could not be reached|did not answer in time|did not answer within the time allowed|not answering in time|could not answer/;

/** The few words of becauseSentence, for the chip and the status bar: the same state in the same words. */
function becauseWords(why: DecisionModelUnreadyReason): string {
  switch (why.kind) {
    case 'selected': return 'decision models switched off';
    case 'not-set': return 'no decision model set';
    case 'uncalibrated': return 'not measured yet';
    case 'failing': return UNREACHABLE_FAILURE.test(why.what) ? 'decision model unreachable' : 'decision model failing';
  }
}

/**
 * When the chosen mode takes effect, written to follow its label as a
 * condition that cannot be read as the present state ("Jev decides once a
 * decision model is set").
 */
function chosenWhenWords(why: DecisionModelUnreadyReason): string {
  switch (why.kind) {
    case 'selected': return 'once decision models are on';
    case 'not-set': return 'once a decision model is set';
    case 'uncalibrated': return 'once you choose it';
    case 'failing': return 'once the decision model answers again';
  }
}

/**
 * The words in one line, in the order every surface shows them: the mode in
 * force first, the choice second, a failure last. "Jev decides" when the mode
 * in force is the chosen one; "you, for now · Jev decides once a decision
 * model is set"; "you, for now · Jev decides once the decision model answers
 * again · decision model unreachable".
 */
export function modeInForceLine(words: Pick<ModeInForceWords, 'chosen' | 'inForce' | 'chosenWhen' | 'because' | 'failure'>): string {
  if (words.inForce === undefined) return words.chosen;
  return [words.inForce, words.chosenWhen ?? words.chosen, ...(words.failure === true && words.because ? [words.because] : [])].join(' · ');
}

/** Read ModeInForceWords off a wire answer (sessions.permissionMode.get's `words`); undefined when it has none. */
export function readModeInForceWords(value: unknown): ModeInForceWords | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const text = (key: string): string | undefined => typeof record[key] === 'string' && record[key] !== '' ? record[key] as string : undefined;
  const chosen = text('chosen'), sentence = text('sentence'), asksBefore = text('asksBefore');
  if (!chosen || !sentence || !asksBefore) return undefined;
  const inForce = text('inForce'), chosenWhen = text('chosenWhen'), chosenShort = text('chosenShort'), because = text('because');
  return {
    chosen, sentence, asksBefore,
    ...(inForce ? { inForce } : {}), ...(chosenWhen ? { chosenWhen } : {}), ...(chosenShort ? { chosenShort } : {}), ...(because ? { because } : {}),
    ...(record.failure === true ? { failure: true } : {}),
  };
}

function becauseSentence(why: DecisionModelUnreadyReason): string {
  switch (why.kind) {
    case 'selected': return 'decision models are switched off';
    case 'not-set': return 'no decision model is set up';
    case 'uncalibrated': return 'Jev\'s decisions have not been measured on your decision model yet';
    case 'failing': return `the decision model ${why.model} is not answering (${why.what})`;
  }
}

type SettingsReader = Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>;

function toolSetting(configManager: SettingsReader, tool: 'exec' | 'write' | 'edit'): unknown {
  try { return configManager.get(`permissions.tools.${tool}` as ConfigKey); } catch { return undefined; }
}

/**
 * What ask-me without a working decision model asks before, from the per-tool
 * settings in force. The gate's no-model path (PermissionManager
 * assessClassicExecutionSafety) asks for every command and every file change
 * unless `permissions.tools.<tool>` is `allow`; a change inside the working
 * folder that can be undone is settled before it asks (the gate's defaults).
 */
function askMeWithoutModel(configManager: SettingsReader): string {
  const commandsAsk = toolSetting(configManager, 'exec') !== 'allow';
  const writesAsk = toolSetting(configManager, 'write') !== 'allow' || toolSetting(configManager, 'edit') !== 'allow';
  if (commandsAsk && writesAsk) return 'GoodVibes asks before it runs commands or changes things outside this folder.';
  if (commandsAsk) return 'GoodVibes asks before it runs commands.';
  if (writesAsk) return 'GoodVibes asks before it changes things outside this folder.';
  return 'GoodVibes runs commands and changes files without asking, as your per-tool settings allow.';
}

const MODE_SENTENCES: Readonly<Record<GatePresetName, string>> = {
  'ask-me': GATE_PRESETS['ask-me'].summary,
  'jev-decides': GATE_PRESETS['jev-decides'].summary,
  'just-vibes': GATE_PRESETS['just-vibes'].summary,
  yolo: GATE_PRESETS.yolo.summary,
  plan: GATE_PRESETS.plan.summary,
};

/**
 * The mode in force in words (ModeInForceWords), read the way the gate reads
 * it (describePermissionModeInForce and the readiness reason). A few settings
 * reads and one memory read; no request. Surfaces call it when the mode
 * changes (permissions/mode-change-emitter.ts) and when the decision model
 * fails or answers again, never per frame.
 */
export function describeModeInForceWords(
  configManager: SettingsReader,
  options: { readonly chosen?: unknown; readonly explicitlyChosen?: boolean | undefined; readonly env?: Readonly<Record<string, string | undefined>> | undefined } = {},
): ModeInForceWords {
  const inForce = describePermissionModeInForce(configManager, options);
  const chosenLabel = gatePresetLabel(inForce.chosen);
  // jev-decides falls back to ask-me only (effectivePermissionMode); any other difference is the auto-approve switch.
  const why = inForce.chosen === 'jev-decides' && inForce.mode === 'ask-me'
    ? readinessReason(configManager, { ...(options.explicitlyChosen === true ? { chosen: true } : {}), ...(options.env ? { env: options.env } : {}) })
    : undefined;
  // A model that works but is not ready for jev-decides is still no model for ask-me's purposes:
  // ask-me reads calls with a decision model only when one is set and answering.
  const modelWorks = (inForce.mode === 'ask-me' || inForce.mode === 'jev-decides')
    && readinessReason(configManager, { chosen: true, ...(options.env ? { env: options.env } : {}) }) === undefined;
  const asksBefore = asksBeforeFor(inForce.mode, modelWorks, configManager);
  if (inForce.mode === inForce.chosen) {
    return { chosen: chosenLabel, sentence: MODE_SENTENCES[inForce.chosen], asksBefore };
  }
  // The shipped default was not chosen by anyone: it is never called the owner's choice.
  const ownChoice = options.explicitlyChosen === true || configManager.isExplicitlySet?.('permissions.mode') !== false;
  const chosenShort = ownChoice ? `you chose ${chosenLabel}` : `default: ${chosenLabel}`;
  if (why === undefined) {
    // The saved auto-approve switch selects YOLO whatever mode was chosen.
    return {
      chosen: chosenLabel, inForce: 'YOLO, for now', chosenWhen: `${chosenLabel} once the old auto-approve setting is off`,
      chosenShort, because: 'an old auto-approve setting is on',
      sentence: `GoodVibes runs everything without asking for now: an old auto-approve setting is on. Choose a mode in Settings to clear it and use ${chosenLabel}.`,
      asksBefore,
    };
  }
  const choiceWords = ownChoice ? `you chose ${chosenLabel}` : `${chosenLabel} is the default here`;
  return {
    chosen: chosenLabel, inForce: 'you, for now', chosenWhen: `${chosenLabel} ${chosenWhenWords(why)}`,
    chosenShort, because: becauseWords(why),
    ...(why.kind === 'failing' ? { failure: true } : {}),
    sentence: `GoodVibes asks you for now: ${choiceWords}, but ${becauseSentence(why)}. ${asksBefore}`,
    asksBefore,
  };
}

function asksBeforeFor(mode: GatePresetName, modelWorks: boolean, configManager: SettingsReader): string {
  switch (mode) {
    case 'ask-me': return modelWorks
      ? 'GoodVibes asks before anything that can\'t be undone, weakens a safety setting, hides what it does or sends secrets out.'
      : askMeWithoutModel(configManager);
    case 'jev-decides': return 'Jev decides what is safe to run; GoodVibes asks you about anything that destroys data or weakens a safety setting.';
    case 'just-vibes': return 'GoodVibes doesn\'t stop to ask; anything that needs you is held and listed at the end of the run.';
    case 'yolo': return 'GoodVibes runs everything without asking.';
    case 'plan': return 'GoodVibes only reads and plans; it changes nothing.';
  }
}
