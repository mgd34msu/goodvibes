/**
 * System, Workspaces: the folders registered as workspaces in the one shared
 * register (`~/.goodvibes/shared/workspace-registrations.json`) every program
 * reads. A registered folder is one the Agent works in: its work runs there and
 * its automatic checkpoints are on. The Agent registers the folder it is started
 * in by itself (starting it there is the request); these are how a person sees
 * them and undoes one, each through the daemon method that already does it
 * (`workspaces.registrations.*`, the same caller's call, its own admission
 * applying). Each handler only words the method's answer.
 */
// No Node module: the System place's declaration reads `registeredWorkspaces`, and the web UI draws it too (places/browser.ts).
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type InputDescription } from '../types.js';

/** The folder's own name, the last part of its path. */
function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

/** The workspace capabilities need nothing of their own: every act is a daemon method run as the caller. */
export type WorkspacesCapabilityServices = Readonly<Record<never, never>>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Run the daemon method that does this act, as the same caller. */
async function call(caller: CapabilityCaller, methodId: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (!caller.method) throw new CapabilityRefusal('This runs in the daemon, and no daemon took the request here; nothing was done.', undefined, 'UNAVAILABLE');
  return record(await caller.method(methodId, body));
}

/** One registered folder, as the System place and a script read it. */
export interface RegisteredWorkspaceFacts {
  readonly root: string;
  readonly label?: string | undefined;
  readonly registeredAt: string;
  /** Which program registered it: `agent` (started there), `tui` (trusted there), `chat` (made by the daemon for a chat that had none), or `other`. */
  readonly by: 'agent' | 'tui' | 'chat' | 'other';
  /** The Agent's automatic checkpoints are on there. */
  readonly checkpoints: boolean;
  /** Its folder cannot be reached now (the folder that held it is missing too: a disk not mounted, a parent renamed); nothing of it is lost. */
  readonly unreachable: boolean;
}

/** The words a list shows beside a project whose folder cannot be reached now. */
export const NOT_REACHABLE_NOW = 'not reachable now';

/** The register's rows, read defensively: the answer is data from another process. */
export function registeredWorkspaces(answer: unknown): readonly RegisteredWorkspaceFacts[] {
  const rows = record(answer).workspaces;
  if (!Array.isArray(rows)) return [];
  return rows.map(record).filter((row) => text(row.root) !== '').map((row): RegisteredWorkspaceFacts => {
    const origin = text(row.origin);
    return {
      root: text(row.root),
      ...(text(row.label) ? { label: text(row.label) } : {}),
      registeredAt: text(row.registeredAt),
      by: origin.startsWith('agent') ? 'agent' : origin === 'tui' ? 'tui' : origin === 'automatic-project' ? 'chat' : 'other',
      checkpoints: row.checkpointEligible === true,
      unreachable: row.reachable === false,
    };
  });
}

const ROOT_INPUT: InputDescription = {
  id: 'root', label: 'Folder', help: 'The workspace folder, as a full path', kind: 'path', freeTextReason: 'a folder on this computer',
  // Registered or unregistered as a workspace (the owner's own act); nothing works in it by this call.
  workFolder: false,
  required: true, typed: { position: 1 },
};

/** Registering or unregistering a folder decides where the Agent may work: the person's own act, never a model's. */
const OWNERS_OWN = { reason: 'it decides which folders the Agent works in', instead: 'Ask the owner to change it in System, on the Workspaces tab.' };

export const WORKSPACES_LIST: CapabilityDefinition<WorkspacesCapabilityServices> = {
  capability: { id: 'workspaces.list', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'list', label: 'See the registered workspaces', word: 'list', inputs: [],
  sentence: 'Lists the folders registered as workspaces: where the Agent works and keeps automatic checkpoints.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', effects: ['workspaces.read'], example: {},
  async run(_values, _services, caller) {
    const workspaces = registeredWorkspaces(await call(caller, 'workspaces.registrations.list'));
    if (workspaces.length === 0) return { text: 'No folder is registered as a workspace yet: the Agent registers the folder it is started in.', data: { workspaces } };
    return {
      text: [
        `Registered workspaces (${workspaces.length})`,
        ...workspaces.map((workspace) => `  ${workspace.root}${workspace.label ? ` (${workspace.label})` : ''}${workspace.checkpoints ? ', automatic checkpoints on' : ''}${workspace.unreachable ? `, ${NOT_REACHABLE_NOW}` : ''}`),
      ].join('\n'),
      data: { workspaces },
    };
  },
};

export const WORKSPACES_UNREGISTER: CapabilityDefinition<WorkspacesCapabilityServices> = {
  capability: { id: 'workspaces.unregister', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'unregister', label: 'Unregister a workspace', word: 'unregister', inputs: [ROOT_INPUT],
  sentence: '{root} is no longer a registered workspace: the Agent\'s work and its automatic checkpoints stop there, until it is registered again (starting the Agent there registers it again).',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', effects: ['workspaces.write'], undoneBy: 'register',
  ownerOnly: OWNERS_OWN, example: { root: '/home/sam/projects/garden-planner' },
  async run(values, _services, caller) {
    const root = values.root ?? '';
    const answer = await call(caller, 'workspaces.registrations.remove', { root });
    const removed = answer.removed === true;
    const where = text(answer.root) || root;
    if (!removed) throw new CapabilityRefusal(`${basename(where)} was not a registered workspace; nothing was changed.`, 'The Workspaces tab in System lists the registered ones.');
    return { text: `Unregistered ${basename(where)} (${where}): the Agent's work and its automatic checkpoints are off there.`, data: { root: where, removed } };
  },
};

export const WORKSPACES_REGISTER: CapabilityDefinition<WorkspacesCapabilityServices> = {
  capability: { id: 'workspaces.register', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'register', label: 'Register a folder as a workspace', word: 'register', inputs: [ROOT_INPUT],
  sentence: '{root} becomes a registered workspace: the Agent works there and keeps automatic checkpoints, until you unregister it.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', effects: ['workspaces.write'], undoneBy: 'unregister',
  ownerOnly: OWNERS_OWN, example: { root: '/home/sam/projects/garden-planner' },
  async run(values, _services, caller) {
    const root = values.root ?? '';
    // The Agent's own registration (its origin and checkpoints), the one starting it in the folder makes.
    const answer = await call(caller, 'workspaces.registrations.add', { root, origin: 'agent-explicit-registration', checkpointEligible: true });
    const workspace = record(answer.workspace);
    const where = text(workspace.root) || root;
    return {
      text: answer.alreadyRegistered === true && answer.nativeScopeGranted !== true
        ? `${basename(where)} (${where}) was already a registered workspace; nothing was changed.`
        : `Registered ${basename(where)} (${where}): the Agent works there and keeps automatic checkpoints.`,
      data: { root: where, alreadyRegistered: answer.alreadyRegistered === true },
    };
  },
};

export const WORKSPACES_CAPABILITIES = [WORKSPACES_LIST, WORKSPACES_UNREGISTER, WORKSPACES_REGISTER] as const;
