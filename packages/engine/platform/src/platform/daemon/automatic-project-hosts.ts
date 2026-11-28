/**
 * The daemon's automatic projects (workspace/automatic-projects.ts), one per daemon home: made in the folder the
 * daemon's "Folder for automatic projects" names, registered in the daemon's shared register, trusted as a folder with
 * nothing of its own to run, and recorded with the chat they were made for. The web chat, Home Assistant's chat and a
 * channel conversation's work ask here, only for the owner's own input.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { ConfigManager } from '../config/manager.js';
import { resolveGoodVibesDaemonHome } from '../config/goodvibes-home.js';
import type { ShellPathService } from '../runtime/shell-paths.js';
import { createShellPathService } from '../runtime/shell-paths.js';
import { NOTHING_OF_ITS_OWN_TO_RUN, WorkspaceTrustManager } from '../runtime/workspace-trust.js';
import { openWorkspaceRegistrationStore } from '../workspace/registration/index.js';
import { sharedWorkspaceRegisterPath } from '../workspace/registration/shared-register-path.js';
import { AUTOMATIC_PROJECTS_SETTING, AutomaticProjects } from '../workspace/automatic-projects.js';
import { ownersChannelSession } from '../security/turn-input-party.js';
import { isChannelSurfaceKind } from '../../events/surfaces.js';

const byHome = new Map<string, AutomaticProjects>();
let current: AutomaticProjects | undefined;

/** The automatic projects of the daemon in this process, once it made them; undefined in a program. */
export function currentAutomaticProjects(): AutomaticProjects | undefined {
  return current;
}

/** One chat as Sessions, Chats lists it. */
export interface ChatRow {
  /** A web chat's id, or `channel:<session id>` for a channel conversation. */
  readonly id: string;
  /** `web chat`, `Home Assistant`, or the channel's name. */
  readonly kind: string;
  readonly title: string;
  /** Its project's folder, when it has one. */
  readonly project?: string | undefined;
  /** True when its project was made for it (an automatic project). */
  readonly made: boolean;
}

/** What the daemon's chat host gives the Chats list: its chats, and moving one to another project (history kept). */
export interface WebChatHost {
  list(): readonly { readonly id: string; readonly title: string; readonly kind: string; readonly project?: string | undefined }[];
  move(id: string, project: string): void;
  /** A channel conversation's title, by its session id. */
  sessionTitle(sessionId: string): string | undefined;
  /** The channel a conversation is on (`telegram`), by its session id. */
  sessionChannel?(sessionId: string): string | undefined;
}
let chatHost: WebChatHost | undefined;

/** Sets the daemon's chat host (facade-composition.ts); returns its removal. */
export function setWebChatHost(host: WebChatHost): () => void {
  chatHost = host;
  return () => { if (chatHost === host) chatHost = undefined; };
}

/** Every chat the daemon keeps, web chats first, then channel conversations given a project of their own. */
export function listChats(projects: AutomaticProjects): readonly ChatRow[] {
  const madeFolders = new Set(projects.madeFolders());
  const web = (chatHost?.list() ?? []).map((chat): ChatRow => ({ id: chat.id, kind: chat.kind, title: chat.title,
    ...(chat.project ? { project: chat.project } : {}), made: chat.project !== undefined && madeFolders.has(chat.project) }));
  const channels = projects.list().filter((entry) => entry.key.startsWith('channel:')).map((entry): ChatRow => {
    const sessionId = entry.key.slice('channel:'.length);
    const channel = chatHost?.sessionChannel?.(sessionId) ?? 'channel';
    return { id: entry.key, kind: channel, title: `${channel} conversation ${chatHost?.sessionTitle(sessionId) ?? sessionId}`, project: entry.folder, made: entry.made };
  });
  return [...web, ...channels];
}

/** Moves a chat to another existing project, its history kept; the sentence that says where its files are now. */
export function attachChat(projects: AutomaticProjects, id: string, folder: string): string {
  const name = folder.split('/').filter(Boolean).at(-1) ?? folder;
  if (id.startsWith('channel:')) projects.attach(id, folder, name);
  else {
    if (!chatHost) throw new Error('No chat host is running in this daemon; nothing was moved.');
    chatHost.move(id, folder);
  }
  return `This chat works in ${name} from now on: its files are in ${folder}; its history is kept.`;
}

/** The daemon's automatic projects, made once per daemon home. */
export function daemonAutomaticProjects(services: { readonly shellPaths: ShellPathService; readonly configManager: Pick<ConfigManager, 'get'> }): AutomaticProjects {
  const homeDirectory = services.shellPaths.homeDirectory;
  const daemonHome = resolveGoodVibesDaemonHome(homeDirectory);
  const daemonStateDir = services.shellPaths.resolveUserPath();
  const register = openWorkspaceRegistrationStore({ path: sharedWorkspaceRegisterPath(services.shellPaths), homeDir: homeDirectory, daemonStateDir });
  const made = new AutomaticProjects({
    homeDirectory, goodVibesHome: join(homeDirectory, '.goodvibes'), daemonHome,
    folderSetting: () => (services.configManager.get as (key: string) => unknown)(AUTOMATIC_PROJECTS_SETTING),
    // A repository with one empty first commit, as `git init` in a new project folder of the owner's own is: its Work
    // copies and applies changes through git (a folder with no commit is worked on in place, outside any copy, and a
    // channel's work there was then refused as having no project). The commit is the owner's git identity; with none set
    // on this machine it is made as GoodVibes, which made the folder, so the project works the same on every machine.
    prepare: (folder, name) => {
      const git = (args: readonly string[]) => spawnSync('git', [...args], { cwd: folder, encoding: 'utf8', env: process.env });
      const init = git(['init', '-q']);
      if (init.status !== 0) { logger.warn('[projects] a chat\'s new project could not be made a repository', { folder, error: (init.stderr ?? '').trim().slice(0, 300) }); return; }
      const first = git(['commit', '-q', '--allow-empty', '-m', `Start ${name}`]);
      if (first.status === 0) return;
      const asGoodVibes = git(['-c', 'user.name=GoodVibes', '-c', 'user.email=goodvibes@localhost', 'commit', '-q', '--allow-empty', '-m', `Start ${name}`]);
      if (asGoodVibes.status !== 0) logger.warn('[projects] a chat\'s new project has no first commit', { folder, error: (asGoodVibes.stderr ?? '').trim().slice(0, 300) });
    },
    register: async (folder, label) => { await register.add(folder, { label, origin: 'automatic-project', checkpointEligible: true }); },
    trust: async (folder) => {
      const trust = new WorkspaceTrustManager({ shellPaths: createShellPathService({ workingDirectory: folder, homeDirectory }), surfaceRoot: 'tui' });
      await trust.load();
      const saved = await trust.setLevel('trusted', NOTHING_OF_ITS_OWN_TO_RUN);
      if (!saved.saved) throw new Error(`the trust of ${folder} could not be kept${saved.fault ? `: ${saved.fault}` : ''}`);
    },
    recordFile: join(daemonHome, 'automatic-projects.json'),
  });
  byHome.set(daemonHome, made);
  current = made;
  return made;
}

/**
 * Where the work of a channel conversation runs when its channel has no project: the owner's own conversation (theirs
 * alone, on a channel that proves its sender: security/turn-input-party.ts) gets its own automatic project, made on
 * this first need; any other conversation gets none (undefined: nothing it says changes anything).
 */
export function channelWorkProject(
  projects: AutomaticProjects,
  sessions: { getSession(id: string): { readonly surfaceKinds: readonly string[] } | null | undefined },
  channelProject: (surface: string) => string | undefined,
): (sessionId: string, message: string) => Promise<{ readonly folder: string; readonly said?: string } | { readonly refused: string } | undefined> {
  return async (sessionId, message) => {
    const surface = sessions.getSession(sessionId)?.surfaceKinds.find(isChannelSurfaceKind);
    if (!surface || channelProject(surface)) return undefined;
    // Anyone else's conversation (a guest's, a group's) has no project and makes none: its work is not started anywhere.
    if (!ownersChannelSession(sessionId)) {
      return { refused: `Not started: this conversation on ${surface} has no project, and only the owner's own message there gets it one, so nothing is done from it (never in the daemon's own folder). The owner can choose one project for the whole channel in "Project for this channel".` };
    }
    const project = await projects.ensure({ key: `channel:${sessionId}`, kind: surface, message });
    return { folder: project.folder, ...(project.made ? { said: project.said } : {}) };
  };
}
