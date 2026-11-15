/**
 * Edge behaviour of session recovery, return-context loading, liveness markers
 * and checkpoint retention that the broader suites do not reach.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ageRecoverySnapshot, makeTestSurface } from './_helpers/session-surface.ts';
import {
  autoRestoreRecovery,
  getRecoveryFilePath,
  writeRecoveryFile,
} from '../platform/src/platform/runtime/session-persistence.ts';
import {
  formatReturnContextForDisplay,
  loadedReturnContext,
  maybeAssistReturnContextSummary,
  type SessionReturnContextSummary,
} from '../platform/src/platform/runtime/session-return-context.ts';
import {
  checkSessionLiveness,
  livenessMarkerPathFor,
  removeLivenessMarker,
  writeLivenessMarker,
} from '../platform/src/platform/runtime/session-liveness-marker.ts';
import { RetentionPolicy } from '../platform/src/platform/runtime/retention/index.ts';

const roots: string[] = [];
function tempRoot(): string {
  const base = join(tmpdir(), `gv-session-edges-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  roots.push(base);
  return base;
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    try { chmodSync(join(dir, 'home', '.goodvibes'), 0o755); } catch { /* not created */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('auto-restore retirement', () => {
  function restoreFixture() {
    const base = tempRoot();
    const workingDirectory = join(base, 'work'), homeDirectory = join(base, 'home');
    mkdirSync(workingDirectory, { recursive: true }); mkdirSync(homeDirectory, { recursive: true });
    const opts = { workingDirectory, homeDirectory };
    writeRecoveryFile({ messages: [{ role: 'user', content: 'keep me' }], timestamp: Date.now() }, 'eeee5555', 'Task', opts);
    const path = getRecoveryFilePath(homeDirectory, 'eeee5555');
    ageRecoverySnapshot(path);
    return { opts, path };
  }

  test('a restore that retires its snapshot says so', () => {
    const { opts, path } = restoreFixture();
    const result = autoRestoreRecovery(opts);
    expect(result?.retired).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test('a restore whose snapshot cannot be deleted still returns the conversation and reports it was not retired', () => {
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    const { opts, path } = restoreFixture();
    const dir = join(path, '..');
    chmodSync(dir, 0o555);
    try {
      const result = autoRestoreRecovery(opts);
      expect(result?.snapshot.messages[0]?.content).toBe('keep me');
      expect(result?.retired).toBe(false);
      expect(existsSync(path)).toBe(true);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

describe('return context loading', () => {
  test('a record with no lines array loads with empty lines and formats without throwing', () => {
    const loaded = loadedReturnContext({ activityLabel: 'x' });
    expect(loaded?.lines).toEqual([]);
    expect(formatReturnContextForDisplay(loaded)).toEqual([]);
  });
});

describe('assisted return-context summary', () => {
  const summary: SessionReturnContextSummary = {
    activityLabel: 'Editing', statusLabel: 'Idle', pendingApprovals: 0, toolCallCount: 1, toolResultCount: 1,
    assistantTurnCount: 1, userTurnCount: 1, lines: [],
  };
  const config = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] }) as never;
  const helper = (reply: string | null) => {
    const prompts: string[] = [];
    return { prompts, chat: async (_task: string, prompt: string) => { prompts.push(prompt); return reply; } };
  };

  test('only the assisted mode with the helper enabled asks the helper, and the answer is squeezed to one capped line', async () => {
    const on = helper(`  one\n\n   two ${'x'.repeat(400)}  `);
    const result = await maybeAssistReturnContextSummary(config({ 'behavior.returnContextMode': 'assisted', 'helper.enabled': true }), on as never, summary);
    expect(on.prompts).toHaveLength(1);
    expect(result.assistedNarrative?.startsWith('one two ')).toBe(true);
    expect(result.assistedNarrative!.length).toBeLessThanOrEqual(160);

    const off = helper('never used');
    for (const values of [{ 'behavior.returnContextMode': 'off', 'helper.enabled': true }, { 'behavior.returnContextMode': 'assisted', 'helper.enabled': false }]) {
      expect(await maybeAssistReturnContextSummary(config(values), off as never, summary)).toBe(summary);
    }
    expect(off.prompts).toHaveLength(0);
  });

  test('an empty helper answer leaves the summary unchanged', async () => {
    const result = await maybeAssistReturnContextSummary(config({ 'behavior.returnContextMode': 'assisted', 'helper.enabled': true }), helper('   ') as never, summary);
    expect(result).toBe(summary);
  });
});

describe('liveness marker ids', () => {
  test('an id that could name another place is refused, never written, and reads as not live', () => {
    const base = tempRoot();
    const surface = makeTestSurface(base);
    for (const id of ['../escape', 'a/b', 'a\\b', '..', '']) {
      expect(() => livenessMarkerPathFor(surface, id)).toThrow(/cannot be used/);
      writeLivenessMarker(surface, id);
      removeLivenessMarker(surface, id);
      expect(checkSessionLiveness(surface, id)).toEqual({ live: false, pid: null });
    }
    expect(existsSync(join(base, '.goodvibes', 'escape.json'))).toBe(false);
  });
});

describe('checkpoint retention with a file that is already gone', () => {
  test('a record whose file was removed externally is dropped from tracking and its bytes stop counting', async () => {
    const dir = tempRoot();
    const policy = new RetentionPolicy({ short: { maxAgeMs: 1, maxCount: 10, maxSizeBytes: 1_000_000 } }, () => 10_000);
    policy.register({ id: 'gone', createdAt: 0, sizeBytes: 500, retentionClass: 'short', path: join(dir, 'missing.ckpt') });
    expect(policy.needsPrune()).toBe(true);
    const result = await policy.prune();
    expect(result.failedIds).toEqual([]);
    expect(result.deletedIds).toEqual(['gone']);
    expect(result.reclaimedBytes).toBe(0);
    expect(policy.getRetainedCount().totalCount).toBe(0);
    expect(policy.needsPrune()).toBe(false);
  });
});
