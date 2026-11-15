/**
 * hosted-turn-visibility.test.ts
 *
 * Three reported symptoms, one cause. During a daemon-hosted turn the shell
 * went blind: no thinking spinner or waiting phrase, no output until the next
 * keystroke, no live streamed text.
 *
 * The cause was that every "a turn is in flight" signal reads the orchestrator's
 * `isThinking` and the animation frame beside it, and a LOCAL turn's 80ms
 * animation timer is what actually repaints the shell during a turn. Frame
 * arrival was never the pump. A hosted turn set none of it, so nothing painted
 * between keystrokes and the waiting state never appeared at all.
 *
 * These tests pin each symptom against the state the shell really renders from.
 */

import { describe, expect, test } from 'bun:test';
import {
  createHostedTurnActivity,
  type ThinkingUiState,
} from '../../shell/hosted-turn-activity.ts';
import { buildThrobberState, ThinkingStallClock } from '../../core/thinking-overlay.ts';
import { createHostedFrameRenderer } from '../../runtime/client/hosted-frame-render.ts';
import type { Orchestrator } from '@goodvibes-jev/engine/platform/platform/core';

/** The orchestrator fields the shell's turn indicator reads, and nothing else. */
function turnState(): ThinkingUiState {
  return { isThinking: false, thinkingFrame: 0, streamingInputTokens: 0, streamingOutputTokens: 0 };
}

/** The overlay's real dependency shape, over our state. */
function overlayOrchestrator(state: ThinkingUiState): Pick<
  Orchestrator, 'isTurnActive' | 'getSpinner' | 'thinkingFrame' | 'streamingInputTokens' | 'streamingOutputTokens'
> {
  return {
    // The orchestrator's own derivation: the indicator a hosted turn turns on occupies it.
    get isTurnActive() { return state.isThinking; },
    // The same derivation the orchestrator uses: the glyph follows the frame.
    getSpinner: () => ['|', '/', '-', '\\'][state.thinkingFrame % 4] as string,
    get thinkingFrame() { return state.thinkingFrame; },
    get streamingInputTokens() { return state.streamingInputTokens; },
    get streamingOutputTokens() { return state.streamingOutputTokens; },
  } as Pick<Orchestrator, 'isTurnActive' | 'getSpinner' | 'thinkingFrame' | 'streamingInputTokens' | 'streamingOutputTokens'>;
}

/**
 * The waiting state the throbber draws: the spinner and the phrase, as
 * text. [] when no turn is in flight.
 */
function overlayLines(state: ThinkingUiState): string[] {
  const throbber = buildThrobberState({
    orchestrator: overlayOrchestrator(state),
    configManager: { get: ((key: string) => (key === 'display.showTokenSpeed' ? true : key === 'display.showToolPreview')) as never },
    streamToolPreview: undefined,
    streamTokenSpeed: 0,
    approvalPending: false,
    width: 80,
    clock: new ThinkingStallClock(),
    pendingApproval: null,
    activeTool: null,
    compacting: false,
  });
  return throbber && throbber.activity.kind === 'model' ? [`${throbber.spinner} ${throbber.activity.phrase}`] : [];
}

/**
 * Replaces setInterval/clearInterval with a manual clock: `tick()` runs every live
 * interval callback once, so repaint cadence is asserted without waiting on real time.
 */
function manualIntervals(): { tick: () => void; live: () => number; restore: () => void } {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const callbacks = new Map<number, () => void>();
  let nextId = 1;
  globalThis.setInterval = ((fn: () => void) => {
    const id = nextId++;
    callbacks.set(id, fn);
    return id;
  }) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = ((id: number) => { callbacks.delete(id); }) as unknown as typeof globalThis.clearInterval;
  return {
    tick: () => { for (const fn of [...callbacks.values()]) fn(); },
    live: () => callbacks.size,
    restore: () => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; },
  };
}

describe('symptom 1: the waiting state exists during a hosted turn', () => {
  test('no waiting state before, a waiting state during, none after', () => {
    const state = turnState();
    const activity = createHostedTurnActivity({ turnState: state, requestRender: () => {} });

    expect(overlayLines(state)).toEqual([]);

    activity.begin();
    const during = overlayLines(state);
    expect(during.length).toBeGreaterThan(0);
    // The pre-existing presentation, unchanged: the shell's own waiting
    // fragment, built by the same function a local turn builds it with.
    expect(during.join(' ').trim().length).toBeGreaterThan(0);

    activity.end();
    expect(overlayLines(state)).toEqual([]);
    activity.dispose();
  });

  test('it drives the SAME state a local turn drives, so every consumer follows', () => {
    // The sidebar's busy lamp and the render loop's reserved overlay rows both
    // read this one field. Nothing had to learn that hosted turns exist.
    const state = turnState();
    const activity = createHostedTurnActivity({ turnState: state, requestRender: () => {} });
    activity.begin();
    expect(state.isThinking).toBe(true);
    activity.end();
    expect(state.isThinking).toBe(false);
    activity.dispose();
  });

  test('a local turn already in flight keeps ownership of the indicator', () => {
    const state = turnState();
    state.isThinking = true;
    const activity = createHostedTurnActivity({ turnState: state, requestRender: () => {} });
    activity.begin();
    expect(activity.isActive()).toBe(false);
    // Ending must not clear a waiting state this controller never set.
    activity.end();
    expect(state.isThinking).toBe(true);
    activity.dispose();
  });
});

describe('symptom 2: the shell repaints with no input events at all', () => {
  test('hosted turn activity schedules real repaints on the local cadence', () => {
    const clock = manualIntervals();
    try {
      let repaints = 0;
      const state = turnState();
      const activity = createHostedTurnActivity({
        turnState: state,
        requestRender: () => { repaints += 1; },
      });

      activity.begin();
      // The waiting state has to appear on the keystroke, not one interval later.
      expect(repaints).toBe(1);

      // Zero input events happen here, only timer ticks.
      for (let i = 0; i < 4; i += 1) clock.tick();
      activity.end();

      // THIS is the assertion the regression fails without the fix: nothing was
      // typed, and the shell repainted anyway.
      expect(repaints).toBeGreaterThan(3);
      // …and the animation actually advanced, so the spinner turns.
      expect(state.thinkingFrame).toBe(4);
      activity.dispose();
    } finally { clock.restore(); }
  });

  test('repainting stops when the turn ends: no timer outlives the turn', () => {
    const clock = manualIntervals();
    try {
      let repaints = 0;
      const state = turnState();
      const activity = createHostedTurnActivity({
        turnState: state,
        requestRender: () => { repaints += 1; },
      });
      activity.begin();
      clock.tick();
      activity.end();
      const settled = repaints;
      expect(clock.live()).toBe(0);
      clock.tick();
      expect(repaints).toBe(settled);
      activity.dispose();
    } finally { clock.restore(); }
  });

});

describe('symptom 3: streamed text is visible as deltas arrive', () => {
  test('each delta updates the streaming block before the turn completes', () => {
    const updates: string[] = [];
    let repaints = 0;
    const conversation = {
      addAssistantMessage: () => {},
      addToolResults: () => {},
      addSystemMessage: () => {},
      startStreamingBlock: () => {},
      updateStreamingBlock: (content: string) => { updates.push(content); },
      finalizeStreamingBlock: () => {},
    };
    const renderer = createHostedFrameRenderer(conversation as never, () => { repaints += 1; });

    renderer.apply({ type: 'STREAM_START', payload: { turnId: 't1' } });
    renderer.apply({ type: 'STREAM_DELTA', payload: { turnId: 't1', content: 'The ', accumulated: 'The ' } });
    // Visible NOW, not only once the turn completes.
    expect(updates).toEqual(['The ']);
    expect(repaints).toBeGreaterThan(0);

    renderer.apply({ type: 'STREAM_DELTA', payload: { turnId: 't1', content: 'answer', accumulated: 'The answer' } });
    expect(updates).toEqual(['The ', 'The answer']);
    expect(renderer.isTurnFinished()).toBe(false);
  });

  test('the running tool is reported, so the status area is not empty during hosted tool calls', () => {
    // A hosted turn making thirty tool calls reported "No runtime activity":
    // the shell's tool preview and sidebar read a LOCAL session snapshot, and
    // the tools were executing in the daemon's process.
    const state = turnState();
    const activity = createHostedTurnActivity({ turnState: state, requestRender: () => {} });
    activity.begin();
    expect(activity.toolPreview()).toBeUndefined();
    activity.noteTool('read_file');
    expect(activity.toolPreview()).toBe('read_file');
    activity.noteTool(null);
    expect(activity.toolPreview()).toBeUndefined();
    // It never outlives the turn.
    activity.noteTool('write_file');
    activity.end();
    expect(activity.toolPreview()).toBeUndefined();
    activity.dispose();
  });

  test('real token counts appear once the daemon reports them, and are never invented', () => {
    const state = turnState();
    const activity = createHostedTurnActivity({ turnState: state, requestRender: () => {} });
    activity.begin();
    // Before any usage frame there is no honest number to show.
    expect(state.streamingOutputTokens).toBe(0);
    activity.noteUsage(1200, 64);
    expect(state.streamingInputTokens).toBe(1200);
    expect(state.streamingOutputTokens).toBe(64);
    activity.end();
    activity.dispose();
  });
});
