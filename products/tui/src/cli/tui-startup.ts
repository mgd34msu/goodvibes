import { reportStartupFailure, applySeededCliPrompt, resumeSessionAndRender } from '@goodvibes/engine/terminal-shell/startup-lifecycle';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { SelectionItem } from '../input/selection-modal.ts';
import type { WorkspaceRegistrationManager } from '@goodvibes/engine/platform/platform/runtime/operations';
import { readOnboardingCheckMarker, writeOnboardingCheckMarker } from '../runtime/onboarding/index.ts';
import { FirstRunModal, installSplashAdditions, startFirstRun, type FirstRunDeps } from '@goodvibes/engine/terminal-shell/first-run';
import { requireSecretsManager, requireServiceRegistry, requireSubscriptionManager } from '../input/commands/runtime-services.ts';
import { scanThisComputerNow } from '../runtime/startup-provider-registration.ts';
import { readLastSessionPointer, type SessionSurface } from '@/runtime/index.ts';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { writeFatalLine } from '@goodvibes/engine/platform/platform/daemon';
import type { GoodVibesCliParseResult } from '@goodvibes/engine/terminal-shell';
import { openDeepLink, parseDeepLink } from '../input/commands/deep-link.ts';

export type TuiStartupShellPaths = Parameters<typeof readOnboardingCheckMarker>[0] & {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
};

export type FirstOpenTrustLevel = 'trusted' | 'restricted';

/**
 * decodeFirstOpenChoice, pure mapping from a chosen selection-item id (or
 * null on Escape/enter-through) to the trust decision. Kept pure so the
 * consequence-time trust prompt's semantics (raised by trustGatedAsk, wired
 * in main.ts's trustPromptRef.requestTrustDecision) are unit-testable
 * without a live modal. Escape/enter-through (id === null) is the safe
 * default: 'restricted'.
 */
export function decodeFirstOpenChoice(id: string | null): FirstOpenTrustLevel {
  return id === 'trusted' ? 'trusted' : 'restricted';
}

/**
 * Build the selection rows for the trust prompt. This used to also offer a
 * "register this directory?" half (a combined 2x2 when both were needed),
 * that half is gone: registration self-records (see
 * selfRecordWorkspaceRegistration below) rather than ever asking a question
 * about a registry the user hasn't met yet.
 */
export function buildFirstOpenItems(): { readonly title: string; readonly items: SelectionItem[] } {
  return {
    title: 'New workspace: choose a trust level',
    items: [
      { id: 'trusted', label: 'Trust this workspace', detail: 'Full capability: all tools may run', primaryAction: 'select' },
      {
        id: 'restricted',
        label: 'Keep restricted (read-only)',
        detail: 'Explore safely; writes and commands are denied until trusted',
        primaryAction: 'select',
      },
    ],
  };
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
}): Promise<void> | undefined {
  const { cli, input, commandRegistry, commandContext, shellPaths, surface, render } = options;
  const globalOnboardingMarker = readOnboardingCheckMarker(shellPaths, 'user');

  // Registration self-records on every launch of an already-trusted
  // workspace (fire-and-forget, never blocks or gates startup, never a
  // modal). A workspace that is undecided or restricted is never
  // self-registered here; for one that becomes trusted just now (via the
  // consequence-time trust prompt), main.ts's trustPromptRef wiring calls
  // this same helper right after the decision.
  if (commandContext.workspace?.workspaceTrustManager?.isTrusted()) {
    void selfRecordWorkspaceRegistration(commandContext.workspace.workspaceRegistrationManager);
  }

  // Seeded prompt is always applied synchronously, regardless of session branch.
  applySeededCliPrompt(cli, input);

  // What the empty conversation shows under the splash: the starting prompts, and first run's lines.
  installSplashAdditions({
    workingDirectory: shellPaths.workingDirectory,
    configManager: commandContext.platform.configManager,
    setupCommand: '/setup',
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
  // provider, sign in, and land in the conversation (first-run-flow.ts).
  // Trust stays undecided here on purpose: the first non-read tool request is
  // what raises the trust question (main.ts's trustPromptRef).
  const runFirstRunSteps = (): void => {
    void startFirstRun(firstRunDeps(commandContext, shellPaths, render, globalOnboardingMarker.payload !== null, () => { input.conversationManager?.invalidateRenderedLines(); })).catch((error: unknown) => {
      logger.warn('First run could not start', { error: summarizeError(error) });
    });
  };
  // `/setup` → Run first-run again: the three steps, whether or not a model is ready.
  commandContext.openFirstRun = () => {
    const deps = firstRunDeps(commandContext, shellPaths, render, true, () => { input.conversationManager?.invalidateRenderedLines(); });
    if (!deps.pushSurfaceModal) return;
    const modal = new FirstRunModal(deps);
    deps.pushSurfaceModal(modal);
    void modal.load().catch((error: unknown) => {
      logger.warn('First run could not start', { error: summarizeError(error) });
    });
  };
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
  } else if (cli.command === 'sessions' && cli.commandArgs[0] === 'resume') {
    const target = cli.commandArgs.slice(1).join(' ').trim();
    if (target) {
      return resumeSessionAndRender(commandRegistry, target, commandContext, render);
    }
  } else if (cli.flags.continueLast) {
    // --continue: resume the last session tracked by the pointer file. A crash
    // snapshot newer than its saved copy is offered by the resume routine, as
    // for every other way of opening a session.
    const lastId = readLastSessionPointer({ surface });
    if (lastId) {
      return resumeSessionAndRender(commandRegistry, lastId, commandContext, render);
    }
    nothingToContinue();
  } else if (cli.flags.resume !== undefined) {
    // --resume [id]: explicit id dispatches directly; bare form (sentinel 'latest') resolves via pointer
    if (cli.flags.resume !== 'latest') {
      return resumeSessionAndRender(commandRegistry, cli.flags.resume, commandContext, render);
    } else {
      const lastId = readLastSessionPointer({ surface });
      if (lastId) {
        return resumeSessionAndRender(commandRegistry, lastId, commandContext, render);
      }
      nothingToContinue();
    }
  } else if (cli.flags.fork !== undefined) {
    // --fork [id]: fork specific session (true = bare fork-current; string = explicit id to resume then fork)
    if (cli.flags.fork === true) {
      // Bare --fork: fork the current session without a prior resume
      return commandRegistry.execute('session', ['fork'], commandContext).then(() => render());
    } else {
      // Explicit id: resume the named session first, then fork
      return commandRegistry
        .execute('session', ['resume', cli.flags.fork], commandContext)
        .then(() => commandRegistry.execute('session', ['fork'], commandContext))
        .then(() => render());
    }
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
