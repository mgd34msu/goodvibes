/**
 * session-permission-mode.ts, the status bar's mode segment in both terminal
 * programs: the words it shows, kept current, and what Shift+Tab does.
 *
 * The words are ModeInForceWords (permissions/decision-model-readiness.ts),
 * computed when a setting that decides the mode in force changes and when the
 * decision model fails or answers again, never per frame: a few settings
 * reads and one memory read per change, no request.
 *
 * Shift+Tab cycles this session's mode (a runtime override; the saved default
 * changes only in settings). It writes nothing into the conversation: the
 * mode segment shows the new words and flashes for 1.5 seconds (one timer per
 * change). A change that cannot be made (a managed lock on the setting, a
 * host that refuses it) is a notice.
 */
import { DECISION_MODEL_SET_KEYS, type ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { gatePresetLabel, nextPermissionMode, type PermissionModeValue } from '@goodvibes-jev/engine/platform/platform/gate/presets';
import { describeModeInForceWords, type ModeInForceWords } from '@goodvibes-jev/engine/platform/platform/permissions';
import { onDecisionModelEpisode } from '@goodvibes-jev/engine/platform/platform/runtime/decision-policy';

/** How long the mode segment flashes after a change. */
export const MODE_FLASH_MS = 1500;

type ModeSettings = Pick<ConfigManager, 'get' | 'subscribe'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>;

/** The mode segment's words, recomputed only when they can have changed. */
export interface ModeWordsSource {
  current(): ModeInForceWords;
  stop(): void;
}

export function createModeWordsSource(configManager: ModeSettings, onChange: () => void): ModeWordsSource {
  let words = describeModeInForceWords(configManager);
  const refresh = (): void => {
    words = describeModeInForceWords(configManager);
    onChange();
  };
  const unsubscribers = [
    configManager.subscribe('permissions.mode', refresh),
    configManager.subscribe('behavior.autoApprove', refresh),
    // The settings that decide whether a decision model is ready (DECISION_MODEL_READINESS_KEYS).
    ...DECISION_MODEL_SET_KEYS.map((key) => configManager.subscribe(key, refresh)),
    // A set model counts as working only while it answers: told once per failure episode.
    onDecisionModelEpisode(refresh),
  ];
  return {
    current: () => words,
    stop: () => { for (const unsubscribe of unsubscribers) unsubscribe(); },
  };
}

export type ModeFlashScheduler = (run: () => void, delayMs: number) => void;
const defaultScheduler: ModeFlashScheduler = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  // A pending flash end must never keep the process alive on exit.
  (timer as { unref?: (() => void) | undefined }).unref?.();
};

/** The mode segment's flash after a change. */
export class ModeFlash {
  private until = 0;
  /** Called when the flash ends (wired to the render request). */
  onChange: (() => void) | null = null;
  constructor(private readonly clock: () => number = Date.now, private readonly schedule: ModeFlashScheduler = defaultScheduler) { }
  start(): void {
    const until = this.clock() + MODE_FLASH_MS;
    this.until = until;
    this.schedule(() => {
      if (this.until === until) this.onChange?.();
    }, MODE_FLASH_MS);
  }
  active(): boolean {
    return this.clock() < this.until;
  }
}

/** Each runtime owns one flash. */
export function createModeFlashScope(): () => ModeFlash {
  let shared: ModeFlash | null = null;
  return () => shared ??= new ModeFlash();
}
export const getSharedModeFlash = createModeFlashScope();

export interface SessionModeCycleContext {
  readonly configManager: Pick<ConfigManager, 'get' | 'setRuntimeOverride'>;
  /** Asks before the mode with no approvals; absent: that mode is skipped. */
  readonly confirm?: ((options: { readonly title: string; readonly body: string; readonly confirmLabel: string; readonly tone: 'danger' }) => Promise<boolean>) | undefined;
  /**
   * Where the session's mode lives when it is not this process's settings (a
   * hosted session's host): its mode now, and the change sent to it. Absent:
   * read `permissions.mode` and set it as a runtime override.
   */
  readonly hosted?: {
    readonly current: () => PermissionModeValue | undefined;
    readonly apply: (mode: PermissionModeValue) => Promise<void>;
  } | null | undefined;
  readonly flash: ModeFlash;
  /** A change that could not be made: posted as a notice, never written into the conversation. */
  readonly refused: (message: string) => void;
  readonly requestRender: () => void;
}

/**
 * Cycle this session's permission mode (Shift+Tab). The change is a runtime
 * override: the gate, the plan-mode instruction and the status bar read it at
 * once, and it ends with the session. Entering the mode with no approvals
 * asks once (default No); declining it (or having no dialog to ask in) moves
 * on to the mode after it, so the key always comes round to the strictest
 * mode.
 */
export async function cycleSessionPermissionMode(context: SessionModeCycleContext): Promise<void> {
  const { configManager } = context;
  const hosted = context.hosted ?? null;
  const current = hosted ? hosted.current() : configManager.get('permissions.mode') as PermissionModeValue | undefined;
  let next = nextPermissionMode(current);
  if (next === 'yolo') {
    const confirmed = await context.confirm?.({
      title: `Switch this session to ${gatePresetLabel(next)}?`,
      body: 'Every tool call in this session runs without asking you, including commands, file changes and messages. The saved default is not changed; it ends with the session.',
      confirmLabel: `Use ${gatePresetLabel(next)}`,
      tone: 'danger',
    }) ?? false;
    if (!confirmed) next = nextPermissionMode(next);
  }
  // A managed lock on the setting makes the override throw, a host can refuse:
  // a notice, never a crash of the input loop.
  try {
    if (hosted) await hosted.apply(next);
    else configManager.setRuntimeOverride('permissions.mode', next);
  } catch (error) {
    context.refused(`The mode stays ${gatePresetLabel(current ?? 'ask-me')}: ${error instanceof Error ? error.message : String(error)}`);
    context.requestRender();
    return;
  }
  context.flash.start();
  context.requestRender();
}
