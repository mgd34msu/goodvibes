/**
 * The capability catalog: every action a person can take, as data, with the
 * facts find and run read (id, group, home, inputs, risk, the daemon method
 * that runs it when it has one). It is built from the command descriptions
 * (the same objects the slash commands and the web UI's sheets come from), so
 * nothing is described twice; an action that has moved brings its own
 * declaration, and the rest are placed by the first sort (command-groups.ts).
 *
 * `home` of an entry:
 *  - `daemon`: runs in the daemon, by its own definition or its own method;
 *  - `session`: runs in the program holding the conversation;
 *  - `terminal`: not moved yet; runs only inside a terminal program, through
 *    its slash command's own code. The group engineers move each of these.
 */
import { capabilityGroupOf, capabilityIdOf } from './command-groups.js';
import { MODEL_UNDER_MODE, modelNeverMakes, type EffectId } from '../security/effect-authority.js';
import { MODEL_NEVER_CAPABILITY_IDS } from '../control-plane/method-risk.js';
import type { CapabilityMethod } from './operator-input.js';
import type { CapabilityGroupId } from './groups.js';
import { effectiveRisk } from './risk.js';
import type {
  ActionLasts, ActionRisk, ActionTouches, CapabilityDeclaration, CapabilityDefinition, CapabilityHome, CapabilityRepeat, CapabilitySentenceWhen, CapabilityTightensWhen, InputDescription,
} from './types.js';

export type CapabilityEntryHome = CapabilityHome | 'terminal';

export interface CapabilityEntry {
  readonly id: string;
  readonly group: CapabilityGroupId;
  readonly home: CapabilityEntryHome;
  /** Declared by a moved action; for an action reached through its own method, that method's. */
  readonly repeat?: CapabilityRepeat | undefined;
  /** The slash command and action it is today (`/hooks enable`). */
  readonly command: string;
  readonly commandTitle: string;
  readonly actionId: string;
  readonly word: string;
  readonly label: string;
  readonly sentence: string;
  readonly done: string;
  readonly risk: ActionRisk;
  /** What the act did, said after it ran in place of the risk's words (types.ts `riskDone`). */
  readonly riskDone?: string | undefined;
  readonly touches: ActionTouches;
  readonly lasts: ActionLasts | 'not-a-change';
  readonly ownerOnly?: { readonly reason: string; readonly instead: string } | undefined;
  /** The effects its definition states; absent, derived (`capabilityEffects`). */
  readonly effects?: readonly EffectId[] | undefined;
  /** It only tightens a protection (types.ts `tightens`): a model's call of it is never refused or asked about. */
  readonly tightens?: true | CapabilityTightensWhen | undefined;
  /** It writes only the model's own working state (types.ts `ownWorkingState`): a model's call of it is never held or asked about. */
  readonly ownWorkingState?: true | undefined;
  /** Whether a run with these values loosens a protection (types.ts `loosensIf`): asked first, opening on No. */
  readonly loosensIf?: ((values: Readonly<Record<string, string>>) => boolean) | undefined;
  /** The chosen values with which a run cannot be undone (types.ts `irreversibleWhen`): put to the owner for a model. */
  readonly irreversibleWhen?: CapabilityTightensWhen | undefined;
  /** The chosen values with which a run writes a secret (types.ts `secretWhen`): the `secret.write` effect. */
  readonly secretWhen?: CapabilityTightensWhen | undefined;
  /** The sentence said instead with some values (types.ts `sentenceWhen`): what will really happen. */
  readonly sentenceWhen?: CapabilitySentenceWhen | undefined;
  readonly inputs: readonly InputDescription[];
  /** The daemon method that runs it, which input fills which of its fields, and the preview that reads them first. */
  readonly method?: CapabilityMethod | undefined;
  /** The action id (in the same command) that undoes this one: a screen shows its Undo after the act. */
  readonly undoneBy?: string | undefined;
  /** The confirming button's words when the label's verb cannot be read from it ("Put them back"). */
  readonly button?: string | undefined;
  /** The titles of its form's steps, in order (a step of usual settings is folded under "More settings"). */
  readonly stepTitles?: readonly string[] | undefined;
}

/** An action as the catalog reads it: a described action, or its row in the generated command-actions data. */
export interface CatalogActionSource {
  readonly id: string;
  readonly word: string;
  readonly label: string;
  readonly sentence: string;
  readonly done?: string | undefined;
  readonly risk: ActionRisk;
  readonly riskDone?: string | undefined;
  readonly touches: ActionTouches;
  readonly lasts: ActionLasts | 'not-a-change';
  readonly ownerOnly?: { readonly reason: string; readonly instead: string } | undefined;
  readonly effects?: readonly EffectId[] | undefined;
  readonly tightens?: true | CapabilityTightensWhen | undefined;
  readonly ownWorkingState?: true | undefined;
  readonly loosensIf?: ((values: Readonly<Record<string, string>>) => boolean) | undefined;
  readonly irreversibleWhen?: CapabilityTightensWhen | undefined;
  readonly secretWhen?: CapabilityTightensWhen | undefined;
  readonly sentenceWhen?: CapabilitySentenceWhen | undefined;
  readonly inputs: readonly InputDescription[];
  readonly operator?: { readonly method?: string | undefined; readonly fields?: Readonly<Record<string, string>> | undefined; readonly preview?: string | undefined; readonly project?: true | undefined; readonly terminalOnly?: string | undefined } | undefined;
  readonly capability?: CapabilityDeclaration | undefined;
  readonly undoneBy?: string | undefined;
  readonly button?: string | undefined;
  readonly stepTitles?: readonly string[] | undefined;
}

export interface CatalogCommandSource {
  readonly name: string;
  readonly title: string;
  readonly actions: readonly CatalogActionSource[];
}

function entryOf(command: Pick<CatalogCommandSource, 'name' | 'title'>, action: CatalogActionSource): CapabilityEntry {
  const declared = action.capability;
  const group = declared?.group ?? capabilityGroupOf(command.name, action.id);
  const method: CapabilityMethod | undefined = action.operator?.method
    ? { id: action.operator.method, fields: action.operator.fields ?? {}, ...(action.operator.preview ? { preview: action.operator.preview } : {}),
      // What it makes belongs to the caller's project (operator-input.ts `project`).
      ...(action.operator.project ? { project: true as const } : {}) }
    : undefined;
  const home: CapabilityEntryHome = declared?.home ?? (method ? 'daemon' : 'terminal');
  return {
    id: declared?.id ?? capabilityIdOf(command.name, action.word, group),
    group,
    home,
    ...(declared ? { repeat: declared.repeat } : {}),
    command: command.name,
    commandTitle: command.title,
    actionId: action.id,
    word: action.word,
    label: action.label,
    sentence: action.sentence,
    done: action.done ?? '',
    risk: action.risk,
    ...(action.riskDone ? { riskDone: action.riskDone } : {}),
    touches: action.touches,
    lasts: action.lasts,
    ...(action.ownerOnly ? { ownerOnly: action.ownerOnly } : {}),
    ...(action.effects ? { effects: action.effects } : {}),
    ...(action.tightens ? { tightens: action.tightens } : {}),
    ...(action.ownWorkingState ? { ownWorkingState: action.ownWorkingState } : {}),
    ...(action.loosensIf ? { loosensIf: action.loosensIf } : {}),
    ...(action.irreversibleWhen ? { irreversibleWhen: action.irreversibleWhen } : {}),
    ...(action.secretWhen ? { secretWhen: action.secretWhen } : {}),
    ...(action.sentenceWhen ? { sentenceWhen: action.sentenceWhen } : {}),
    inputs: action.inputs,
    ...(method ? { method } : {}),
    ...(action.undoneBy ? { undoneBy: action.undoneBy } : {}),
    ...(action.button ? { button: action.button } : {}),
    ...(action.stepTitles && action.stepTitles.length > 0 ? { stepTitles: action.stepTitles } : {}),
  };
}

/** A defined capability's entry; its command is the one its declaration's id names. */
export function entryOfDefinition(definition: CapabilityDefinition<never>, command: { readonly name: string; readonly title: string }): CapabilityEntry {
  return entryOf(command, { ...definition, id: definition.actionId, capability: definition.capability });
}

/** The catalog: one entry per id, the first source of an id kept (a defined capability before a described action). */
export class CapabilityCatalog {
  private readonly byId = new Map<string, CapabilityEntry>();

  constructor(entries: readonly CapabilityEntry[] = []) {
    for (const entry of entries) this.add(entry);
  }

  add(entry: CapabilityEntry): void {
    if (!this.byId.has(entry.id)) this.byId.set(entry.id, entry);
  }

  addCommands(commands: readonly CatalogCommandSource[]): void {
    for (const command of commands) for (const action of command.actions) this.add(entryOf(command, action));
  }

  get(id: string): CapabilityEntry | undefined {
    return this.byId.get(id.trim());
  }

  list(): readonly CapabilityEntry[] {
    return [...this.byId.values()];
  }

  inGroup(group: CapabilityGroupId): readonly CapabilityEntry[] {
    return this.list().filter((entry) => entry.group === group);
  }

  get size(): number {
    return this.byId.size;
  }
}

/**
 * What a run of this capability with these values causes, as rows of the effect table: the definition's own
 * `effects` when it states them, else derived from its words (a read of the control plane or a write to it;
 * `cannot-be-undone` adds `record.destroy`, `sends-out` and `spends-money` add `outward.send`; one a model never runs,
 * control-plane/method-risk.ts `MODEL_NEVER_CAPABILITY_IDS`, adds `model.refused`). An owner-only capability is not by
 * that alone one a model never runs: the owner's own model makes their acts under their mode, and anyone else is refused
 * them by the one owner rule. A chosen value that raises the risk adds its row either way.
 */
export function capabilityEffects(entry: Pick<CapabilityEntry, 'risk' | 'inputs' | 'touches' | 'ownerOnly' | 'effects'> & Partial<Pick<CapabilityEntry, 'secretWhen' | 'id'>>, values: Readonly<Record<string, string>> = {}): readonly EffectId[] {
  const effects = new Set<EffectId>(entry.effects ?? [entry.touches === 'reads' ? 'control-plane.read' : 'control-plane.write']);
  // A run whose chosen value makes it write a secret (a setting that holds a credential): the secret write it is.
  const secret = entry.secretWhen;
  if (secret && secret.values.includes((values[secret.input] ?? '').trim())) effects.add('secret.write');
  const risk = effectiveRisk(entry, values);
  if (risk === 'cannot-be-undone') effects.add('record.destroy');
  if (risk === 'sends-out' || risk === 'spends-money') effects.add('outward.send');
  if (entry.id !== undefined && MODEL_NEVER_CAPABILITY_IDS.has(entry.id)) effects.add('model.refused');
  return [...effects];
}

/**
 * Effects the effect table refuses to a model (`modelRefused`) that the owner's own model's call through
 * `capability_run` makes in their own turn, decided under their mode at that turn's gate: writing a credential they gave it,
 * allowing a purchase within their limits (security/effect-authority.ts `MODEL_UNDER_MODE`). Every other one no model
 * makes, in any mode.
 */
export const OWNER_DECIDED_EFFECTS: ReadonlySet<EffectId> = MODEL_UNDER_MODE;

/** Whether a model never causes it, whoever it acts for and in every mode: one of its effects says so. */
export function modelNeverRuns(entry: Pick<CapabilityEntry, 'risk' | 'inputs' | 'touches' | 'ownerOnly' | 'effects'> & Partial<Pick<CapabilityEntry, 'id'>>): boolean {
  return capabilityEffects(entry).some(modelNeverMakes);
}

/** Whether a model's call of it is the owner's to decide, as a call that weakens a protection is (it writes a credential). */
export function ownerDecidesForModel(entry: Pick<CapabilityEntry, 'risk' | 'inputs' | 'touches' | 'ownerOnly' | 'effects'>): boolean {
  return capabilityEffects(entry).some((effect) => OWNER_DECIDED_EFFECTS.has(effect));
}

export { effectiveRisk };

/** Whether a run only reads (it changes nothing a repeat could change twice). */
export function capabilityReads(entry: Pick<CapabilityEntry, 'touches' | 'lasts'>): boolean {
  return entry.touches === 'reads';
}

/** The input values with every optional input's default filled in. */
export function withDefaults(entry: Pick<CapabilityEntry, 'inputs'>, values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const filled: Record<string, string> = {};
  for (const input of entry.inputs) {
    const given = values[input.id];
    if (given !== undefined && given !== '') filled[input.id] = given;
    else if (input.required !== true) filled[input.id] = input.required.default;
  }
  return filled;
}
