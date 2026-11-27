/**
 * Devices and network, and Permissions and safety: the projects a paired device or a signed-in member may work in.
 * A caller that is not the owner's own program names a project only when the owner gave it that project
 * (workspace/caller-project.ts `checkCallerProject`); with none it acts on shared things only. These are how the owner
 * gives and takes them: the device's row in the Devices and network place, a member's row in Permissions and safety.
 * Kept by the daemon in `<daemon home>/caller-projects.json` (workspace/caller-projects-store.ts), keyed by the principal
 * the daemon authenticates (`pairing:<id>` for a device, the sign-in name for a member). A project given is a registered
 * workspace or a folder inside one, never the root, the home folder or anything in the GoodVibes or daemon home.
 */
import { CapabilityRefusal, type CapabilityDefinition, type InputDescription } from '../types.js';
import { currentRecordReach } from '@goodvibes/engine/daemon-api';
import { CARRIED_FROM_350_WORDS } from '../../control-plane/shared-kinds.js';

/** What these capabilities need: the daemon's one record of the projects each caller was given. */
export interface CallerProjectsCapabilityServices {
  readonly callerProjects?: {
    /** Every caller given a project, with its projects (real paths). */
    list(): Readonly<Record<string, readonly string[]>>;
    /** Give `principalId` the project `folder` names: its project's real path, or why it may not be given. */
    give(principalId: string, folder: string): { readonly ok: true; readonly project: string; readonly projects: readonly string[] } | { readonly ok: false; readonly reason: string };
    /** Take the project `folder` names from `principalId`: the projects it keeps, or undefined when it had not that one. */
    take(principalId: string, folder: string): readonly string[] | undefined;
    /** Of a caller's projects, those carried from 3.5.0 at the upgrade (caller-projects-store.ts `carryFrom350`), shown so. */
    carriedOf?(principalId: string): readonly string[];
  } | undefined;
}

type Definition = CapabilityDefinition<CallerProjectsCapabilityServices>;

const WHO: InputDescription = {
  id: 'who', label: 'Device or member', help: 'A paired device (pairing:<its id>, as its row fills it) or a member\'s sign-in name',
  kind: 'text', freeTextReason: 'the device\'s or member\'s name as the daemon knows it', required: true, typed: { position: 1 },
};
// A project named, not a file acted on: no file is read or written at it, so it is not a path input confined to the
// asker's own project (capabilities/path-inputs.ts); the handler checks it as a device would name it.
const PROJECT: InputDescription = {
  id: 'project', label: 'Project', help: 'A registered workspace, or a folder inside one, as a full path', kind: 'text', freeTextReason: 'a project folder on this computer',
  required: true, typed: { position: 2 },
};
const OWNERS_OWN = { reason: 'it decides which of your projects another device or person may work in', instead: 'Ask the owner to give it in Devices and network, on the device\'s row.' };

function storeOf(services: CallerProjectsCapabilityServices): NonNullable<CallerProjectsCapabilityServices['callerProjects']> {
  if (!services.callerProjects) throw new CapabilityRefusal('This daemon keeps no record of the projects devices may work in; nothing was read or changed.', undefined, 'UNAVAILABLE');
  return services.callerProjects;
}

/** A device's principal from its row (`pairing:<id>`), or a member's name, as typed. */
function principalOf(raw: string | undefined): string {
  const who = (raw ?? '').trim();
  if (!who) throw new CapabilityRefusal('Name the device or the member; nothing was changed.');
  return who;
}

export const DEVICES_PROJECTS: Definition = {
  capability: { id: 'devices.projects', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'projects', label: 'See the projects each device or member may work in', word: 'projects', inputs: [],
  sentence: 'Lists each paired device and member given projects of yours, with those projects; one not listed acts on shared things only.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const store = storeOf(services);
    const callers = store.list();
    // A caller that is not the owner in person sees only the projects it may name itself (control-plane/caller-reach.ts):
    // who else was given those, and nothing of another project.
    const reach = currentRecordReach();
    // A project carried from 3.5.0 at the upgrade is said so; it is taken away like any other (devices.take-project).
    const rows = Object.entries(callers)
      .map(([who, projects]) => {
        const shown = reach ? projects.filter((project) => reach('project', project)) : [...projects];
        return { id: who, who, projects: shown, carried: (store.carriedOf?.(who) ?? []).filter((project) => shown.includes(project)) };
      })
      .filter((row) => !reach || row.projects.length > 0);
    if (rows.length === 0) return { text: 'No device or member has been given a project: each acts on shared things only.', data: { callers: rows } };
    // The operator token of this computer (given folders where the daemon cannot verify its programs) by what it is.
    const named = (who: string): string => who === 'shared-token' ? 'GoodVibes on this computer (shared-token)' : who;
    return { text: ['Projects each device or member may work in', ...rows.map((row) => `  ${named(row.who)}: ${row.projects.map((project) => row.carried.includes(project) ? `${project} (${CARRIED_FROM_350_WORDS})` : project).join(', ')}`)].join('\n'), data: { callers: rows } };
  },
};

export const DEVICES_GIVE_PROJECT: Definition = {
  capability: { id: 'devices.give-project', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'give-project', label: 'Let a device or member work in a project', word: 'give-project', inputs: [WHO, PROJECT],
  sentence: '{who} may name {project} as its project (its files, its rules and its turns there), until you take it away.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'take-project', ownerOnly: OWNERS_OWN,
  example: { who: 'pairing:a1b2c3', project: '/home/sam/projects/garden-planner' },
  async run(values, services) {
    const who = principalOf(values.who);
    const given = storeOf(services).give(who, values.project ?? '');
    if (!given.ok) throw new CapabilityRefusal(`Not given: ${given.reason}.`, 'Register the folder as a workspace first (System, Workspaces), then give it.');
    return { text: `${who} may now work in ${given.project}. Its projects: ${given.projects.join(', ')}.`, data: { who, project: given.project, projects: [...given.projects] } };
  },
};

export const DEVICES_TAKE_PROJECT: Definition = {
  capability: { id: 'devices.take-project', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'take-project', label: 'Stop a device or member working in a project', word: 'take-project', inputs: [WHO, PROJECT],
  sentence: '{who} may no longer name {project} as its project; with none left it acts on shared things only.', done: '',
  // It only takes a project away: never refused or asked of anyone, in any folder.
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'give-project', tightens: true,
  example: { who: 'pairing:a1b2c3', project: '/home/sam/projects/garden-planner' },
  async run(values, services) {
    const who = principalOf(values.who);
    const kept = storeOf(services).take(who, values.project ?? '');
    if (kept === undefined) throw new CapabilityRefusal(`${who} was not given ${values.project}; nothing was changed.`, '"See the projects each device or member may work in" lists them.', 'NOT_FOUND');
    return { text: kept.length > 0 ? `${who} no longer works in ${values.project}; it keeps ${kept.join(', ')}.` : `${who} no longer works in ${values.project}; it has no project now and acts on shared things only.`, data: { who, projects: [...kept] } };
  },
};

export const CALLER_PROJECTS_CAPABILITIES: readonly Definition[] = [DEVICES_PROJECTS, DEVICES_GIVE_PROJECT, DEVICES_TAKE_PROJECT];
