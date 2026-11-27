/**
 * The two capability tools a model is given (`capability_find`,
 * `capability_run`), as definitions: the same object the tool list carries
 * and the gate decides a call of by. Which calls the owner decides is read
 * from the capabilities themselves: one that loosens a protection (by its own
 * risk, or by a chosen input such as a secret kept as plain text) is
 * `loosen-security`, one that cannot be undone `irreversible-operator`, one
 * only the owner does himself `owner-act`; one that only reads is classed a
 * read; one that only tightens a protection (its `tightens`) is allowed in every
 * mode and folder, never asked about. Daemon methods a call names directly keep the declarations they had
 * under the method tool this one replaced.
 */
import { modelNeverRuns, ownerDecidesForModel, type CapabilityEntry } from '../../capabilities/catalog.js';
import type { FixedChoice } from '../../capabilities/types.js';
import type { ToolDefinition, ToolOwnerActs, ToolOwnerDecisions } from '../../types/tools.js';
import { RUNS_LATER_CAPABILITY_IDS, RUNS_LATER_METHOD_IDS } from '../../control-plane/method-risk.js';

/** What the daemon methods a call may name directly bring to the definition (the folded method tool's declarations). */
export interface CapabilityRunMethodDeclarations {
  readonly ownerActs?: readonly string[] | undefined;
  /** Of `ownerActs`, the ones put to the owner (opening on No) rather than refused: a method whose class is `owner-act`. */
  readonly ownerActsAsked?: readonly string[] | undefined;
  readonly irreversible?: readonly string[] | undefined;
  /** Methods whose class loosens a protection or writes a secret (control-plane/method-risk.ts). */
  readonly loosens?: readonly string[] | undefined;
  /** Methods that make something run by itself later (control-plane/method-risk.ts `RUNS_LATER_METHOD_IDS`). */
  readonly runsLater?: readonly string[] | undefined;
  /** Methods that spend money (class `spends-money`): asked each time after the conversation read text from outside. */
  readonly sendsOrSpends?: readonly string[] | undefined;
  readonly contractChanges?: readonly string[] | undefined;
  /**
   * Methods that only read: class `none` in the risk table (control-plane/method-risk.ts) together with the method's
   * declared read effect (`effect: 'read'`, every scope it needs a read scope). Classed a read, as a capability that only
   * reads is: a turn on someone else's input may call one by id, within what its caller may reach.
   */
  readonly reads?: readonly string[] | undefined;
  /** Recipient paths under `inputs`, by method id. */
  readonly recipients?: Readonly<Record<string, readonly string[]>> | undefined;
  /**
   * Ids this tool only routes to a nested daemon-method call, which the gate
   * decides with that method's own declarations: a call naming one is not
   * decided twice (it is classed a read here; its owner acts stay refused here).
   */
  readonly routed?: readonly string[] | undefined;
}

/**
 * Daemon capabilities that write or run in the caller's project folder, so the folder's trust holds them as it holds a
 * file write (a restricted folder refuses them; `security.trust-folder` is not here: trusting the folder is asked):
 * a worktree made or removed in the project, a hosted session, a hosted agent or a runner working there, a local rerun,
 * media saved into the project's `generated/` folder.
 */
const PROJECT_FOLDER_CAPABILITIES: ReadonlySet<string> = new Set([
  'worktree.setup', 'worktree.discard', 'hosted.new', 'agents.host', 'remote.dispatch', 'remote.dispatch-pool',
  'remote.rerun-local', 'media.make', 'media.collect', 'startup.support-bundle', 'update.save-review',
  // The project's own GoodVibes files: its services file (`<project>/.goodvibes/<program>/services.json`) and its
  // plugin catalog (`<project>/.goodvibes/.../ecosystem`). A plugin's switch and trust are the daemon's: not here.
  'services.trust', 'services.import', 'plugin.publish-local', 'plugin.unpublish',
]);
/**
 * Families whose changes write the project's own GoodVibes files (`<project>/.goodvibes/`: its hooks file, its tool
 * server config, its project secret store): every change of theirs is held to the folder.
 */
const PROJECT_FOLDER_FAMILIES: readonly string[] = ['hooks.', 'mcp.', 'secrets.'];

/**
 * Whether a capability's change works in the caller's project folder: one named above, one of a family above, or an
 * export (it writes a file at a path read against the project folder). A read never is: the folder holds no read.
 */
export function capabilityWorksInProjectFolder(entry: Pick<CapabilityEntry, 'id' | 'touches'>): boolean {
  if (entry.touches === 'reads') return false;
  if (PROJECT_FOLDER_CAPABILITIES.has(entry.id) || PROJECT_FOLDER_FAMILIES.some((family) => entry.id.startsWith(family))) return true;
  return /(^|-)export$/.test(entry.id.slice(entry.id.indexOf('.') + 1));
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
    // A setting changed in the loosening direction (settings.set, settings.reset, `loosensIf`) is classed by the gate
    // from the setting's current value (permissions/manager.ts `settingsWriteLoosens`), not by a list here.
  }
  // A run that cannot be undone only with some values (a credential's reset: `irreversibleWhen`).
  const irreversibleWhen: Record<string, { readonly path: string; readonly values: readonly string[] }[]> = {};
  for (const entry of entries) {
    if (entry.irreversibleWhen) irreversibleWhen[entry.id] = [{ path: `inputs.${entry.irreversibleWhen.input}`, values: entry.irreversibleWhen.values }];
  }
  const decisions: ToolOwnerDecisions = {
    field: 'id',
    irreversible: [...entries.filter((entry) => entry.risk === 'cannot-be-undone').map((entry) => entry.id), ...(methods.irreversible ?? [])],
    contractChanges: [...(methods.contractChanges ?? [])],
    // A capability that writes a credential is the owner's to decide, as one that loosens a protection: asked,
    // opening on No (a model's call of it is never refused outright, and never run unasked).
    loosens: [...entries.filter((entry) => entry.risk === 'loosens-a-protection' || ownerDecidesForModel(entry)).map((entry) => entry.id), ...(methods.loosens ?? [])],
    loosensWhen,
    irreversibleWhen,
    // What runs by itself later: a capability that makes it, or runs through a method that does, and such methods by id.
    // A routed id is decided once, at the nested method call it becomes, with that method's own declarations.
    runsLater: [...entries.filter((entry) => RUNS_LATER_CAPABILITY_IDS.has(entry.id) || (entry.method !== undefined && RUNS_LATER_METHOD_IDS.has(entry.method.id))).map((entry) => entry.id),
      ...(methods.runsLater ?? [])].filter((id) => !(methods.routed ?? []).includes(id)),
    // What sends out as the owner or spends his money: after the conversation read text from outside, asked each time in
    // every mode (security/conversation-exposure.ts). A routed id is decided at its nested method call.
    sendsOrSpends: [...entries.filter((entry) => entry.risk === 'sends-out' || entry.risk === 'spends-money').map((entry) => entry.id),
      ...(methods.sendsOrSpends ?? [])].filter((id) => !(methods.routed ?? []).includes(id)),
    ...(methods.recipients ? { recipients: methods.recipients } : {}),
  };
  // Only the owner does it himself: its own flag, or an effect a model never causes that the owner cannot decide for it.
  const ownerOwn = entries.filter((entry) => entry.ownerOnly || modelNeverRuns(entry));
  const ownerActs: ToolOwnerActs = {
    field: 'id', values: [...ownerOwn.map((entry) => entry.id), ...(methods.ownerActs ?? [])],
    // The refusal names the act in the capability's own words (gate/classify.ts).
    words: Object.fromEntries(ownerOwn.map((entry) => [entry.id, entry.label])),
    // A capability that is the owner's own act is put to him, opening on No, never refused outright; a daemon method
    // named directly whose act is his (answering an approval, minting a token) stays refused to a model.
    asked: [...ownerOwn.map((entry) => entry.id), ...(methods.ownerActsAsked ?? [])],
    // One that hands on a card's detail the owner types is answered each time: never remembered.
    once: ownerOwn.filter((entry) => (entry.effects ?? []).includes('card.enter')).map((entry) => entry.id),
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
    // A read is a capability that only reads and carries no risk: one that reads but sends, spends, loosens or cannot be
    // undone is not one (a turn on someone else's input runs reads only, gate/classify.ts). A routed method is decided as
    // the nested daemon-method call it becomes. A daemon method named by id that only reads (`methods.reads`) is one too.
    readModes: { field: 'id', values: [...entries.filter((entry) => entry.touches === 'reads' && entry.risk === 'none').map((entry) => entry.id), ...(methods.routed ?? []), ...(methods.reads ?? [])] },
    // A capability that only tightens a protection (its definition's `tightens`) is never refused or asked about.
    tightens: {
      field: 'id',
      values: entries.filter((entry) => entry.tightens === true).map((entry) => entry.id),
      when: Object.fromEntries(entries.flatMap((entry) => entry.tightens && entry.tightens !== true
        ? [[entry.id, [{ path: `inputs.${entry.tightens.input}`, values: entry.tightens.values }]]] : [])),
    },
    // A capability that writes only the model's own working state (the checklist) is never held or asked about.
    ownWorkingState: { field: 'id', values: entries.filter((entry) => entry.ownWorkingState === true).map((entry) => entry.id) },
    ownerActs,
    ownerDecisions: decisions,
    // The files a capability writes, its path inputs declared `file: 'written'`: the gate reads them as a file write's
    // path, so one that runs by itself later is asked of the owner as a model's write of it is (gate/classify.ts). A file
    // it only reads is never asked for its name.
    writesFiles: {
      field: 'id',
      paths: Object.fromEntries(entries.flatMap((entry) => {
        const inputs = entry.inputs.filter((input) => input.kind === 'path' && input.file === 'written').map((input) => `inputs.${input.id}`);
        return inputs.length > 0 ? [[entry.id, inputs]] : [];
      })),
    },
    // A capability the daemon runs acts on what the daemon holds, in no project folder: the folder's trust neither
    // refuses nor asks about its call. The call itself is decided as any other (an act of the owner's, asked opening on No).
    // One that writes or runs in the project folder is not among them: the folder holds it as it holds a file write.
    outsideFolder: {
      field: 'id',
      values: entries.filter((entry) => entry.home === 'daemon' && !capabilityWorksInProjectFolder(entry)).map((entry) => entry.id),
      // A change of a project-file family (secrets, tool servers) kept for all your projects writes no project file:
      // outside the folder with that scope named; the project scope (also its default) stays held to it.
      when: Object.fromEntries(entries.flatMap((entry) => {
        const otherScopes = entry.home === 'daemon' && capabilityWorksInProjectFolder(entry) ? scopesOutsideProject(entry) : [];
        return otherScopes.length > 0 ? [[entry.id, [{ path: 'inputs.scope', values: otherScopes }]]] : [];
      })),
    },
  };
}

/**
 * The values of a project-file family capability's `scope` input that keep the change out of the project (secrets
 * "All your projects", tool servers "All your projects"); none for any other capability.
 */
function scopesOutsideProject(entry: Pick<CapabilityEntry, 'id' | 'inputs'>): readonly string[] {
  if (!PROJECT_FOLDER_FAMILIES.some((family) => entry.id.startsWith(family))) return [];
  const scope = entry.inputs.find((input) => input.id === 'scope');
  if (!scope || !Array.isArray(scope.choices)) return [];
  return (scope.choices as readonly FixedChoice[]).map((choice) => choice.value).filter((value) => value !== '' && value !== 'project');
}
