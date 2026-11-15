// ---------------------------------------------------------------------------
// recovery-modals-golden.test.ts, golden frames for the two startup recovery
// questions, rendered through the real SelectionModal +
// renderSelectionModalOverlay path at three terminal sizes.
//
// Frames are the modal surface kit's layer composed over a blank dimmed
// screen (frameFromLayer), exactly as the compositor stamps it.
//
// These exist because of a shipped defect: at 60x24 the "Remove recovery
// point?" question rendered ONLY its destructive row, preselected, with the
// other answer pushed off the box behind a "(1 below)" hint while ten
// terminal rows sat empty, a blind Enter deleted a conversation. The facts
// string below is the worst case that produced it (long title, 8-hex session
// id, 1.2 MB), built from a FIXED timestamp so the frames never drift with
// the clock.
//
// The byte-exact goldens are paired with behavioral assertions that read the
// rendered text back: a golden alone can bless a regression the next time
// someone regenerates it, so "every answer is on screen" and "the cursor sits
// on the harmless row" are also asserted directly.
//
// Update path: GOODVIBES_UPDATE_GOLDENS=1 bun test <this file>.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { SelectionModal } from '../../input/selection-modal.ts';
import { renderSelectionModalOverlay } from '../../renderer/selection-modal-overlay.ts';
import {
  RECOVERY_OFFER_TITLE,
  RECOVERY_RETIRE_TITLE,
  buildRecoveryOfferItems,
  buildRecoveryRetireItems,
  describeRecoverySnapshot,
} from '../../runtime/recovery-prompt.ts';
import type { SelectionItem } from '../../input/selection-modal.ts';
import type { RecoveryFileInfo } from '@/runtime/index.ts';
import type { Line } from '@goodvibes-jev/engine/platform/platform/types';
import { frameFromLayer } from '../helpers/surface-frame.ts';
import { assertGoldenIn } from '../helpers/golden-snapshot.ts';
import { activeTokens } from '../../renderer/theme.ts';

const GOLDENS_DIR = new URL('./golden-frames/', import.meta.url).pathname;

function assertGolden(surface: string, lines: Line[]): void {
  assertGoldenIn(GOLDENS_DIR, surface, lines);
}

// A fixed instant, not Date.now(): the rendered age ("3h ago") is a delta
// against this, so the frames are the same bytes on every run forever.
const FIXED_NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const SNAPSHOT: RecoveryFileInfo = {
  sessionId: 'a1b2c3d4',
  timestamp: FIXED_NOW - 3 * 3_600_000,
  title: 'Refactoring the transcript journal rebind path across sessions',
};
const FACTS = describeRecoverySnapshot(SNAPSHOT, { nowMs: FIXED_NOW, bytes: 1_234_567 });

interface RecoveryModalEntry {
  readonly name: string;
  readonly title: string;
  readonly items: () => SelectionItem[];
  /** Every answer the question offers. All of them must be on screen at once. */
  readonly choices: readonly string[];
  /** The row Enter lands on when the question opens. */
  readonly defaultChoice: string;
}

const RECOVERY_MODALS: readonly RecoveryModalEntry[] = [
  {
    name: 'recovery-offer-modal',
    title: RECOVERY_OFFER_TITLE,
    items: () => buildRecoveryOfferItems(FACTS),
    choices: ['Resume it', 'Not now'],
    defaultChoice: 'Resume it',
  },
  {
    name: 'recovery-retire-modal',
    title: RECOVERY_RETIRE_TITLE,
    items: () => buildRecoveryRetireItems(FACTS),
    choices: ['Keep it', 'Remove it'],
    defaultChoice: 'Keep it',
  },
];

const SIZES = [
  // 60x24 is the size the defect was reproduced at.
  { label: '60x24', width: 60, height: 24 },
  { label: '80x24', width: 80, height: 24 },
  { label: '140x38', width: 140, height: 38 },
] as const;

/** Render a question exactly as the recovery flow opens it. */
function renderRecoveryModal(entry: RecoveryModalEntry, width: number, height: number): Line[] {
  const modal = new SelectionModal();
  modal.open(entry.title, entry.items(), { allowSearch: false, primaryVerbLabel: 'Choose' });
  return frameFromLayer(renderSelectionModalOverlay(modal, width, height), width, height);
}

function rowsOf(lines: Line[]): string[] {
  return lines.map((line) => line.map((c) => (c.char === '' ? ' ' : c.char)).join(''));
}

/**
 * The row a choice's label sits on, or -1. The label starts its row, followed
 * by nothing or by its detail after two spaces; wrapped detail lines carry
 * sentences, never a bare label.
 */
function findChoiceRow(rows: readonly string[], label: string): number {
  return rows.findIndex((row) => {
    const text = row.trim();
    return text === label || text.startsWith(`${label}  `);
  });
}

/** True when the choice's row is the selected one: the gradient row's dark bold text. */
function isSelectedRow(lines: Line[], row: number, label: string): boolean {
  const text = lines[row]!.map((c) => (c.char === '' ? ' ' : c.char)).join('');
  const col = text.indexOf(label);
  const cell = lines[row]![col]!;
  return cell.fg === activeTokens().selectedListItemText && cell.bold;
}

for (const entry of RECOVERY_MODALS) {
  describe(`recovery modal golden: ${entry.name}`, () => {
    for (const size of SIZES) {
      const surfaceName = `${entry.name}-${size.label}`;

      test(`${size.label} matches committed golden`, () => {
        const lines = renderRecoveryModal(entry, size.width, size.height);
        expect(lines.length).toBeGreaterThan(0);
        assertGolden(surfaceName, lines);
      });

      test(`${size.label} shows every answer at once, with nothing scrolled away`, () => {
        const rows = rowsOf(renderRecoveryModal(entry, size.width, size.height));
        for (const choice of entry.choices) {
          // Thrown rather than expect()ed so the failure carries the frame
          // that lost the answer, which is the whole diagnosis.
          if (findChoiceRow(rows, choice) < 0) {
            throw new Error(`"${choice}" is not on screen at ${size.label}:\n${rows.join('\n')}`);
          }
        }
        // No answer may be hidden behind a scroll hint: these questions are
        // short enough to fit whole at every size a terminal realistically is.
        expect(rows.join('\n')).not.toMatch(/\d+ more [↑↓]/);
        // And the box must stay inside the terminal it is drawn over.
        expect(rows.length).toBeLessThanOrEqual(size.height);
      });

      test(`${size.label} opens with the cursor on "${entry.defaultChoice}"`, () => {
        const lines = renderRecoveryModal(entry, size.width, size.height);
        const rows = rowsOf(lines);
        const defaultRow = findChoiceRow(rows, entry.defaultChoice);
        expect(defaultRow).toBeGreaterThanOrEqual(0);
        expect(isSelectedRow(lines, defaultRow, entry.defaultChoice)).toBe(true);
        for (const other of entry.choices.filter((c) => c !== entry.defaultChoice)) {
          expect(isSelectedRow(lines, findChoiceRow(rows, other), other)).toBe(false);
        }
      });
    }
  });
}
