/**
 * folder-trust.ts: what a folder brings of its own (a hooks file, tool servers
 * in its MCP files that the owner did not add), and the one rule both terminal
 * programs apply to a folder with no trust decision: a folder that brings
 * neither is trusted without a question, because trusting it lets nothing run
 * that the permission mode does not already govern. The interactive start
 * (the terminal app's tui-startup.ts) and `run` in both programs apply it the
 * same way and record it the same way, in the workspace trust file with the
 * reason "nothing of its own to run". A folder that brings hooks or tool
 * servers is left undecided: the interactive start asks, and a headless run
 * does not trust it, refusing every call that needs trust at once with a
 * sentence naming the folder, what it brings and how to trust it.
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { loadMcpEffectiveConfig, ownerAddedServers } from '@goodvibes/engine/platform/platform/mcp';
import { NOTHING_OF_ITS_OWN_TO_RUN, projectSetupCommandsFile, type WorkspaceTrustManager } from '@goodvibes/engine/platform/platform/runtime/operations';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { projectIdentityOf } from '@goodvibes/engine/platform/platform/workspace';
import type { SelectionItem } from '../selection-modal.js';

/** What the trust prompt names: the folder (home shortened to ~) and the files of its own that trusting would let run. */
export interface FolderTrustFacts {
  readonly shownPath: string;
  /** The folder's own hooks file as shown ("hooks.json"), or null when it has none. */
  readonly hooksFile: string | null;
  /** Its own MCP server files as shown (".mcp.json") that name a server you did not add yourself; empty when it has none. */
  readonly mcpFiles: readonly string[];
  /** Those servers, by name: the ones the folder brought (a cloned file, a write from outside), never one you added with /mcp add. */
  readonly mcpServers: readonly string[];
  /**
   * Its own settings file as shown (".goodvibes/daemon-host/settings.json") when it gives worktree setup commands, or
   * null: the daemon runs those commands for this folder's worktrees only when the folder is trusted.
   */
  readonly setupCommandsFile: string | null;
  /** True when it has a hooks file, MCP server files or a settings file with setup commands of its own. */
  readonly hasItsOwn: boolean;
}

/** Read which of the folder's own hooks and MCP files exist (two or three stat calls, once per prompt or run). */
export function readFolderTrustFacts(openedIn: string, homeDirectory: string, hooksFile: string): FolderTrustFacts {
  let opened = openedIn;
  try { opened = realpathSync(openedIn); } catch { /* the folder as given */ }
  // Trust is the project's: a program opened in a subfolder asks about the project it works for (its root), and
  // what that project brings of its own is read there.
  const workingDirectory = projectIdentityOf(opened);
  const real = workingDirectory;
  const shownPath = homeDirectory && (real === homeDirectory || real.startsWith(`${homeDirectory}${sep}`)) ? `~${real.slice(homeDirectory.length)}` : real;
  const hooks = isAbsolute(hooksFile) ? hooksFile : join(workingDirectory, hooksFile || 'hooks.json');
  const hooksShown = existsSync(hooks) ? relative(workingDirectory, hooks) || hooks : null;
  // The servers the folder's own MCP files name that you did not add yourself (with /mcp add or a form): those are its own.
  const brought = loadMcpEffectiveConfig({ workingDirectory, homeDirectory }, { holdProjectFile: () => true, ownerAdded: ownerAddedServers(homeDirectory) }).held ?? [];
  const mcpFiles = [...new Set(brought.map((entry) => relative(workingDirectory, entry.source.path)))];
  const mcpServers = [...new Set(brought.map((entry) => entry.server.name))];
  const setupCommandsFile = projectSetupCommandsFile(workingDirectory);
  return {
    shownPath, hooksFile: hooksShown, mcpFiles, mcpServers, setupCommandsFile,
    hasItsOwn: hooksShown !== null || mcpFiles.length > 0 || setupCommandsFile !== null,
  };
}

/** What a folder brings of its own, in words: "a hooks file (hooks.json) and tool servers (MCP) weather in .mcp.json". */
function broughtWords(folder: FolderTrustFacts): string {
  const parts = [
    ...(folder.hooksFile !== null ? [`a hooks file (${folder.hooksFile})`] : []),
    ...(folder.mcpFiles.length > 0
      ? [`tool ${folder.mcpServers.length === 1 ? 'server' : 'servers'} (MCP) ${folder.mcpServers.length > 0 ? `${folder.mcpServers.join(', ')} ` : ''}in ${folder.mcpFiles.join(', ')}`]
      : []),
    ...(folder.setupCommandsFile !== null ? [`worktree setup commands (in ${folder.setupCommandsFile})`] : []),
  ];
  return parts.join(' and ');
}

/** The sentence a headless run refuses a call with in a folder that brings hooks or tool servers of its own. */
export function headlessUntrustedFolderSentence(folder: FolderTrustFacts): string {
  return `${folder.shownPath} brings ${broughtWords(folder)} of its own and has no trust decision, so this run does not trust it: `
    + 'no file is changed and no command runs there; reads still work. To trust it, open it in goodvibes and choose '
    + '"Trust this workspace", or "Trust this folder" in Permissions and safety, This folder, then run again.';
}

/**
 * Before a headless run's turn (`run` in both programs, nobody to ask): a
 * folder with no trust decision and nothing of its own is trusted as the
 * interactive start does (trustFolderWithNothingOfItsOwn); one that brings
 * hooks or tool servers of its own is not trusted for this run, and every call
 * that needs trust is refused at once with headlessUntrustedFolderSentence
 * (nothing saved: it stays undecided). Never throws.
 */
export async function settleHeadlessFolderTrust(
  manager: Pick<WorkspaceTrustManager, 'load' | 'isDecided' | 'setLevel' | 'refuseForThisRun'> | undefined,
  folder: () => FolderTrustFacts,
): Promise<void> {
  if (!manager) return;
  if (await trustFolderWithNothingOfItsOwn(manager, folder)) return;
  try {
    const facts = folder();
    if (!manager.isDecided() && facts.hasItsOwn) manager.refuseForThisRun(headlessUntrustedFolderSentence(facts));
  } catch (error) {
    logger.info('The headless trust refusal for a folder with files of its own was not set', { error: summarizeError(error) });
  }
}

/** A trust decision the card records. */
export type FolderTrustChoice = 'trusted' | 'restricted';

/**
 * The trust card both terminal programs show for a folder with no decision that
 * brings hooks or tool servers of its own (and for one trusted for having
 * nothing that has gained them since): the same title, rows and words in the
 * terminal app and the Agent. It opens on "Keep restricted" (FOLDER_TRUST_OPENS_ON):
 * Enter pressed straight away trusts nothing.
 */
export function folderTrustCard(folder: FolderTrustFacts): { readonly title: string; readonly items: SelectionItem[] } {
  // What trusting lets run, named from what the folder has; never a sentence about things it does not have.
  const runs = [
    ...(folder.hooksFile !== null ? [`the hooks in ${folder.hooksFile} run`] : []),
    ...(folder.mcpFiles.length > 0
      ? [`the tool ${folder.mcpServers.length === 1 ? 'server' : 'servers'} (MCP) ${folder.mcpServers.length > 0 ? `${folder.mcpServers.join(', ')} ` : ''}in ${folder.mcpFiles.join(', ')} start`]
      : []),
    ...(folder.setupCommandsFile !== null ? [`the worktree setup commands in ${folder.setupCommandsFile} run when a worktree is set up`] : []),
  ];
  const lets = runs.length > 0
    ? `Trusting it lets ${runs.join(' and ')}, and lets GoodVibes change files and run commands here.`
    : 'Trusting it lets GoodVibes change files and run commands here.';
  const undo = 'Change it later in Permissions and safety, This folder.';
  return {
    title: `Trust ${folder.shownPath}?`,
    items: [
      {
        id: 'trusted',
        label: 'Trust this workspace',
        detail: `${lets} It approves nothing: each action still follows your setting for when GoodVibes asks. ${undo}`,
        primaryAction: 'select',
      },
      {
        id: 'restricted',
        label: 'Keep restricted (read-only)',
        detail: `GoodVibes reads this folder and changes nothing in it: no file is changed and no command runs, and the folder's own hooks, MCP servers and worktree setup commands stay off, until you trust it. ${undo}`,
        primaryAction: 'select',
      },
    ],
  };
}

/** The row the trust card opens on. */
export const FOLDER_TRUST_OPENS_ON = 'restricted';

/** The decision a chosen row records; null when no row was chosen (dismissed: nothing recorded, the folder stays undecided). */
export function decodeFolderTrustChoice(id: string | null): FolderTrustChoice | null {
  if (id === 'trusted') return 'trusted';
  if (id === 'restricted') return 'restricted';
  return null;
}

/**
 * Settle the folder's trust as an interactive program opens (both terminal
 * programs, the same rule): its saved decision read first; a folder with no
 * decision and nothing of its own is trusted without a question
 * (trustFolderWithNothingOfItsOwn); one with no decision that brings hooks or
 * tool servers is asked with the trust card; one trusted for having nothing
 * that has gained them since is asked now, before any of them runs; one that
 * gains them later is asked when its hooks are about to fire or its servers to
 * start. Resolves when settled: answered, dismissed (left as it was; a write or
 * command asks again), or not needed. Never throws.
 */
export async function settleFolderTrustOnOpen(
  manager: Pick<WorkspaceTrustManager, 'load' | 'isDecided' | 'trustQuestion' | 'setLevel' | 'trustedForNothingToRun' | 'askWhenRepositoryFilesAppear'> | undefined,
  requestTrustDecision: (() => Promise<FolderTrustChoice>) | undefined,
  folder: () => FolderTrustFacts,
): Promise<void> {
  if (!manager || !requestTrustDecision) return;
  try {
    await manager.load();
    manager.askWhenRepositoryFilesAppear(requestTrustDecision);
    const facts = folder();
    if (await trustFolderWithNothingOfItsOwn(manager, () => facts)) return;
    if (!manager.isDecided() || (manager.trustedForNothingToRun() && facts.hasItsOwn)) await manager.trustQuestion(requestTrustDecision).answer;
  } catch (error) {
    logger.info('The workspace trust question asked on opening was not answered', { error: summarizeError(error) });
  }
}

/**
 * A folder with no trust decision and nothing of its own to run (no hooks
 * file, no tool servers it brought) is trusted, recorded with the reason
 * "nothing of its own to run"; the person is told nothing. Any other folder is
 * left as it is. Returns whether it trusted the folder. Never throws.
 */
export async function trustFolderWithNothingOfItsOwn(
  manager: Pick<WorkspaceTrustManager, 'load' | 'isDecided' | 'setLevel'> | undefined,
  folder: () => FolderTrustFacts,
): Promise<boolean> {
  if (!manager) return false;
  try {
    await manager.load();
    if (manager.isDecided() || folder().hasItsOwn) return false;
    const saved = await manager.setLevel('trusted', NOTHING_OF_ITS_OWN_TO_RUN);
    if (!saved.saved) logger.warn('The workspace was trusted for this session (nothing of its own to run) but the decision could not be saved', { fault: saved.fault });
    return true;
  } catch (error) {
    logger.info('The workspace trust decision for a folder with nothing of its own to run was not recorded', { error: summarizeError(error) });
    return false;
  }
}
