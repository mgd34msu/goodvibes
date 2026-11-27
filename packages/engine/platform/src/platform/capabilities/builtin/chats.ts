/**
 * Sessions, Chats (and System, Workspaces): the daemon's chats with the project each works in, the control that
 * attaches a chat to another existing project, and "Folder for automatic projects", where a chat that has none is
 * given its own (workspace/automatic-projects.ts). The daemon holds them (daemon/automatic-project-hosts.ts).
 */
import { resolveGoodVibesDaemonHome, resolveGoodVibesHome } from '../../config/goodvibes-home.js';
import { attachChat, currentAutomaticProjects, listChats } from '../../daemon/automatic-project-hosts.js';
import { AUTOMATIC_PROJECTS_SETTING, automaticProjectsFolderOf, automaticProjectsFolderRefusal } from '../../workspace/automatic-projects.js';
import { join, resolve } from 'node:path';
import { registeredWorkspaceRoots } from '../../workspace/project-identity.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition } from '../types.js';
import { CHANNEL_PROJECTS_LIST } from './messages.js';
import { keepReachable } from '@goodvibes/engine/daemon-api';

function projectsHere() {
  const projects = currentAutomaticProjects();
  if (!projects) throw new CapabilityRefusal('This runs in the daemon, and no daemon took the request here; nothing was done.', undefined, 'UNAVAILABLE');
  return projects;
}

function facts() {
  const home = resolveGoodVibesHome();
  return { homeDirectory: home, goodVibesHome: join(home, '.goodvibes'), daemonHome: resolveGoodVibesDaemonHome(home) };
}

async function method(caller: CapabilityCaller, id: string, body: Record<string, unknown>): Promise<unknown> {
  if (!caller.method) throw new CapabilityRefusal('This runs in the daemon, and no daemon took the request here; nothing was done.', undefined, 'UNAVAILABLE');
  return caller.method(id, body);
}

const name = (folder: string): string => folder.split('/').filter(Boolean).at(-1) ?? folder;

export const CHATS_LIST: CapabilityDefinition<object> = {
  capability: { id: 'chats.list', group: 'sessions', home: 'daemon', repeat: 'safe' },
  actionId: 'chats', label: 'See the chats and their projects', word: 'chats', inputs: [],
  sentence: 'Lists the daemon\'s chats (web chats, Home Assistant\'s, the channel conversations given a project of their own) with the project each works in.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run() {
    // Only the chats the caller may reach, by the one check of what a caller may reach (control-plane/caller-reach.ts):
    // a web chat as itself, a channel conversation as its session; the owner himself sees every one.
    const chats = keepReachable(listChats(projectsHere()), 'session', (chat) => chat.id);
    if (chats.length === 0) return { text: 'No chat yet.', data: { chats } };
    return {
      text: chats.map((chat) => `${chat.title} (${chat.kind}): ${chat.project ? `${chat.made ? 'its own project' : 'works in'} ${name(chat.project)}, files in ${chat.project}` : 'no project yet: your own message there that needs somewhere to work gets it its own'}`).join('\n'),
      data: { chats },
    };
  },
};

export const CHATS_PROJECT: CapabilityDefinition<object> = {
  capability: { id: 'chats.project', group: 'sessions', home: 'daemon', repeat: 'safe' },
  actionId: 'chat-project', label: 'Work in another project', word: 'chat-project',
  inputs: [
    { id: 'chat', label: 'Chat', help: 'The chat, by its id', kind: 'text', freeTextReason: 'a chat id', required: true, typed: { position: 1 } },
    { id: 'project', label: 'Project', help: 'A registered project', kind: 'choice',
      choices: { list: CHANNEL_PROJECTS_LIST, allowOther: { reason: 'the full path of a registered project' } }, required: true, typed: { position: 2 }, step: 2 },
  ],
  sentence: 'The chat works in {project} from now on: its files, its commands and its tool servers; its history is kept, and the project it had stays as it is.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
  // Which project a chat changes things in is the owner's own choice, through every door.
  ownerOnly: { reason: 'it decides which project a chat may change', instead: 'Ask the owner to move it in Sessions, on the Chats tab.' },
  ownersAct: true,
  example: { chat: 'c0ffee00-0000-4000-8000-000000000000', project: '/home/sam/projects/garden-planner' },
  async run(values) {
    const chat = (values.chat ?? '').trim();
    const project = (values.project ?? '').trim();
    if (!project || project === 'none') throw new CapabilityRefusal('A chat keeps a project once it has one; choose the project it should work in instead. Nothing was changed.');
    const projects = projectsHere();
    if (!listChats(projects).some((row) => row.id === chat)) throw new CapabilityRefusal(`No chat ${chat}; nothing was changed.`, 'Sessions, Chats lists them.');
    if (!registeredWorkspaceRoots(facts().homeDirectory).some((root) => resolve(root) === resolve(project))) {
      throw new CapabilityRefusal(`${project} is not a registered project; nothing was changed.`, 'Register it in System, on the Workspaces tab, or choose one from the list.');
    }
    try {
      return { text: attachChat(projects, chat, project), data: { chat, project } };
    } catch (error) {
      throw new CapabilityRefusal(error instanceof Error ? error.message : String(error));
    }
  },
};

export const CHATS_AUTOMATIC_FOLDER: CapabilityDefinition<object> = {
  capability: { id: 'chats.automatic-folder', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'automatic-folder', label: 'Folder for automatic projects', word: 'automatic-folder',
  inputs: [{ id: 'folder', label: 'Folder', help: 'Where a chat that has no project is given its own (one folder per chat inside it)', kind: 'path',
    freeTextReason: 'a folder on this computer', workFolder: false, required: { default: '', defaultMeans: '~/goodvibes-projects' }, typed: { position: 1 } }],
  sentence: 'A chat that has no project is given its own inside {folder} from now on, until you change it; the projects made already stay where they are.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', example: { folder: '~/goodvibes-projects' },
  // Where the daemon makes folders of its own for chats is the owner's own choice, through every door.
  ownerOnly: { reason: 'it decides where the daemon makes a project for every chat that has none', instead: 'Ask the owner to change it in System, on the Workspaces tab.' },
  ownersAct: true,
  async run(values, _services, caller) {
    const given = (values.folder ?? '').trim();
    const where = automaticProjectsFolderOf(given, facts().homeDirectory);
    const refused = automaticProjectsFolderRefusal(where, facts());
    if (refused) throw new CapabilityRefusal(`Nothing was changed: ${refused}.`, 'Choose a folder of its own, outside the daemon\'s home and outside every project, such as ~/goodvibes-projects.');
    await method(caller, 'config.set', { key: AUTOMATIC_PROJECTS_SETTING, value: given });
    return { text: `A chat that has no project is given its own inside ${where} from now on.`, data: { folder: where } };
  },
};

export const CHATS_CAPABILITIES: readonly CapabilityDefinition<object>[] = [CHATS_LIST, CHATS_PROJECT, CHATS_AUTOMATIC_FOLDER];
