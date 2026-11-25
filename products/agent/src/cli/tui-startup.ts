import { reportStartupFailure, applySeededCliPrompt, resumeSessionAndRender } from '@goodvibes/engine/terminal-shell/startup-lifecycle';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
// Startup diagnostics must not initialize the Agent runtime/onboarding barrels:
// they pull in feature-enablement's eager metadata lookups before boot begins.
import { isOnboardingComplete } from '../runtime/onboarding/completion.ts';
import { writeOnboardingCheckMarker } from '../runtime/onboarding/markers.ts';
import { readSetupState } from '@goodvibes/engine/platform/platform/capabilities';
import { runDaemonCapability } from '@goodvibes/engine/terminal-shell/command-actions';
import { capabilityBinding } from '../input/commands/capability-binding.ts';
import { FirstRunModal, firstRunDecisionModel, installSplashAdditions, openWhoDecides, setSplashImportCommand, startFirstRun, type FirstRunDeps } from '@goodvibes/engine/terminal-shell/first-run';
import { requireSecretsManager, requireServiceRegistry, requireSubscriptionManager } from '../input/commands/runtime-services.ts';
import { scanThisComputerNow } from '../runtime/lan-scan-consent.ts';
import { logger } from '@goodvibes/engine/platform/platform/utils';
import type { GoodVibesCliParseResult } from './types.ts';
import { checkRecoveryFile, readLastSessionPointer, type SessionSurface } from '@goodvibes/engine/platform/platform/runtime/operations';
import { resolveResumableSession, surfaceResumeRelaunchNotice } from './resume-relaunch-notice.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { writeFatalLine } from '../utils/fatal-boot-write.ts';

type NodeLikeError = Error & {
  readonly code?: string;
  readonly path?: string;
  readonly syscall?: string;
};

export type FatalStartupFormatOptions = {
  readonly binary: string;
  readonly debug?: boolean;
};

function isNodeLikeError(error: unknown): error is NodeLikeError {
  return error instanceof Error;
}

function fatalStartupMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function fatalStartupStack(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return fatalStartupMessage(error);
}

export function formatFatalStartupErrorForLog(error: unknown): string {
  return fatalStartupStack(error);
}

/**
 * The one fatal-startup exit path for main(): say why on stderr, log the full
 * detail, and exit 1. Lives beside the two formatters it composes so main.ts
 * carries no error-formatting plumbing of its own. Each write is individually
 * best-effort, a failing logger or a torn-down stderr must never hide the
 * original launch failure.
 *
 * The stderr write goes FIRST, and its default sink is a synchronous write to
 * file descriptor 2 (`writeFatalLine`), not `process.stderr.write`. Both
 * details are the fix for a fatal path that could die mute:
 *
 *  - Ordering: the logger is the part that can fail. It needs a configured
 *    destination and a writable directory, and at this point in boot it may
 *    have neither, so reporting to it first risks throwing before the reason
 *    ever reaches a stream.
 *  - Sink: `main.ts` installs a terminal output guard that REPLACES
 *    `process.stderr.write` to keep stray output off a rendered screen. Any
 *    startup failure raised after that install had its explanation
 *    intercepted and swallowed, measured on a compiled binary as exit 1 with
 *    zero bytes on both streams. A descriptor write cannot be intercepted, and
 *    has completed by the time it returns rather than racing `process.exit`.
 *
 * `writeStderr` stays injectable so tests can observe it, but it is optional
 * and defaults to the descriptor write: a caller that forgets it gets the safe
 * behaviour rather than silence.
 */
export function reportFatalStartupError(
  err: unknown,
  options: FatalStartupFormatOptions,
  sinks: {
    readonly logError: (message: string, context: Record<string, unknown>) => void;
    readonly writeStderr?: (chunk: string) => void;
    readonly exit: (code: number) => void;
  },
): void {
  reportStartupFailure(err, {
    stderrFirst: true,
    userMessage: (error) => `${options.binary} failed to launch:\n${formatFatalStartupErrorForUser(error, options)}`,
    logContext: (error) => ({ error: formatFatalStartupErrorForLog(error) }),
    write: sinks.writeStderr ?? writeFatalLine,
    log: sinks.logError,
    exit: sinks.exit,
  });
}

export function formatFatalStartupErrorForUser(error: unknown, options: FatalStartupFormatOptions): string {
  if (options.debug === true) return fatalStartupStack(error);

  const message = fatalStartupMessage(error);
  if (isNodeLikeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
    return [
      `${options.binary} could not prepare its local workspace or log directory.`,
      error.path ? `  path: ${error.path}` : '',
      error.syscall ? `  operation: ${error.syscall}` : '',
      '  reason: permission denied',
      `  next: launch from a writable directory, pass '${options.binary} --cd <dir>', or set GOODVIBES_WORKING_DIR to a writable path.`,
      '  note: GOODVIBES_AGENT_HOME can be set to move Agent-local config, sessions, memory, skills, personas, and routines.',
    ]
      .filter((line) => line.length > 0)
      .join('\n');
  }

  if (isNodeLikeError(error) && error.code === 'ENOENT') {
    return [
      `${options.binary} could not find a required startup path.`,
      error.path ? `  path: ${error.path}` : '',
      `  reason: ${message}`,
      `  next: check '${options.binary} --cd <dir>' and GOODVIBES_WORKING_DIR, then rerun '${options.binary} status'.`,
    ]
      .filter((line) => line.length > 0)
      .join('\n');
  }

  return [message || `${options.binary} failed during startup.`, 'Set GOODVIBES_AGENT_DEBUG=1 to print a stack trace.'].join('\n');
}

export function applyInitialTuiCliState(options: {
  readonly cli: GoodVibesCliParseResult;
  readonly input: InputHandler;
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly shellPaths: Parameters<typeof isOnboardingComplete>[0] & { readonly homeDirectory: string };
  /** Declare-once session-storage handle threaded through the resume-relaunch notice's pointer/recovery reads so they can never diverge from the writer's paths. */
  readonly surface: SessionSurface;
  readonly render: () => void;
}): void {
  const { cli, input, commandRegistry, commandContext, shellPaths, surface, render } = options;
  // The one answer to "has setup been done" (completion.ts), as status and the setup screen read it.
  const onboardingDone = isOnboardingComplete(shellPaths);
  // What the empty conversation shows under the splash: first run's lines.
  installSplashAdditions({
    configManager: commandContext.platform.configManager,
    setupCommand: '/setup',
    splashShowing: () => input.conversationManager?.isSplashShowing() ?? false,
    renderRequest: render,
  });
  // The first launch only: when the terminal app has settings this Agent does not, say once which command brings them over.
  if (!onboardingDone) void offerTerminalSettingsImport(commandContext);
  // First run: when the model this session will use is not ready, choose a
  // provider, sign in, and land in the conversation (first-run-flow.ts). The
  // workspace's setup screens stay one key away (and /setup).
  const runFirstRun = (): void => {
    void startFirstRun(firstRunDeps(commandContext, shellPaths, render, onboardingDone, () => { input.conversationManager?.invalidateRenderedLines(); })).catch((error: unknown) => {
      logger.warn('First run could not start', { error: summarizeError(error) });
    });
  };
  // `/setup` → Run first-run again: the three steps, whether or not a model is ready.
  commandContext.openFirstRun = () => {
    // Asked for: "Who decides" follows the model whenever it is needed, answered before or not.
    const deps = { ...firstRunDeps(commandContext, shellPaths, render, true, () => { input.conversationManager?.invalidateRenderedLines(); }), whoDecidesAsked: () => false, includeWhoDecides: true };
    if (!deps.pushSurfaceModal) return;
    const modal = new FirstRunModal(deps);
    deps.pushSurfaceModal(modal);
    void modal.load().catch((error: unknown) => {
      logger.warn('First run could not start', { error: summarizeError(error) });
    });
  };
  // The status line's mode segment, while no decision model can be asked, and the Setup list's row (always): "Who decides".
  commandContext.openWhoDecides = (whoOptions) => openWhoDecides(firstRunDeps(commandContext, shellPaths, render, true, () => { input.conversationManager?.invalidateRenderedLines(); }), whoOptions);
  if (cli.command === 'onboarding') {
    // The setup topics, over the empty conversation.
    void commandContext.executeCommand?.('setup', []);
  } else if ((cli.command === 'sessions' && cli.commandArgs[0] === 'resume') || cli.flags.resume !== undefined) {
    const requested = cli.flags.resume ?? cli.commandArgs.slice(1).join(' ').trim();
    const target = requested === 'latest' ? (readLastSessionPointer({ surface }) ?? '') : requested;
    if (target) {
      // A handler that throws (a corrupt session file, say) must be said, not left to the process-level rejection handler.
      resumeSessionAndRender(commandRegistry, target, commandContext, render).catch((error: unknown) => {
        commandContext.print(`[Resume] Could not resume session ${target}: ${summarizeError(error)}`);
      });
    } else {
      // Nothing to continue: say so, then start as a plain launch would, so a
      // new user who starts with --resume still gets setup.
      commandContext.print('No previous conversation to continue. This is a new one; the Sessions place lists saved ones.');
      runFirstRun();
    }
  } else {
    runFirstRun();
    if (!onboardingDone) {
      applySeededCliPrompt(cli, input);
      return;
    }
    // Normal relaunch: onboarding is done and the user didn't ask for
    // onboarding or an explicit `sessions resume`. Surface an honest,
    // non-blocking resume affordance instead of silently starting fresh
    // (a dogfood finding), never auto-resume, declining is
    // frictionless (just start typing).
    surfaceResumeRelaunchNotice({
      getLastSessionPointer: () => readLastSessionPointer({ surface }),
      isRecoveryPending: () => Boolean(checkRecoveryFile({ surface })),
      findSession: (sessionId) => {
        const sessionManager = commandContext.session?.sessionManager;
        return sessionManager ? resolveResumableSession(sessionManager, sessionId) : null;
      },
      print: (text) => commandContext.print(text),
    });
  }

  applySeededCliPrompt(cli, input);
}

/**
 * Under the first launch's splash, the command that brings over the terminal
 * app's settings, when its settings files hold something the Agent would take
 * (the import's own plan, read once). Loaded here rather than at the top: this
 * module is read before boot, when the workspace modules must not load yet.
 */
async function offerTerminalSettingsImport(commandContext: CommandContext): Promise<void> {
  try {
    const settings = await import('../input/agent-workspace-settings.ts');
    const plan = settings.planAgentWorkspaceTuiSettingsImport(commandContext);
    if (plan === null || !settings.agentWorkspaceTuiSettingsImportHasChanges(plan)) return;
    // A one-key choice where it is offered: Enter on the empty composer imports exactly that plan at once
    // (the key is the request); the answer lists what changed and names the copy that puts it back.
    setSplashImportCommand('/setup import-settings', () => {
      void (async () => {
        const outcome = await settings.applyAgentWorkspaceTuiSettingsImport(commandContext, plan);
        commandContext.print([outcome.status, ...(outcome.result?.detail ? [outcome.result.detail] : [])].join('\n'));
      })().catch((error: unknown) => {
        commandContext.print(`The terminal app's settings were not imported: ${summarizeError(error)}`);
      });
    });
  } catch (error) {
    logger.warn('The terminal app settings could not be read for the first-launch import line', { error: summarizeError(error) });
  }
}

/** What first run needs from the Agent. */
function firstRunDeps(
  commandContext: CommandContext,
  shellPaths: Parameters<typeof writeOnboardingCheckMarker>[0],
  render: () => void,
  markedDone: boolean,
  redraw: () => void,
): FirstRunDeps {
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
    // "Who decides" asked once for both programs: the daemon's one setup record (capabilities/builtin/system-setup.ts).
    whoDecidesAsked: () => {
      const home = commandContext.workspace?.shellPaths?.homeDirectory;
      return home ? readSetupState(home).whoDecides !== null : false;
    },
    recordWhoDecides: (how) => {
      void runDaemonCapability('setup.who-decides-asked', { how }, commandContext, capabilityBinding).catch((error: unknown) => {
        commandContext.print(`"Who decides" could not be recorded with the daemon, so first run may ask it again: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  };
}
