/**
 * leader-key.ts, the leader sequence in both terminal programs.
 *
 * The leader is a binding in the key table (`leader`, Ctrl+G by default).
 * Pressing it arms the sequence and shows, at the bottom of the screen, every
 * key that can follow and what it does. The next key completes the sequence
 * (its action runs) or cancels it (Esc, or a key no sequence uses). There is
 * no time window: nothing waits on a clock. The input pipeline
 * (input-feed-pipeline.ts) owns the order; this file owns the state and the
 * strip that is drawn while it is armed.
 */
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { SurfaceModal, SurfaceModalHost } from './surface-modal-host.js';
import type { KeyCombo } from './keybindings.js';
import { layoutHintRows, SurfaceCanvas, type KitHint, type SurfaceLayer } from './renderer/surface-kit.js';
import { activeTokens } from './renderer/theme.js';

/** Keys other screens name, as the program binds them, set each frame: the model list's grouping, the memories chip. */
export { setModelPickerGroupKey } from './renderer/model-workspace-facts.js';
export { setMemoryProvenanceKey } from './renderer/composer-fragments.js';

/**
 * Whether the leader is read now: everywhere, over every screen, except a
 * modal choosing a key to keep (the Keys place reading the next key as
 * pressed). A screen with keys of its own after the leader (the terminal
 * app's config screens) is asked first when the next key comes (the
 * pipeline's `screenFollow`).
 */
export function leaderMayArm(modals: Pick<SurfaceModalHost, 'active' | 'kitModalOnTop' | 'top'> | undefined): boolean {
  if (!modals || !modals.active || !modals.kitModalOnTop) return true;
  const top = modals.top() as { readonly takesEveryKey?: boolean } | undefined;
  return top?.takesEveryKey !== true;
}

/** What the strip reads from the key table. */
export interface LeaderKeyTable {
  getComboLabel(action: string): string;
  getLeaderSequences(): ReadonlyArray<{ readonly action: string; readonly combo: KeyCombo; readonly description: string }>;
  formatFollowKey(combo: KeyCombo): string;
}

/** Short words for the strip, where an action's description is a sentence. */
const SHORT_WORDS: Readonly<Record<string, string>> = {
  'open-menu': 'menu',
  'workspace-picker': 'workspace',
  'workspace-close-all': 'close workspace',
  'clear-prompt': 'clear the prompt',
  'kill-line': 'cut to end of line',
  'word-back': 'word back',
  'word-forward': 'word forward',
  'kill-word-forward': 'cut next word',
  'yank': 'paste the cut text',
  'yank-pop': 'older cut text',
  'cancel-tool-call': 'stop the tool call',
  'toggle-keep-awake': 'keep awake',
  'toggle-memory-provenance': 'memories used',
  'voice-input': 'voice',
  'failure-other-model': 'another model',
  'failure-details': 'failure details',
  'failure-sign-in': 'sign in again',
  'failure-retry': 'send again',
  'open-fix-session': 'fix session',
  'copy-selection': 'copy selection',
  'redo': 'redo',
  'focus-work-tree': 'work tree',
  'next-session': 'next session',
  'previous-session': 'previous session',
  'contract-question-ordinary': 'not an answer',
  'model-picker-group': 'group models',
};

/** The words an action has on the strip. */
export function leaderWords(action: string, description: string): string {
  return SHORT_WORDS[action] ?? description.split(/[:(]/)[0]!.trim().toLowerCase();
}

/**
 * The keys that can follow the leader, as keycap hints, then how to cancel.
 * `screen`: the open screen's own keys after the leader (a settings screen's
 * action letters), listed first; a sequence of the table on one of those keys
 * is left out, since the screen takes that key.
 */
export function leaderHints(table: LeaderKeyTable, screen: readonly KitHint[] = []): KitHint[] {
  const taken = new Set(screen.map(([key]) => key));
  const hints: KitHint[] = [...screen];
  for (const { action, combo, description } of table.getLeaderSequences()) {
    const key = table.formatFollowKey(combo);
    if (!taken.has(key)) hints.push([key, leaderWords(action, description)]);
  }
  hints.push(['esc', 'cancel']);
  return hints;
}

/** The strip drawn while the leader is armed: what can follow, at the bottom of the screen, over nothing else. */
class LeaderStrip implements SurfaceModal {
  readonly name = 'leader-keys';
  constructor(private readonly table: LeaderKeyTable, private readonly screen: readonly KitHint[], private readonly closed: () => void) {}
  handleToken(_token: InputToken, _host: SurfaceModalHost): void { /* The pipeline gives the next key to the leader itself. */ }
  /** Closed from outside (the whole stack cleared): the sequence is over. */
  onClose(): void { this.closed(); }
  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    const t = activeTokens();
    const width = Math.max(10, screenWidth - 2);
    const lead = `${this.table.getComboLabel('leader').toLowerCase()} then`;
    const rows = layoutHintRows(leaderHints(this.table, this.screen), Math.max(10, width - 4 - lead.length - 2));
    const height = rows.length + 2;
    const canvas = new SurfaceCanvas(width, height);
    canvas.fill(0, 0, width, height, t.backgroundPanel);
    canvas.put(2, 1, lead, { fg: t.text, bold: true });
    const x0 = 2 + lead.length + 2;
    rows.forEach((row, index) => {
      let x = x0;
      row.forEach(([key, words], k) => {
        if (k > 0) x += 3;
        if (key) x = canvas.put(x, 1 + index, ` ${key} `, { fg: t.text, bg: t.border, bold: true });
        x = canvas.put(x + 1, 1 + index, words, { fg: t.textMuted });
      });
    });
    // Above the composer and the status row, which stay in sight.
    const y = Math.max(0, screenHeight - height - 4);
    return { x: 1, y, lines: canvas.lines, dim: false };
  }
}

/** The leader's state in one program: armed or not, and the strip while it is. */
export class LeaderKeyState {
  private strip: LeaderStrip | null = null;
  constructor(
    private readonly table: LeaderKeyTable,
    private readonly modals: () => Pick<SurfaceModalHost, 'push' | 'close'> | undefined,
  ) {}

  get armed(): boolean { return this.strip !== null; }

  /** Arm the sequence; `screen`: the open screen's own keys after the leader, shown first on the strip. */
  arm(screen: readonly KitHint[] = []): void {
    if (this.strip) return;
    const strip: LeaderStrip = new LeaderStrip(this.table, screen, () => { if (this.strip === strip) this.strip = null; });
    this.strip = strip;
    this.modals()?.push(strip);
  }

  /** The sequence ended: completed or cancelled. */
  disarm(): void {
    const strip = this.strip;
    this.strip = null;
    if (strip) this.modals()?.close(strip, 'done');
  }
}
