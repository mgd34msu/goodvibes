import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeterministicReplayEngine } from '../platform/src/platform/core/deterministic-replay.ts';
import { handleReplayCommand } from '../platform/src/platform/core/replay-command-handler.ts';
import { handlePlanCommand } from '../platform/src/platform/core/plan-command-handler.ts';
import { AdaptivePlanner } from '../platform/src/platform/core/adaptive-planner.ts';

function loadedEngine(root: string): DeterministicReplayEngine {
  const engine = new DeterministicReplayEngine(root);
  engine.load('run-1', { capturedAt: 1, domains: [] }, []);
  return engine;
}

describe('/replay diff', () => {
  test('compares the loaded run with another recorded run from the ledger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-replay-diff-'));
    try {
      const at = (rev: number, eventName: string) => ({ rev, eventName, payload: {}, ts: rev }) as never;
      const runs: Record<string, never[]> = { a: [at(1, 'TURN_SUBMITTED'), at(2, 'TOOL_CALLED')], b: [at(1, 'TURN_SUBMITTED')] };
      const ledger = { readRunEntries: (id: string) => runs[id] ?? [], listRunIds: () => Object.keys(runs), readRunSnapshot: () => null };
      const deps = { replayEngine: new DeterministicReplayEngine(root) };
      expect((await handleReplayCommand(deps, 'load', ['a'], ledger)).ok).toBe(true);

      const compared = await handleReplayCommand(deps, 'diff', ['b'], ledger);
      expect(compared.ok).toBe(true);
      expect(deps.replayEngine.getSnapshot().diffSource).toBe('recorded-run');
      expect(deps.replayEngine.getSnapshot().mismatches.map(m => m.kind)).toEqual(['missing_event']);

      expect((await handleReplayCommand(deps, 'diff', ['b'])).ok).toBe(false);
      expect((await handleReplayCommand(deps, 'diff', ['missing'], ledger)).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('/replay export', () => {
  test('a path outside the project and temp roots is refused and reports ok:false', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-replay-export-'));
    try {
      const result = await handleReplayCommand({ replayEngine: loadedEngine(root) }, 'export', ['/etc/gv-replay-report.json']);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('no file was written');
      expect(existsSync('/etc/gv-replay-report.json')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a path inside the project root is written before ok:true is reported', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-replay-export-'));
    try {
      const result = await handleReplayCommand({ replayEngine: loadedEngine(root) }, 'export', ['report.json']);
      expect(result.ok).toBe(true);
      expect(existsSync(join(root, 'report.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('/plan override', () => {
  test('the strategy is accepted in any letter case', () => {
    const planner = new AdaptivePlanner();
    const result = handlePlanCommand({ adaptivePlanner: planner }, 'override', ['Single']);
    expect(result.ok).toBe(true);
    expect(planner.getOverride()).toBe('single');
  });

  test('/plan mode accepts a mixed-case value', () => {
    const planner = new AdaptivePlanner();
    const result = handlePlanCommand({ adaptivePlanner: planner }, 'mode', ['COHORT']);
    expect(result.ok).toBe(true);
    expect(planner.getMode()).toBe('cohort');
  });
});
