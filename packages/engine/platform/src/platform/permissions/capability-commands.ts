/**
 * capability-commands.ts, the commands a capability runs in the project, so a model's call of it is decided as those
 * commands are: `code.test` runs the project's test command (the `contract.gates` entry named test, or the package.json
 * test script), `worktree.setup` runs the worktree setup commands (`worktree.setup.commands`, the project's own file's
 * commands, or those derived from the repository). The permission manager decides such a call as an `exec` of exactly
 * these commands (the same classifier, rules and mode), once, in place of the capability's own risk
 * (PermissionManager `useCapabilityCommands`).
 *
 * The setup commands are read as the daemon reads them for the project (runtime/worktree/project-setup-settings.ts),
 * with the project file's own commands counted whatever the folder's trust: a decision is made on every command that
 * could run, never on fewer.
 */
import { join, resolve } from 'node:path';
import { resolveProjectTestCommand } from '../contract/gates.js';
import type { ContractConfigReader } from '../contract/config.js';
import { PROJECT_DAEMON_SETTINGS_FILE, projectWorktreeSettings } from '../runtime/worktree/project-setup-settings.js';
import { resolveEffectiveWorktreeSetup } from '../runtime/worktree/setup.js';

/** The commands a capability call would run, each with the folder it runs in; undefined when it runs none it can name. */
export type CapabilityCommandsResolver = (args: Record<string, unknown>, directory: string | undefined) =>
  Promise<readonly { readonly cmd: string; readonly cwd?: string }[] | undefined>;

const textInput = (args: Record<string, unknown>, id: string): string => {
  const inputs = args['inputs'];
  const value = inputs !== null && typeof inputs === 'object' && !Array.isArray(inputs) ? (inputs as Record<string, unknown>)[id] : undefined;
  return typeof value === 'string' ? value.trim() : '';
};

/** The resolver over a program's (or the daemon's) settings. */
export function capabilityCommandsResolver(configManager: ContractConfigReader): CapabilityCommandsResolver {
  return async (args, directory) => {
    if (!directory) return undefined;
    if (args['id'] === 'code.test') {
      const words = textInput(args, 'pattern').split(/\s+/).filter(Boolean);
      const resolved = await resolveProjectTestCommand(directory, configManager, words);
      return resolved ? [{ cmd: resolved.command, cwd: directory }] : undefined;
    }
    if (args['id'] === 'worktree.setup') {
      const worktree = textInput(args, 'worktree');
      const settings = projectWorktreeSettings(directory, {
        daemonFolder: directory,
        daemonProjectFile: join(directory, PROJECT_DAEMON_SETTINGS_FILE),
        daemonSetting: (key) => { try { return configManager.get(key as never); } catch { return undefined; } },
        // Every command that could run: the project's own commands are counted whatever its trust.
        folderTrust: () => 'trusted',
      });
      const commands = resolveEffectiveWorktreeSetup(settings.get, directory).commands;
      const cwd = worktree ? resolve(directory, worktree) : directory;
      return commands.length > 0 ? commands.map((cmd) => ({ cmd, cwd })) : undefined;
    }
    return undefined;
  };
}
