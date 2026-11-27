/**
 * What the empty conversation shows under the splash, for this process: the
 * first-run lines (set, not ready, or nothing). One terminal app runs one main
 * conversation per process, so this is one record.
 *
 * The app installs it once at start (installSplashAdditions); first run sets
 * its outcome (setFirstRunScreen). splash-additions.ts draws it.
 */
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { createModeWordsSource, type ModeWordsSource } from '../session-permission-mode.js';

export type FirstRunScreen =
  /** First run is open (step 1 or 2): nothing is drawn under the splash yet. */
  | { readonly kind: 'pending' }
  /** First run finished in this process: "You're set." */
  | {
    readonly kind: 'set'; readonly model: string; readonly signIn: 'signed in' | 'no sign-in needed'; readonly steps?: number | undefined;
    /**
     * The model was taken without asking (a usable key in the environment, a
     * stored key or a sign-in): the one line that says so, drawn in place of
     * "You're set" ("Using Anthropic (claude-…) from ANTHROPIC_API_KEY; …").
     */
    readonly using?: string | undefined;
    /** The one line naming the mode in force and where "Who decides" is chosen (first run never asks it). */
    readonly decides?: string | undefined;
  }
  /** A first launch whose model was ready already: only the line naming the mode in force and where to change it. */
  | { readonly kind: 'decides'; readonly decides: string }
  /** Set up later: "Not set up yet." */
  | { readonly kind: 'not-ready' };

interface SplashAdditionsInstall {
  readonly configManager: Pick<ConfigManager, 'get' | 'subscribe'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>;
  /** Where setup is, as a person reaches it: the menu's System place, Setup tab (no command is typed for it). */
  readonly setupWhere: string;
  /** The splash is on screen now (first run's lines are drawn only with it). */
  readonly splashShowing: () => boolean;
  readonly renderRequest: () => void;
}

interface SplashAdditionsState extends SplashAdditionsInstall {
  /**
   * Where the control is that brings over settings another GoodVibes app on this computer already has, as a person
   * reaches it ("menu › System › Setup › Import settings"), said under the splash on the first launch only (the Agent,
   * when the terminal app has settings to bring over); absent otherwise.
   */
  importWhere: string | undefined;
  /** What Enter on the empty composer does while that line shows: runs the import (a one-key choice). */
  importRun: (() => void) | undefined;
  /**
   * The last frame drew that line (a short screen leaves it out, splash-additions.ts): an offer acts only while it is
   * shown, so Enter on an empty composer under a splash without it runs nothing.
   */
  importShown: boolean;
  firstRun: FirstRunScreen | undefined;
  words: ModeWordsSource | null;
  /** "You're set" was said on the status bar because its line did not fit. */
  setFlashed: boolean;
  /**
   * The crash-recovery offer's one line (session-crash-recovery.ts recoveryOfferLine), drawn under the splash while
   * the offer stands, so it is seen where the person is looking; absent when there is no offer.
   */
  recoveryLine: string | undefined;
}

let state: SplashAdditionsState | null = null;
/** A recovery line set before the additions were installed (the offer can come first). */
let pendingRecoveryLine: string | undefined;

/**
 * The lines a program says for the person as it starts (the daemon started or missing, the repair, the workspace,
 * what was restored), drawn under the splash while it shows and there is room, as the recovery line is; they are kept
 * in Notices (or the activity feed) as well. At most a few, in the order said, each once.
 */
const startLines: string[] = [];
const START_LINE_PREFIXES = ['[Startup]', '[Daemon]', '[Workspace]', '[Local] Restored', '[Recovery] Restored'];
const MOST_START_LINES = 4;

/** A line a program said: kept for the splash when it is one said at start and the conversation is still empty. */
export function noteSplashStartLine(message: string): void {
  if (!START_LINE_PREFIXES.some((prefix) => message.startsWith(prefix))) return;
  if (state && !state.splashShowing()) return;
  if (startLines.includes(message)) return;
  startLines.push(message);
  if (startLines.length > MOST_START_LINES) startLines.shift();
  if (state?.splashShowing()) requestSplashRender();
}

export function installSplashAdditions(install: SplashAdditionsInstall): void {
  state?.words?.stop();
  state = { ...install, importWhere: state?.importWhere, importRun: state?.importRun, importShown: false, firstRun: state?.firstRun, words: null, setFlashed: false,
    recoveryLine: state?.recoveryLine ?? pendingRecoveryLine };
}

/** Lines already said on the status bar because they did not fit under the splash (each said once). */
const flashedLines = new Set<string>();

/**
 * A line under the splash (the mode in force, the recovery offer) that did not fit: the line the status bar flashes
 * instead, once per line; null when it was flashed already.
 */
export function takeDroppedLineFlash(line: string): string | null {
  if (flashedLines.has(line)) return null;
  flashedLines.add(line);
  return line;
}

/** Show (or, with undefined, take away) the crash-recovery offer's one line under the splash. */
export function setSplashRecoveryLine(line: string | undefined): void {
  pendingRecoveryLine = line;
  if (!state || state.recoveryLine === line) return;
  state.recoveryLine = line;
  if (state.splashShowing()) requestSplashRender();
}

/**
 * Offer, under the splash, to bring over another app's settings (first launch
 * only; see importWhere): Enter on the empty composer runs `run`, which
 * imports at once and says what changed; where the control is is named beside it.
 */
export function setSplashImportWhere(where: string | undefined, run?: () => void): void {
  if (!state) return;
  state.importWhere = where;
  state.importRun = where ? run : undefined;
  if (state.splashShowing()) requestSplashRender();
}

/**
 * Enter on an empty composer while the import offer shows under the splash:
 * the offer is taken (it is made once) and its run returned; undefined otherwise.
 */
export function takeSplashEnterAction(): (() => void) | undefined {
  if (!state?.importRun || !state.importWhere || !state.importShown || state.firstRun?.kind === 'pending' || !state.splashShowing()) return undefined;
  const run = state.importRun;
  state.importRun = undefined;
  state.importWhere = undefined;
  state.importShown = false;
  return run;
}

/** Whether the frame just drawn showed the import offer's line (splash-additions.ts); Enter takes it only then. */
export function noteSplashImportShown(shown: boolean): void {
  if (state) state.importShown = shown;
}

export function setFirstRunScreen(screen: FirstRunScreen | undefined): void {
  if (!state) return;
  state.firstRun = screen;
  if (screen?.kind === 'set' && !state.words) {
    // The asks sentence follows the mode in force; recomputed only when it changes.
    state.words = createModeWordsSource(state.configManager, state.renderRequest);
  }
}

export interface SplashAdditionsView {
  readonly firstRun: FirstRunScreen | undefined;
  readonly asksBefore: string | undefined;
  /** Where setup is, as a person reaches it ("menu › System › Setup"). */
  readonly setupWhere: string;
  /** Where the import control is, as a person reaches it ("menu › System › Setup › Import settings"). */
  readonly importWhere: string | undefined;
  /** Enter on the empty composer takes the import offer. */
  readonly importOnEnter: boolean;
  /** The crash-recovery offer's one line, while the offer stands. */
  readonly recoveryLine: string | undefined;
  /** The lines said at start (noteSplashStartLine), oldest first. */
  readonly startLines: readonly string[];
}

/** What to draw under the splash now; null when nothing is installed. */
export function readSplashAdditions(): SplashAdditionsView | null {
  if (!state) return null;
  const firstRun = state.firstRun;
  return {
    firstRun,
    asksBefore: firstRun?.kind === 'set' ? state.words?.current().asksBefore : undefined,
    setupWhere: state.setupWhere,
    importWhere: state.importWhere,
    importOnEnter: state.importRun !== undefined,
    recoveryLine: state.recoveryLine,
    startLines: [...startLines],
  };
}

/**
 * The "You're set" line did not fit under the splash: the line the status bar
 * flashes instead, once per first run (null after that, or when there is none).
 */
export function takeSetFlash(): string | null {
  if (!state || state.setFlashed || state.firstRun?.kind !== 'set') return null;
  state.setFlashed = true;
  return state.firstRun.using ?? `You're set: answering with ${state.firstRun.model}`;
}

/** Ask for a frame (after the one being drawn). */
export function requestSplashRender(): void {
  const render = state?.renderRequest;
  if (render) queueMicrotask(render);
}

/**
 * First run owns the screen: its steps are open, or the conversation still
 * shows its step-3 lines under the splash. Notices wait while it does
 * (composeConversationLayers' screenOwned), as they do over a modal.
 */
export function firstRunOwnsScreen(): boolean {
  const kind = state?.firstRun?.kind;
  if (kind === 'pending') return true;
  return (kind === 'set' || kind === 'decides' || kind === 'not-ready') && state!.splashShowing();
}

/** First run is open (step 1 or 2): a model chosen meanwhile is said by first run, not by a line in the conversation. */
export function firstRunOpen(): boolean {
  return state?.firstRun?.kind === 'pending';
}
