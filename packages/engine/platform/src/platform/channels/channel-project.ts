/**
 * channel-project.ts, the project a channel's conversations work in.
 *
 * A channel conversation that can change things has a project: the channel's row in Mail, calendar and channels has
 * "Project for this channel" (`ChannelPolicyRecord.project`, a registered project, chosen from the list; none by
 * default). A turn there works in that project: its files, its commands, its tool servers. With none, a turn there that
 * would write a file or run a command is refused in plain words that name that control. Nothing a channel turn does is
 * ever written in the daemon's own folder.
 *
 * Who decides whether such a turn may change anything at all (the owner's own messages, someone else's) is unchanged
 * (security/turn-input-party.ts): this only says WHERE, and refuses when there is nowhere.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { isChannelSurfaceKind } from '../../events/surfaces.js';
import { projectOfDecision } from '../permissions/call-project.js';
import { currentTurn } from '../security/turn-boundary.js';
import type { ToolResult } from '../types/tools.js';
import type { ToolRegistry } from '../tools/registry.js';
import { isAnyCapturedExecTool } from '../tools/exec/runtime.js';
import { isAnyCapturedReplTool } from '../tools/repl/captured.js';
import { registeredWorkspaceRoots } from '../workspace/project-identity.js';
import { callNeedsProject } from '../workspace/call-needs-project.js';

/** The control, as a person finds it. */
export const CHANNEL_PROJECT_CONTROL = '"Project for this channel", on the channel\'s row in Mail, calendar and channels';

/**
 * The tools a turn changes files, runs commands, hands work over or keeps something to run later with: none of them
 * runs for a conversation with no project (the trigger, schedule and agent tools would otherwise work in the daemon's
 * own folder later).
 */
const CHANGING_TOOLS: readonly string[] = ['write', 'edit', 'exec', 'repl', 'trigger', 'workflow', 'agent', 'task', 'work_plan'];

const real = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };

/**
 * Why `folder` cannot be a channel's project, or undefined when it can: an absolute path of a registered project.
 * `homeDirectory` is the home whose shared register lists the projects (absent: this process's home).
 */
export function channelProjectRefusal(folder: string, homeDirectory?: string | undefined): string | undefined {
  if (!isAbsolute(folder)) return `${folder} is not the full path of a project folder`;
  const roots = registeredWorkspaceRoots(homeDirectory ?? homedir());
  if (!roots.includes(real(folder))) {
    return `${folder} is not a registered project (register it in System, on the Workspaces tab, or start a program in it first)`;
  }
  return undefined;
}

const withoutProject = new AsyncLocalStorage<string>();

/** Runs a turn of a channel conversation that has no project (one the host runs itself, the Home Assistant chat). */
export function inChannelWithoutProject<T>(channel: string, run: () => T): T {
  return withoutProject.run(channel, run);
}

/**
 * The channel whose conversation the turn in scope belongs to when that conversation has no project, else undefined:
 * a turn marked by {@link inChannelWithoutProject}, or a turn started for a channel message (security/turn-boundary.ts)
 * whose decisions are made for no project or for the daemon's own folder (`ownFolder`).
 */
export function channelTurnWithoutProject(ownFolder: string): string | undefined {
  const marked = withoutProject.getStore();
  if (marked !== undefined) return marked;
  const surface = currentTurn()?.surface;
  if (surface === undefined || !isChannelSurfaceKind(surface)) return undefined;
  const project = projectOfDecision();
  return project === undefined || real(project) === real(ownFolder) ? surface : undefined;
}

/** What such a turn is told, and the person with it, when it tries to change something. */
export function channelWithoutProjectRefusal(tool: string, channel: string): string {
  return `Tool '${tool}' was refused: this conversation on ${channel} has no project, and only the owner's own message `
    + 'there gets it one, so nothing is read, written, run or kept for later from it (never in the daemon\'s own folder). The owner '
    + `can also choose one project for the whole channel in ${CHANNEL_PROJECT_CONTROL}. Say what you would do instead.`;
}

/**
 * Holds the changing tools of a registry the daemon's own folder runs turns with: a call from a channel conversation
 * that has no project is refused (above); every other turn's call runs as before. Applied once per registry.
 */
export function refuseChannelChangesWithoutProject(registry: ToolRegistry, ownFolder: string): void {
  heldOwnFolders.add(ownFolder);
  for (const name of CHANGING_TOOLS) {
    const tool = registry.list().find((entry) => entry.definition.name === name);
    if (!tool || held.has(tool)) continue;
    // A captured step's own exec and REPL are checked by identity where they run (captured-input-tools.ts), so a wrapper
    // would refuse every command of the step ("requires its construction-owned execution backend"). A captured step works
    // in its copy of a project, never as a channel's conversation with no project, so there is nothing to hold here.
    if (isAnyCapturedExecTool(tool) || isAnyCapturedReplTool(tool)) continue;
    const options = registry.registrationOptionsFor(name);
    // The same tool (its definition and metadata read through its prototype, never through a proxy, which the registry
    // refuses), with its own `execute` in front.
    const guarded = Object.create(tool) as typeof tool;
    Object.defineProperty(guarded, 'execute', {
      value: async (...args: Parameters<typeof tool.execute>): Promise<Omit<ToolResult, 'callId'>> => {
        const channel = channelTurnWithoutProject(ownFolder);
        if (channel !== undefined) return { success: false, error: channelWithoutProjectRefusal(name, channel) };
        return tool.execute(...args);
      },
      enumerable: true, writable: false, configurable: false,
    });
    held.add(guarded);
    registry.unregister(name, tool);
    registry.register(guarded, options);
  }
}
const held = new WeakSet<object>();
/** The own folders of the registries this process holds (one per daemon). */
const heldOwnFolders = new Set<string>();

/**
 * The refusal the hold above gives `tool` in the turn in scope, or undefined when it would run: read by the permission
 * gate before it asks anyone (gate/classify.ts), so the owner is never asked about a call the hold refuses anyway.
 */
export function channelWithoutProjectRefusalFor(tool: string): string | undefined {
  // Every call that needs a place (workspace/call-needs-project.ts: reads, tool servers, runners and the rest, not only
  // changes): such a conversation does nothing in the daemon's own folder.
  if (!callNeedsProject(tool)) return undefined;
  for (const ownFolder of heldOwnFolders) {
    const channel = channelTurnWithoutProject(ownFolder);
    if (channel !== undefined) return channelWithoutProjectRefusal(tool, channel);
  }
  return undefined;
}
