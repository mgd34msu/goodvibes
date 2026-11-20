import { reportStartupFailure, applySeededCliPrompt, resumeSessionAndRender } from '@goodvibes-jev/engine/terminal-shell/startup-lifecycle';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
// Startup diagnostics must not initialize the Agent runtime/onboarding barrels:
// they pull in feature-enablement's eager metadata lookups before boot begins.
import { isOnboardingComplete } from '../runtime/onboarding/completion.ts';
import { writeOnboardingCheckMarker } from '../runtime/onboarding/markers.ts';
import { FirstRunModal, installSplashAdditions, startFirstRun, type FirstRunDeps } from '@goodvibes-jev/engine/terminal-shell/first-run';
import { requireSecretsManager, requireServiceRegistry, requireSubscriptionManager } from '../input/commands/runtime-services.ts';
import { scanThisComputerNow } from '../runtime/lan-scan-consent.ts';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import type { GoodVibesCliParseResult } from './types.ts';
import { checkRecoveryFile, readLastSessionPointer, type SessionSurface } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { resolveResumableSession, surfaceResumeRelaunchNotice } from './resume-relaunch-notice.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { writeFatalLine } from '../utils/fatal-boot-write.ts';

export type InteractiveTerminalCheckInput = {
  readonly binary: string;
  readonly stdinIsTTY: boolean | undefined;
  readonly stdoutIsTTY: boolean | undefined;
};

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

export function getInteractiveTerminalLaunchError(input: InteractiveTerminalCheckInput): string | null {
  const stdinReady = input.stdinIsTTY === true;
  const stdoutReady = input.stdoutIsTTY === true;
  if (stdinReady && stdoutReady) return null;

  const missing = [stdinReady ? null : 'stdin', stdoutReady ? null : 'stdout'].filter((entry): entry is string => entry !== null);
  const missingLabel = missing.length === 1 ? `${missing[0]} is` : `${missing.join(' and ')} are`;

  return [
    `${input.binary} requires an interactive terminal for the TUI (${missingLabel} not a TTY).`,
    `Run it from a terminal, or use non-interactive commands such as '${input.binary} --help', '${input.binary} status --json', or '${input.binary} run --print "<prompt>"'.`,
  ].join('\n');
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
  // What the empty conversation shows under the splash: the starting prompts, and first run's lines.
  installSplashAdditions({
    workingDirectory: shellPaths.workingDirectory,
    configManager: commandContext.platform.configManager,
    // /setup once it is registered; until then the setup screens open with /onboarding.
    setupCommand: commandRegistry.get('setup') ? '/setup' : '/onboarding',
    fillComposer: (text) => {
      if (input.prompt !== '') return;
      input.prompt = text;
      input.cursorPos = text.length;
      render();
    },
    splashShowing: () => input.conversationManager?.isSplashShowing() ?? false,
    renderRequest: render,
  });
  // First run: when the model this session will use is not ready, choose a
  // provider, sign in, and land in the conversation (first-run-flow.ts). The
  // workspace's setup screens stay one key away (and /onboarding).
  const runFirstRun = (): void => {
    void startFirstRun(firstRunDeps(commandContext, shellPaths, render, onboardingDone)).catch((error: unknown) => {
      logger.warn('First run could not start', { error: summarizeError(error) });
    });
  };
  // `/setup` → Run first-run again: the three steps, whether or not a model is ready.
  commandContext.openFirstRun = () => {
    const deps = firstRunDeps(commandContext, shellPaths, render, true);
    if (!deps.pushSurfaceModal) return;
    const modal = new FirstRunModal(deps);
    deps.pushSurfaceModal(modal);
    void modal.load().catch((error: unknown) => {
      logger.warn('First run could not start', { error: summarizeError(error) });
    });
  };
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
      commandContext.print('No previous conversation to continue. This is a new one; /session list shows saved ones.');
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

/** What first run needs from the Agent. */
function firstRunDeps(
  commandContext: CommandContext,
  shellPaths: Parameters<typeof writeOnboardingCheckMarker>[0],
  render: () => void,
  markedDone: boolean,
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
    markDone: () => { writeOnboardingCheckMarker(shellPaths, { source: 'command' }); },
    isMarkedDone: () => markedDone,
  };
}
