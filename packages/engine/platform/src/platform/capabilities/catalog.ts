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
import { effectFacts, type EffectId } from '../security/effect-authority.js';
import type { CapabilityMethod } from './operator-input.js';
import type { CapabilityGroupId } from './groups.js';
import { effectiveRisk } from './risk.js';
import type {
  ActionLasts, ActionRisk, ActionTouches, CapabilityDeclaration, CapabilityDefinition, CapabilityHome, CapabilityRepeat, InputDescription,
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
  readonly touches: ActionTouches;
  readonly lasts: ActionLasts | 'not-a-change';
  readonly ownerOnly?: { readonly reason: string; readonly instead: string } | undefined;
  /** The effects its definition states; absent, derived (`capabilityEffects`). */
  readonly effects?: readonly EffectId[] | undefined;
  readonly inputs: readonly InputDescription[];
  /** The daemon method that runs it, which input fills which of its fields, and the preview that reads them first. */
  readonly method?: CapabilityMethod | undefined;
}

/** An action as the catalog reads it: a described action, or its row in the generated command-actions data. */
export interface CatalogActionSource {
  readonly id: string;
  readonly word: string;
  readonly label: string;
  readonly sentence: string;
  readonly done?: string | undefined;
  readonly risk: ActionRisk;
  readonly touches: ActionTouches;
  readonly lasts: ActionLasts | 'not-a-change';
  readonly ownerOnly?: { readonly reason: string; readonly instead: string } | undefined;
  readonly effects?: readonly EffectId[] | undefined;
  readonly inputs: readonly InputDescription[];
  readonly operator?: { readonly method?: string | undefined; readonly fields?: Readonly<Record<string, string>> | undefined; readonly preview?: string | undefined; readonly terminalOnly?: string | undefined } | undefined;
  readonly capability?: CapabilityDeclaration | undefined;
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
    ? { id: action.operator.method, fields: action.operator.fields ?? {}, ...(action.operator.preview ? { preview: action.operator.preview } : {}) }
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
    touches: action.touches,
    lasts: action.lasts,
    ...(action.ownerOnly ? { ownerOnly: action.ownerOnly } : {}),
    ...(action.effects ? { effects: action.effects } : {}),
    inputs: action.inputs,
    ...(method ? { method } : {}),
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
 * `cannot-be-undone` adds `record.destroy`, `sends-out` and `spends-money` add `outward.send`, `ownerOnly` adds
 * `model.refused`). A chosen value that raises the risk adds its row either way.
 */
export function capabilityEffects(entry: Pick<CapabilityEntry, 'risk' | 'inputs' | 'touches' | 'ownerOnly' | 'effects'>, values: Readonly<Record<string, string>> = {}): readonly EffectId[] {
  const effects = new Set<EffectId>(entry.effects ?? [entry.touches === 'reads' ? 'control-plane.read' : 'control-plane.write']);
  const risk = effectiveRisk(entry, values);
  if (risk === 'cannot-be-undone') effects.add('record.destroy');
  if (risk === 'sends-out' || risk === 'spends-money') effects.add('outward.send');
  if (entry.ownerOnly) effects.add('model.refused');
  return [...effects];
}

/**
 * Effects the effect table refuses to a model (`modelRefused`) that a model's call through `capability_run` may
 * still cause once the owner decided that call himself, as he decides every call that weakens a protection: writing
 * a credential. Everywhere else (a daemon method called directly, another tool) the table's refusal stands.
 */
export const OWNER_DECIDED_EFFECTS: ReadonlySet<EffectId> = new Set<EffectId>(['secret.write']);

/** Whether a model never causes it, whoever it acts for: one of its effects says so, and the owner cannot decide it for him. */
export function modelNeverRuns(entry: Pick<CapabilityEntry, 'risk' | 'inputs' | 'touches' | 'ownerOnly' | 'effects'>): boolean {
  return capabilityEffects(entry).some((effect) => !OWNER_DECIDED_EFFECTS.has(effect) && effectFacts([effect]).modelRefused);
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
