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
  | { readonly kind: 'set'; readonly model: string; readonly signIn: 'signed in' | 'no sign-in needed' }
  /** Set up later: "Not set up yet." */
  | { readonly kind: 'not-ready' };

interface SplashAdditionsInstall {
  readonly configManager: Pick<ConfigManager, 'get' | 'subscribe'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>;
  /** The command that opens setup ("/setup", or "/onboarding" where /setup is not registered). */
  readonly setupCommand: string;
  /** The splash is on screen now (first run's lines are drawn only with it). */
  readonly splashShowing: () => boolean;
  readonly renderRequest: () => void;
}

interface SplashAdditionsState extends SplashAdditionsInstall {
  firstRun: FirstRunScreen | undefined;
  words: ModeWordsSource | null;
  /** "You're set" was said on the status bar because its line did not fit. */
  setFlashed: boolean;
}

let state: SplashAdditionsState | null = null;

export function installSplashAdditions(install: SplashAdditionsInstall): void {
  state?.words?.stop();
  state = { ...install, firstRun: state?.firstRun, words: null, setFlashed: false };
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
  readonly setupCommand: string;
}

/** What to draw under the splash now; null when nothing is installed. */
export function readSplashAdditions(): SplashAdditionsView | null {
  if (!state) return null;
  const firstRun = state.firstRun;
  return {
    firstRun,
    asksBefore: firstRun?.kind === 'set' ? state.words?.current().asksBefore : undefined,
    setupCommand: state.setupCommand,
  };
}

/**
 * The "You're set" line did not fit under the splash: the line the status bar
 * flashes instead, once per first run (null after that, or when there is none).
 */
export function takeSetFlash(): string | null {
  if (!state || state.setFlashed || state.firstRun?.kind !== 'set') return null;
  state.setFlashed = true;
  return `You're set: answering with ${state.firstRun.model}`;
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
  return (kind === 'set' || kind === 'not-ready') && state!.splashShowing();
}

/** First run is open (step 1 or 2): a model chosen meanwhile is said by first run, not by a line in the conversation. */
export function firstRunOpen(): boolean {
  return state?.firstRun?.kind === 'pending';
}
