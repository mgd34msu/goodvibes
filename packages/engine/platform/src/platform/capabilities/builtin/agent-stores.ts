/**
 * The Agent's own stores, kept by the daemon: notes, personas, routines,
 * document drafts and saved artifacts. Each is one store on this machine (the
 * notes, personas and routines under `~/.goodvibes/agent/`, which every Agent
 * turn reads for its prompt; the drafts under the project's
 * `.goodvibes/agent/documents/`; the artifacts in the daemon's store), and the
 * daemon is the one program that manages them: the terminal app, the Agent,
 * the web UI, a model and a script all reach them through these capabilities.
 *
 * The stores' code lives with the Agent's turn code in terminal-shell
 * (`agent-turn/agent-store-runner.ts`), which the daemon composes; here each
 * capability is defined once, and its handler asks that runner for exactly
 * the act it names. A daemon composed without it refuses each one with that
 * said.
 */
import {
  CapabilityRefusal,
  type ActionLasts,
  type ActionRisk,
  type ActionTouches,
  type ActionValues,
  type CapabilityCaller,
  type CapabilityDefinition,
  type CapabilityRepeat,
  type CapabilityResult,
  type FixedChoice,
  type InputDescription,
  type ListName,
} from '../types.js';
import type { CapabilityGroupId } from '../groups.js';
import type { EffectId } from '../../security/effect-authority.js';

/** The act a capability names, done on the store it belongs to. */
export interface AgentStoreRunner {
  run(id: string, values: ActionValues, caller: CapabilityCaller): Promise<CapabilityResult>;
}

/** What these capabilities need: the daemon's runner over the Agent's stores. */
export interface AgentStoresCapabilityServices {
  readonly agentStores?: AgentStoreRunner | undefined;
}

/** The fields a store capability is written with; the rest is the same for all of them. */
export interface StoreCapabilityFields {
  readonly id: string;
  readonly actionId: string;
  readonly label: string;
  readonly word: string;
  readonly inputs: readonly InputDescription[];
  readonly sentence: string;
  readonly example: ActionValues;
  readonly touches?: ActionTouches | undefined;
  readonly lasts?: ActionLasts | 'not-a-change' | undefined;
  readonly risk?: ActionRisk | undefined;
  readonly repeat?: CapabilityRepeat | undefined;
  readonly group?: CapabilityGroupId | undefined;
  readonly ownerOnly?: { readonly reason: string; readonly instead: string } | undefined;
  readonly undoneBy?: string | undefined;
  readonly effects?: readonly EffectId[] | undefined;
  /** Its preview check (CapabilityDefinition `check`): a refusal its values and caller show, before anything is asked. */
  readonly check?: CapabilityDefinition<AgentStoresCapabilityServices>['check'];
}

/**
 * The preview check of a capability that writes or reads a file a person names (`input`): a caller who is not the
 * person (a model, a script, another agent) names one in the project, never outside it, so such a call is refused
 * before the owner is asked anything about it. A relative path is read against the caller's project; with none, the
 * handler says so. The handler checks again where the file really is.
 */
export function fileInProjectCheck(input: string, purpose: 'read' | 'write'): NonNullable<StoreCapabilityFields['check']> {
  return (values, caller) => {
    const raw = (values[input] ?? '').trim();
    const project = caller.workingDirectory;
    if (caller.personAsked === true || raw === '' || !project) return undefined;
    const home = typeof process === 'undefined' ? '' : (process.env.HOME ?? '');
    const resolved = normalizePath(raw.startsWith('~/') && home ? `${home}/${raw.slice(2)}` : raw.startsWith('/') ? raw : `${project.replace(/\/+$/, '')}/${raw}`);
    const root = normalizePath(project);
    if (resolved === root || resolved.startsWith(`${root}/`)) return undefined;
    return new CapabilityRefusal(`Not done: ${raw} is outside the project (${project}); only you can ${purpose} a file there yourself.`,
      'Name a file inside the project, or ask the person to do it from its place');
  };
}

/** A slash path with `.` and `..` taken out ("/a/b/../c" is "/a/c"). */
function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** A capability over one of the Agent's stores, run by the daemon's runner. */
export function storeCapability(fields: StoreCapabilityFields): CapabilityDefinition<AgentStoresCapabilityServices> {
  const reads = fields.touches === 'reads';
  return {
    capability: { id: fields.id, group: fields.group ?? 'memory', home: 'daemon', repeat: fields.repeat ?? (reads ? 'safe' : 'unsafe') },
    actionId: fields.actionId,
    label: fields.label,
    word: fields.word,
    inputs: fields.inputs,
    sentence: fields.sentence,
    done: '',
    touches: fields.touches ?? 'this-machine',
    lasts: fields.lasts ?? (reads ? 'not-a-change' : 'kept'),
    risk: fields.risk ?? 'none',
    ...(fields.ownerOnly ? { ownerOnly: fields.ownerOnly } : {}),
    ...(fields.undoneBy ? { undoneBy: fields.undoneBy } : {}),
    ...(fields.effects ? { effects: fields.effects } : {}),
    ...(fields.check ? { check: fields.check } : {}),
    example: fields.example,
    async run(values, services, caller) {
      if (!services.agentStores) {
        throw new CapabilityRefusal('This daemon does not keep the Agent\'s notes, personas, routines, drafts and artifacts; nothing was done.',
          'Start the GoodVibes daemon that came with this version.');
      }
      return services.agentStores.run(fields.id, values, caller);
    },
  };
}

/** A read of one of the Agent's stores. */
export function storeRead(fields: Omit<StoreCapabilityFields, 'touches' | 'lasts' | 'risk' | 'repeat'>): CapabilityDefinition<AgentStoresCapabilityServices> {
  return storeCapability({ ...fields, touches: 'reads' });
}

type Optional = { readonly default: string; readonly means: string };

/** Typed words, with the reason they have to be typed. */
export function wordsInput(fields: {
  readonly id: string; readonly label: string; readonly help: string; readonly why: string;
  readonly typed: InputDescription['typed']; readonly kind?: InputDescription['kind'] | undefined; readonly optional?: Optional | undefined; readonly step?: number | undefined;
}): InputDescription {
  return {
    id: fields.id, label: fields.label, help: fields.help, kind: fields.kind ?? 'text', freeTextReason: fields.why,
    required: fields.optional ? { default: fields.optional.default, defaultMeans: fields.optional.means } : true,
    typed: fields.typed, ...(fields.step ? { step: fields.step } : {}),
  };
}

/** A blank with a few fixed answers. */
export function fixedInput(fields: {
  readonly id: string; readonly label: string; readonly help: string; readonly choices: readonly FixedChoice[];
  readonly typed: InputDescription['typed']; readonly optional?: Optional | undefined; readonly step?: number | undefined;
}): InputDescription {
  return {
    id: fields.id, label: fields.label, help: fields.help, kind: 'choice', choices: fields.choices,
    required: fields.optional ? { default: fields.optional.default, defaultMeans: fields.optional.means } : true,
    typed: fields.typed, ...(fields.step ? { step: fields.step } : {}),
  };
}

/** A blank chosen from a live list (the list itself is registered in terminal-shell under the same name). */
export function pickedInput(fields: {
  readonly id: string; readonly label: string; readonly help: string; readonly list: ListName;
  readonly position?: 1 | 2 | undefined; readonly dependsOn?: string | undefined; readonly other?: string | undefined; readonly optional?: Optional | undefined;
  readonly typed?: InputDescription['typed'] | undefined; readonly step?: number | undefined;
}): InputDescription {
  return {
    id: fields.id, label: fields.label, help: fields.help, kind: 'choice',
    choices: { list: fields.list, ...(fields.dependsOn ? { dependsOn: fields.dependsOn } : {}), ...(fields.other ? { allowOther: { reason: fields.other } } : {}) },
    required: fields.optional ? { default: fields.optional.default, defaultMeans: fields.optional.means } : true,
    typed: fields.typed ?? { position: fields.position ?? 1 },
    ...(fields.step ? { step: fields.step } : {}),
  };
}

/** A whole number with its default. */
export function countInput(id: string, label: string, help: string, flag: `--${string}`, fallback: string, means: string): InputDescription {
  return { id, label, help, kind: 'number', freeTextReason: 'a whole number', required: { default: fallback, defaultMeans: means }, typed: { flag } };
}
