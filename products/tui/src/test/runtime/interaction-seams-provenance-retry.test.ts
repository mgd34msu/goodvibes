/**
 * A provenance lookup that fails is not a record that is gone. The chip says
 * "no longer available" only for a record the spine answered null for, and a
 * failed lookup is asked again when the owner toggles the chip again.
 */
import { describe, expect, test } from 'bun:test';
import { createMemoryProvenanceUi } from '../../runtime/interaction-seams.ts';
import { linesToText } from '../setup.ts';

const CONFIG = { get: (key: string) => (key === 'memory.showProvenance' ? true : undefined) } as never;
const turn = (ids: string[]) => ({ type: 'TURN_COMPLETED', turnId: 't1', response: 'ok', stopReason: 'completed', metadata: { memory: { recordIds: ids } } }) as never;

function chipText(ui: ReturnType<typeof createMemoryProvenanceUi>): string {
  return linesToText(ui.renderChip(80, CONFIG)).join('\n');
}

describe('memory provenance chip', () => {
  test('a failed lookup is retried on the next toggle instead of reading "no longer available" for the session', async () => {
    let renderCount = 0;
    let waiting: { count: number; resolve: () => void } | null = null;
    const untilRenders = (count: number): Promise<void> =>
      renderCount >= count ? Promise.resolve() : new Promise((resolve) => { waiting = { count, resolve }; });
    let calls = 0;
    const ui = createMemoryProvenanceUi({
      render: () => {
        renderCount++;
        if (waiting && renderCount >= waiting.count) { const { resolve } = waiting; waiting = null; resolve(); }
      },
      memorySpine: {
        get: async () => {
          calls++;
          if (calls === 1) throw new Error('daemon blip');
          return { summary: 'first fact', cls: 'fact' };
        },
      },
    });
    ui.onTurnCompleted(turn(['mem-1']));

    ui.toggle(); // expand: one render for the toggle, one when the failed lookup settles
    await untilRenders(2);
    expect(calls).toBe(1);
    expect(chipText(ui)).not.toContain('no longer available');
    // The repaint after the failure did not ask again by itself.
    expect(calls).toBe(1);

    ui.toggle(); // collapse
    ui.toggle(); // expand again: asks again
    await untilRenders(5);
    expect(calls).toBe(2);
    expect(chipText(ui)).toContain('first fact');
  });
});
