/**
 * The two capability tools a model is given (`capability_find`,
 * `capability_run`), as definitions: the same object the tool list carries
 * and the gate decides a call of by. Which calls the owner decides is read
 * from the capabilities themselves: one that loosens a protection (by its own
 * risk, or by a chosen input such as a secret kept as plain text) is
 * `loosen-security`, one that cannot be undone `irreversible-operator`, one
 * only the owner does himself `owner-act`; one that only reads is classed a
 * read. Daemon methods a call names directly keep the declarations they had
 * under the method tool this one replaced.
 */
import { modelNeverRuns, ownerDecidesForModel, type CapabilityEntry } from '../../capabilities/catalog.js';
import type { FixedChoice } from '../../capabilities/types.js';
import type { ToolDefinition, ToolOwnerActs, ToolOwnerDecisions } from '../../types/tools.js';

/** What the daemon methods a call may name directly bring to the definition (the folded method tool's declarations). */
export interface CapabilityRunMethodDeclarations {
  readonly ownerActs?: readonly string[] | undefined;
  readonly irreversible?: readonly string[] | undefined;
  readonly contractChanges?: readonly string[] | undefined;
  /** Recipient paths under `inputs`, by method id. */
  readonly recipients?: Readonly<Record<string, readonly string[]>> | undefined;
  /**
   * Ids this tool only routes to a nested daemon-method call, which the gate
   * decides with that method's own declarations: a call naming one is not
   * decided twice (it is classed a read here; its owner acts stay refused here).
   */
  readonly routed?: readonly string[] | undefined;
}

export const CAPABILITY_FIND_TOOL = 'capability_find';
export const CAPABILITY_RUN_TOOL = 'capability_run';

export function capabilityFindDefinition(): ToolDefinition {
  return {
    name: CAPABILITY_FIND_TOOL,
    activity: { doing: 'Finding', did: 'found', object: 'a capability' },
    description: 'Find the GoodVibes capability that does what you need (settings, secrets, hooks, memory, schedules, mail, devices, and everything else a person can do in its screens): say the need in words; three to five come back with id, what each does, its inputs and its risk. Then call capability_run.',
    parameters: {
      type: 'object',
      properties: { need: { type: 'string', description: 'What you need done, in plain words: "store my Stripe key", "switch off the lint hook".' } },
      required: ['need'],
      additionalProperties: false,
    },
    sideEffects: [],
    category: 'read',
  };
}

export function capabilityRunDefinition(entries: readonly CapabilityEntry[], methods: CapabilityRunMethodDeclarations = {}): ToolDefinition {
  const loosensWhen: Record<string, { readonly path: string; readonly values: readonly string[] }[]> = {};
  for (const entry of entries) {
    for (const input of entry.inputs) {
      if (!Array.isArray(input.choices)) continue;
      const values = (input.choices as readonly FixedChoice[]).filter((choice) => choice.risk === 'loosens-a-protection').map((choice) => choice.value);
      if (values.length > 0) (loosensWhen[entry.id] ??= []).push({ path: `inputs.${input.id}`, values });
    }
  }
  const decisions: ToolOwnerDecisions = {
    field: 'id',
    irreversible: [...entries.filter((entry) => entry.risk === 'cannot-be-undone').map((entry) => entry.id), ...(methods.irreversible ?? [])],
    contractChanges: [...(methods.contractChanges ?? [])],
    // A capability that writes a credential is the owner's to decide, as one that loosens a protection: asked,
    // opening on No (a model's call of it is never refused outright, and never run unasked).
    loosens: entries.filter((entry) => entry.risk === 'loosens-a-protection' || ownerDecidesForModel(entry)).map((entry) => entry.id),
    loosensWhen,
    ...(methods.recipients ? { recipients: methods.recipients } : {}),
  };
  // Only the owner does it himself: its own flag, or an effect a model never causes that the owner cannot decide for it.
  const ownerOwn = entries.filter((entry) => entry.ownerOnly || modelNeverRuns(entry));
  const ownerActs: ToolOwnerActs = {
    field: 'id', values: [...ownerOwn.map((entry) => entry.id), ...(methods.ownerActs ?? [])],
    // The refusal names the act in the capability's own words (gate/classify.ts).
    words: Object.fromEntries(ownerOwn.map((entry) => [entry.id, entry.label])),
  };
  return {
    name: CAPABILITY_RUN_TOOL,
    activity: { doing: 'Running', did: 'ran', object: 'a capability' },
    description: 'Run a GoodVibes capability by id (from capability_find, or a daemon method id) with its inputs; it goes through the same permission gate as every other call. A capability found once stays callable for this session.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The capability id capability_find gave (hooks.disable), or a daemon method id (services.status).' },
        inputs: { type: 'object', description: 'The inputs by name, as capability_find listed them (for a method id, the method\'s input).', additionalProperties: true },
        confirm: { type: 'boolean', description: 'For a daemon method id only: the method runs only with confirm.' },
        explicitUserRequest: { type: 'boolean', description: 'For a daemon method id only: the owner asked for exactly this in this conversation.' },
        dryRun: { type: 'boolean', description: 'For a daemon method id only: show the request without sending it.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    sideEffects: ['network', 'state'],
    readModes: { field: 'id', values: [...entries.filter((entry) => entry.touches === 'reads').map((entry) => entry.id), ...(methods.routed ?? [])] },
    ownerActs,
    ownerDecisions: decisions,
  };
}
