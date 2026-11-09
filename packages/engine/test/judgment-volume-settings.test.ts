/** Product settings/runtime lifecycle regressions; execution deferred. */
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureJudgmentVolumeMonitorControl } from '../sdk/src/platform/observe/judgment-volume-monitor.ts';
import { composeJudgmentVolumeMonitor } from '../sdk/src/platform/runtime/judgment-volume-monitor.ts';
import { createDisposalScope } from '../sdk/src/platform/runtime/disposal.ts';
import { judgmentConfigSettings } from '../sdk/src/platform/config/schema-domain-judgment.ts';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { logger } from '../sdk/src/platform/utils/logger.ts';

const budget = { name: 'All decisions', maxLogicalDecisions: 100, maxWireAttempts: 200 };
test('Judgment settings expose owner call-volume budgets and refuse enabled empty budgets', () => {
  const field = judgmentConfigSettings.find(field => field.key === 'judgment.volumeMonitor');
  expect(field?.type).toBe('object'); expect(field?.default).toMatchObject({ enabled: false, budgets: [] });
  expect(captureJudgmentVolumeMonitorControl({ enabled: true, budgets: [budget] })).toMatchObject({ enabled: true, intervalMs: 60_000, windowMs: 3_600_000 });
  expect(() => captureJudgmentVolumeMonitorControl({ enabled: true })).toThrow();
  expect(() => captureJudgmentVolumeMonitorControl({ enabled: true, budgets: [{ ...budget, maxLogicalDecisions: -1 }] })).toThrow();
});

test('actual settings composition starts, hot-reloads and stops one owned monitor without model requests', () => {
  const scope = createDisposalScope('volume settings fixture');
  let value: unknown = { enabled: false }, reads = 0, listener: (() => void) | undefined, retired = false;
  try {
    composeJudgmentVolumeMonitor({ query: () => { reads++; return []; } }, {}, scope.registry, {
      get: () => value, subscribe: (key, next) => { expect(key).toBe('judgment.volumeMonitor'); listener = next; return () => { retired = true; }; },
    });
    expect(reads).toBe(0);
    value = { enabled: true, budgets: [budget] }; listener!(); expect(reads).toBe(1);
    listener!(); expect(reads).toBe(1); // An unrelated setting changed.
    value = { enabled: true, budgets: [{ ...budget, maxLogicalDecisions: 20 }] }; listener!(); expect(reads).toBe(2);
    value = { enabled: false }; listener!(); expect(reads).toBe(2);
    scope.dispose(); expect(retired).toBe(true);
    value = { enabled: true, budgets: [budget] }; listener!(); expect(reads).toBe(2);
  } finally { scope.dispose(); }
});

test('the existing budget-file override remains usable while product monitoring is disabled', () => {
  const root = mkdtempSync(join(tmpdir(), 'judgment-volume-config-')), file = join(root, 'budgets.json');
  const scope = createDisposalScope('volume file fixture'); let reads = 0;
  try {
    writeFileSync(file, JSON.stringify({ budgets: [budget] }));
    composeJudgmentVolumeMonitor({ query: () => { reads++; return []; } }, { GOODVIBES_JUDGMENT_MONITOR: file }, scope.registry, { get: () => ({ enabled: false }) });
    expect(reads).toBe(1);
  } finally { scope.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('invalid monitor settings produce a value-free warning and never start a log scan', () => {
  const scope = createDisposalScope('volume invalid fixture'), warn = spyOn(logger, 'warn').mockImplementation(() => {}); let reads = 0;
  try {
    composeJudgmentVolumeMonitor({ query: () => { reads++; return []; } }, {}, scope.registry,
      { get: () => ({ enabled: true, budgets: [], extra: 'Synthetic private value' }) });
    expect(reads).toBe(0); expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Synthetic private value');
  } finally { scope.dispose(); warn.mockRestore(); }
});


test('the actual ConfigManager post-publication subscription applies the just-saved monitor value and saved readback', () => {
  const root = mkdtempSync(join(tmpdir(), 'judgment-volume-native-config-'));
  const config = new ConfigManager({ surfaceRoot: 'tui', configDir: root, workingDir: root, homeDir: root });
  const scope = createDisposalScope('volume native settings'); let reads = 0;
  try {
    composeJudgmentVolumeMonitor({ query: () => { reads++; return []; } }, {}, scope.registry, config);
    expect(reads).toBe(0);
    const enabled = { enabled: true, budgets: [budget], intervalMs: 2000, windowMs: 60_000, limit: 25 };
    config.setDynamic('judgment.volumeMonitor', enabled);
    expect(reads).toBe(1);
    expect(config.get('judgment.volumeMonitor')).toEqual(enabled);
    const reopened = new ConfigManager({ surfaceRoot: 'tui', configDir: root, workingDir: root, homeDir: root });
    try { expect(reopened.get('judgment.volumeMonitor')).toEqual(enabled); }
    finally { reopened.stopWatchingConfigFiles(); }
    config.setDynamic('display.collapseThreshold', 35);
    expect(reads).toBe(1);
    config.setDynamic('judgment.volumeMonitor', { enabled: false });
    expect(reads).toBe(1);
    scope.dispose();
    config.setDynamic('judgment.volumeMonitor', enabled);
    expect(reads).toBe(1);
  } finally { scope.dispose(); config.stopWatchingConfigFiles(); rmSync(root, { recursive: true, force: true }); }
});

test('a structural pre-mutation incarnation observer re-reads after publication and a disposed queued reload cannot start work', async () => {
  const scope = createDisposalScope('volume older observer');
  let value: unknown = { enabled: false }, reads = 0, listener: (() => void) | undefined;
  try {
    composeJudgmentVolumeMonitor({ query: () => { reads++; return []; } }, {}, scope.registry, {
      get: () => value, onDidChangeIncarnation: next => { listener = next; return () => {}; },
    });
    listener?.(); value = { enabled: true, budgets: [budget] };
    expect(reads).toBe(0);
    await Promise.resolve(); expect(reads).toBe(1);
    listener?.(); value = { enabled: false }; scope.dispose();
    await Promise.resolve(); expect(reads).toBe(1);
  } finally { scope.dispose(); }
});


test('disabled budgets stay bounded and only complete enabled controls can start a monitor', () => {
  expect(captureJudgmentVolumeMonitorControl({ enabled: false, budgets: [] }).enabled).toBe(false);
  expect(captureJudgmentVolumeMonitorControl({ enabled: true, budgets: Array.from({ length: 100 }, (_, index) => ({ ...budget, name: `Budget ${index}` })) }).budgets).toHaveLength(100);
  for (const value of [null, { enabled: true, budgets: [] }, { enabled: false, budgets: Array.from({ length: 101 }, () => budget) },
    { enabled: false, intervalMs: 0 }, { enabled: false, windowMs: Infinity }, { enabled: false, limit: 100_001 }]) {
    expect(() => captureJudgmentVolumeMonitorControl(value)).toThrow();
  }
});
