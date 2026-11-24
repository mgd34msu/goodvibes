import { reportStartupFailure, applySeededCliPrompt, resumeSessionAndRender } from '@goodvibes/engine/terminal-shell/startup-lifecycle';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { SelectionItem } from '../input/selection-modal.ts';
import { NOTHING_OF_ITS_OWN_TO_RUN, type WorkspaceRegistrationManager, type WorkspaceTrustManager } from '@goodvibes/engine/platform/platform/runtime/operations';
import { readOnboardingCheckMarker, readWhoDecidesAsked, writeOnboardingCheckMarker, writeWhoDecidesAsked } from '../runtime/onboarding/index.ts';
import { FirstRunModal, firstRunDecisionModel, installSplashAdditions, openWhoDecides, startFirstRun, type FirstRunDeps } from '@goodvibes/engine/terminal-shell/first-run';
import { requireSecretsManager, requireServiceRegistry, requireSubscriptionManager } from '../input/commands/runtime-services.ts';
import { scanThisComputerNow } from '../runtime/startup-provider-registration.ts';
import { readLastSessionPointer, type SessionSurface } from '@/runtime/index.ts';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { writeFatalLine } from '@goodvibes/engine/platform/platform/daemon';
import type { GoodVibesCliParseResult } from '@goodvibes/engine/terminal-shell';
import { openDeepLink, parseDeepLink } from '../input/commands/deep-link.ts';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { loadMcpEffectiveConfig, ownerAddedServers } from '@goodvibes/engine/platform/platform/mcp';

export type TuiStartupShellPaths = Parameters<typeof readOnboardingCheckMarker>[0] & {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
};

export type FirstOpenTrustLevel = 'trusted' | 'restricted';

/**
 * The trust decision a chosen row of the trust prompt records: 'trusted' or
 * 'restricted' for the row of that name, null when no row was chosen (the
 * prompt was dismissed), which records nothing and leaves the workspace
 * undecided so the next request asks again.
 */
export function decodeFirstOpenChoice(id: string | null): FirstOpenTrustLevel | null {
  if (id === 'trusted') return 'trusted';
  if (id === 'restricted') return 'restricted';
  return null;
}

/**
 * Build the selection rows for the trust prompt. This used to also offer a
 * "register this directory?" half (a combined 2x2 when both were needed),
 * that half is gone: registration self-records (see
 * selfRecordWorkspaceRegistration below) rather than ever asking a question
 * about a registry the user hasn't met yet.
 */
export function buildFirstOpenItems(folder: FolderTrustFacts): { readonly title: string; readonly items: SelectionItem[] } {
  // What trusting lets run, named from what the folder has; never a sentence about things it does not have.
  const runs = [
    ...(folder.hooksFile !== null ? [`the hooks in ${folder.hooksFile} run`] : []),
    ...(folder.mcpFiles.length > 0
      ? [`the tool ${folder.mcpServers.length === 1 ? 'server' : 'servers'} (MCP) ${folder.mcpServers.length > 0 ? `${folder.mcpServers.join(', ')} ` : ''}in ${folder.mcpFiles.join(', ')} start`]
      : []),
  ];
  const lets = runs.length > 0
    ? `Trusting it lets ${runs.join(' and ')}, and lets GoodVibes change files and run commands here.`
    : 'Trusting it lets GoodVibes change files and run commands here.';
  const undo = 'Change it later with /security trust-folder or /security restrict-folder.';
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
        detail: `GoodVibes reads this folder and changes nothing in it: no file is changed and no command runs, and the folder's own hooks and MCP servers stay off, until you trust it. ${undo}`,
        primaryAction: 'select',
      },
    ],
  };
}

/** What the trust prompt names: the folder (home shortened to ~) and the files of its own that trusting would let run. */
export interface FolderTrustFacts {
  readonly shownPath: string;
  /** The folder's own hooks file as shown ("hooks.json"), or null when it has none. */
  readonly hooksFile: string | null;
  /** Its own MCP server files as shown (".mcp.json") that name a server you did not add yourself; empty when it has none. */
  readonly mcpFiles: readonly string[];
  /** Those servers, by name: the ones the folder brought (a cloned file, a write from outside), never one you added with /mcp add. */
  readonly mcpServers: readonly string[];
  /** True when it has a hooks file or MCP server files of its own. */
  readonly hasItsOwn: boolean;
}

/** Read which of the folder's own hooks and MCP files exist (two or three stat calls, once per prompt). */
export function readFolderTrustFacts(workingDirectory: string, homeDirectory: string, hooksFile: string): FolderTrustFacts {
  let real = workingDirectory;
  try { real = realpathSync(workingDirectory); } catch { /* the folder as given */ }
  const shownPath = homeDirectory && (real === homeDirectory || real.startsWith(`${homeDirectory}${sep}`)) ? `~${real.slice(homeDirectory.length)}` : real;
  const hooks = isAbsolute(hooksFile) ? hooksFile : join(workingDirectory, hooksFile || 'hooks.json');
  const hooksShown = existsSync(hooks) ? relative(workingDirectory, hooks) || hooks : null;
  // The servers the folder's own MCP files name that you did not add yourself (with /mcp add or a form): those are its own.
  const brought = loadMcpEffectiveConfig({ workingDirectory, homeDirectory }, { holdProjectFile: () => true, ownerAdded: ownerAddedServers(homeDirectory) }).held ?? [];
  const mcpFiles = [...new Set(brought.map((entry) => relative(workingDirectory, entry.source.path)))];
  const mcpServers = [...new Set(brought.map((entry) => entry.server.name))];
  return { shownPath, hooksFile: hooksShown, mcpFiles, mcpServers, hasItsOwn: hooksShown !== null || mcpFiles.length > 0 };
}

/**
 * Registration self-records: a workspace the user actually works in becomes
 * its own registry entry with no question ever asked (the former "Register
 * this directory as a workspace?" prompt, sometimes a four-option 2x2 when
 * trust was undecided too, is gone entirely).
 *
 * "Actually works in" is anchored to TRUST, not mere directory-open: this is
 * only ever called for a workspace that is (or has just become) trusted,
 * never for one that's merely been glanced at read-only. Labeled 'via TUI'
 * in the shared registry so its provenance is honest.
 *
 * OWNER-BOUNDARY RIDER (binding): self-recording must not widen the
 * checkpoint-owning consumer's boundary. That boundary now reads the SAME
 * shared registration store this writes to, gated by each record's
 * `checkpointEligible` flag (absent means false). So the separation is no
 * longer "a separate list the agent owns", it is one store, and this self
 * record stays out of scope by stamping its `origin` ('tui') for honest
 * provenance while NEVER setting `checkpointEligible`. Only the consumer that
 * owns checkpointing re-stamps its own roots eligible on boot.
 */
export async function selfRecordWorkspaceRegistration(
  registrationManager: Pick<WorkspaceRegistrationManager, 'evaluate' | 'register'> | undefined,
): Promise<void> {
  if (!registrationManager) return;
  // Callers fire and forget; an unreadable or unwritable registry must be a log line, not an unhandled rejection.
  try {
    const evaluation = await registrationManager.evaluate();
    if (!evaluation.offerRegister) return;
    await registrationManager.register('via TUI', 'tui');
  } catch (error) {
    logger.warn('Workspace registration was not recorded', { error: summarizeError(error) });
  }
}

/**
 * Settle the workspace's trust as the program opens (its saved decision read
 * first). A folder with no decision and no hooks file or MCP servers of its own
 * is trusted without a question: trusting it would let nothing run that the
 * permission mode does not already govern. It is recorded with the reason
 * "nothing of its own to run" and the person is told nothing. A folder with no
 * decision that has them is asked about, naming them. A folder trusted that way
 * that has gained them since is asked about now, before any of them runs; one
 * that gains them later is asked when its hooks are about to fire or its
 * servers to start (the manager's repositoryFilesHeld). Resolves when settled:
 * answered, dismissed (left as it was; a write or command asks again), or not needed.
 */
async function askTrustOnOpen(
  manager: Pick<WorkspaceTrustManager, 'load' | 'isDecided' | 'trustQuestion' | 'setLevel' | 'trustedForNothingToRun' | 'askWhenRepositoryFilesAppear'> | undefined,
  requestTrustDecision: (() => Promise<FirstOpenTrustLevel>) | undefined,
  folder: () => FolderTrustFacts,
): Promise<void> {
  if (!manager || !requestTrustDecision) return;
  try {
    await manager.load();
    manager.askWhenRepositoryFilesAppear(requestTrustDecision);
    const hasItsOwn = folder().hasItsOwn;
    if (!manager.isDecided() && !hasItsOwn) {
      const saved = await manager.setLevel('trusted', NOTHING_OF_ITS_OWN_TO_RUN);
      if (!saved.saved) logger.warn('The workspace was trusted for this session (nothing of its own to run) but the decision could not be saved', { fault: saved.fault });
      return;
    }
    if (!manager.isDecided() || (manager.trustedForNothingToRun() && hasItsOwn)) await manager.trustQuestion(requestTrustDecision).answer;
  } catch (error) {
    logger.info('The workspace trust question asked on opening was not answered', { error: summarizeError(error) });
  }
}

export function applyInitialTuiCliState(options: {
  readonly cli: GoodVibesCliParseResult;
  readonly input: InputHandler;
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly shellPaths: TuiStartupShellPaths;
  /**
   * The app's declare-once session-storage handle, the SAME one the runtime
   * writes the last-session pointer through. `--continue` and bare `--resume`
   * read that pointer below; deriving its path independently here is exactly
   * how this read used to land on a file nothing ever wrote.
   */
  readonly surface: SessionSurface;
  readonly render: () => void;
  /** Raises the trust prompt (ui-openers' trustPromptRef); asked here once when the folder has no decision. */
  readonly requestTrustDecision?: (() => Promise<FirstOpenTrustLevel>) | undefined;
}): Promise<void> | undefined {
  const { cli, input, commandRegistry, commandContext, shellPaths, surface, render } = options;
  const globalOnboardingMarker = readOnboardingCheckMarker(shellPaths, 'user');

  // A folder with no trust decision is settled as it opens, before any prompt
  // is acted on (askTrustOnOpen): trusted without a question when it has nothing
  // of its own to run, otherwise asked, the prompt opening on "Trust this
  // workspace" (the person came to work here). After "Keep restricted" nothing
  // in the folder is changed: a restriction refuses every write and command.
  const trustSettled = askTrustOnOpen(commandContext.workspace?.workspaceTrustManager, options.requestTrustDecision,
    () => readFolderTrustFacts(shellPaths.workingDirectory, shellPaths.homeDirectory, String(commandContext.platform.configManager.get('tools.hooksFile') ?? '')));

  // Registration self-records on every launch of an already-trusted
  // workspace (fire-and-forget, never blocks or gates startup, never a
  // modal). A workspace that is undecided or restricted is never
  // self-registered here; for one that becomes trusted just now (via the
  // trust prompt), main.ts's trustPromptRef wiring calls this same helper
  // right after the decision.
  if (commandContext.workspace?.workspaceTrustManager?.isTrusted()) {
    void selfRecordWorkspaceRegistration(commandContext.workspace.workspaceRegistrationManager);
  }

  // Seeded prompt is always applied synchronously, regardless of session branch.
  applySeededCliPrompt(cli, input);

  // What the empty conversation shows under the splash: first run's lines.
  installSplashAdditions({
    configManager: commandContext.platform.configManager,
    setupCommand: '/setup',
    splashShowing: () => input.conversationManager?.isSplashShowing() ?? false,
    renderRequest: render,
  });

  // First run: when the model this session will use is not ready, choose a
  // provider, sign in, and land in the conversation (first-run-flow.ts). It
  // starts once the trust question asked on opening is settled.
  const runFirstRunSteps = (): void => {
    void trustSettled.then(() => startFirstRun(firstRunDeps(commandContext, shellPaths, render, globalOnboardingMarker.payload !== null, () => { input.conversationManager?.invalidateRenderedLines(); }))).catch((error: unknown) => {
      logger.warn('First run could not start', { error: summarizeError(error) });
    });
  };
  // `/setup` → Run first-run again: the three steps, whether or not a model is ready.
  commandContext.openFirstRun = () => {
    // Asked for: "Who decides" follows the model whenever it is needed, answered before or not.
    const deps = { ...firstRunDeps(commandContext, shellPaths, render, true, () => { input.conversationManager?.invalidateRenderedLines(); }), whoDecidesAsked: () => false };
    if (!deps.pushSurfaceModal) return;
    const modal = new FirstRunModal(deps);
    deps.pushSurfaceModal(modal);
    void modal.load().catch((error: unknown) => {
      logger.warn('First run could not start', { error: summarizeError(error) });
    });
  };
  // The status line's mode segment, while no decision model can be asked: "Who decides", whenever the person wants it.
  commandContext.openWhoDecides = () => openWhoDecides(firstRunDeps(commandContext, shellPaths, render, true, () => { input.conversationManager?.invalidateRenderedLines(); }));
  // --continue or bare --resume with no saved conversation: say so, then start
  // as a plain launch would rather than opening an unexplained empty session.
  const nothingToContinue = (): void => {
    commandContext.print('No previous conversation to continue. This is a new one; /session list shows saved ones.');
    runFirstRunSteps();
  };

  if (cli.command === 'setup') {
    // `goodvibes setup`: the /setup topics, over the empty conversation.
    void commandContext.executeCommand?.('setup', []);
  } else if (cli.command === 'open') {
    // The entry point refused a link that does not parse, so this one does.
    const link = parseDeepLink(cli.commandArgs[0] ?? '');
    if (link) commandContext.print(openDeepLink(commandContext, link.surface, link.target));
    runFirstRunSteps();
  } else if ((cli.command === 'sessions' && cli.commandArgs[0] === 'resume') || cli.flags.continueLast || cli.flags.resume !== undefined || cli.flags.fork !== undefined) {
    // One session to open, in this order: `sessions resume <id>`; `--continue`
    // (the last session); `--resume [id]`; `--fork [id]`. A bare `--resume` or
    // `--fork` means the last session, read from the pointer file. A crash
    // snapshot newer than its saved copy is offered by the resume routine, as
    // for every other way of opening one.
    const sessionsResume = cli.command === 'sessions' && cli.commandArgs[0] === 'resume';
    const fork = !sessionsResume && !cli.flags.continueLast && cli.flags.resume === undefined;
    const named = sessionsResume
      ? cli.commandArgs.slice(1).join(' ').trim()
      : cli.flags.continueLast
        ? undefined
        : cli.flags.resume !== undefined
          ? (cli.flags.resume === 'latest' ? undefined : cli.flags.resume)
          : typeof cli.flags.fork === 'string' ? cli.flags.fork : undefined;
    const target = named ?? readLastSessionPointer({ surface }) ?? '';
    if (!target) {
      nothingToContinue();
      return undefined;
    }
    // A fork runs only after its session resumed, so bare --fork forks the last
    // session and never the new empty one.
    return resumeSessionAndRender(commandRegistry, target, commandContext, render).then(
      async () => {
        if (!fork) return;
        // The session is open by now: a failed fork leaves it open as it is, so first run does not start over it.
        try {
          await commandRegistry.execute('session', ['fork'], commandContext);
        } catch (error) {
          commandContext.print(`[Fork] Resumed session ${target}, but it was not forked: ${summarizeError(error)}. Later turns are saved to ${target}; run /session fork to make a copy.`);
        }
        render();
      },
      (error: unknown) => {
        // A refusal (no such session, one open elsewhere) is said with its own next step, then the launch goes on as a plain one would.
        commandContext.print(`[Resume] Could not resume session ${target}: ${summarizeError(error)}`);
        render();
        runFirstRunSteps();
      },
    );
  } else {
    runFirstRunSteps();
  }
}

/** What first run needs from the terminal app. */
function firstRunDeps(commandContext: CommandContext, shellPaths: TuiStartupShellPaths, render: () => void, markedDone: boolean, redraw: () => void): FirstRunDeps {
  return {
    providerRegistry: commandContext.provider.providerRegistry,
    configManager: commandContext.platform.configManager,
    secrets: requireSecretsManager(commandContext),
    subscriptions: requireSubscriptionManager(commandContext),
    serviceConfig: (provider) => requireServiceRegistry(commandContext).get(provider),
    pushSurfaceModal: commandContext.pushSurfaceModal,
    renderRequest: render,
    completeModelSelection: commandContext.completeModelSelection,
    openProviderPicker: commandContext.openProviderPicker,
    scanThisComputer: () => { scanThisComputerNow(); },
    redrawConversation: redraw,
    markDone: () => { writeOnboardingCheckMarker(shellPaths, { source: 'command' }); },
    isMarkedDone: () => markedDone,
    // "Who decides" after the model, when no decision model can be asked yet.
    decisionModel: firstRunDecisionModel(commandContext.platform.configManager, requireSecretsManager(commandContext)),
    // "Another decision model…": Settings, on the decision model.
    openDecisionModelSettings: () => { commandContext.openSettingsModal?.('judgment.model'); },
    whoDecidesAsked: () => readWhoDecidesAsked(shellPaths),
    recordWhoDecides: (how) => { writeWhoDecidesAsked(shellPaths, how); },
  };
}

/**
 * reportFatalStartupError, the main() catch handler. A bare Error
 * JSON-serializes to {} in structured logs, and background timers keep the
 * process alive after a boot failure, the historical result was a blank
 * screen and a useless `Fatal error {"error": {}}` log line. Log real
 * fields, tell the user what broke, and exit. Both writes are individually
 * best-effort, a failing logger or torn-down stderr must never hide the
 * original launch failure.
 */
export function reportFatalStartupError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  reportStartupFailure(err, {
    stderrFirst: false,
    userMessage: () => `goodvibes failed to start: ${message}${stack ? `\n${stack}` : ''}`,
    logContext: () => ({ message, ...(stack ? { stack } : {}) }),
    write: writeFatalLine,
    log: (message, context) => logger.error(message, context),
    exit: process.exit,
  });
}
