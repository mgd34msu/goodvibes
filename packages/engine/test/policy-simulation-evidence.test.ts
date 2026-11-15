/**
 * What a policy candidate is simulated against, and how divergences are counted.
 */
import { describe, expect, test } from 'bun:test';
import { useGateReadings } from './_helpers/gate-readings.ts';
import {
  buildDefaultPolicySimulationScenarios,
  createPermissionSimulator,
  runPolicySimulationScenarios,
} from '../platform/src/platform/runtime/permissions/index.ts';
import type { PolicyRule } from '../platform/src/platform/runtime/permissions/types.ts';

useGateReadings();

const denyProjectWrites: PolicyRule = {
  id: 'deny-project-writes',
  type: 'path-scope',
  origin: 'user',
  effect: 'deny',
  toolPattern: 'write',
  pathPatterns: ['/home/dev/project/**'],
};

describe('simulation evidence for a candidate', () => {
  test('a candidate that denies writes under the real project diverges on the scenarios', async () => {
    const simulator = createPermissionSimulator(
      { mode: 'default', projectRoot: '/home/dev/project', rules: [], defaultEffect: 'allow' },
      { mode: 'default', projectRoot: '/home/dev/project', rules: [denyProjectWrites], defaultEffect: 'allow' },
      'simulation-only',
    );
    // Called as the policy command calls it: with the canned set, not one built from the candidate.
    const summary = await runPolicySimulationScenarios(simulator, buildDefaultPolicySimulationScenarios());
    const diverged = summary.results.filter((result) => result.diverged).map((result) => result.scenario.id);
    expect(diverged.some((id) => id.startsWith('rule-deny-project-writes'))).toBe(true);
  });

  test('a rule about a relative path is probed under the project root', () => {
    const rule: PolicyRule = { ...denyProjectWrites, pathPatterns: ['secrets'] };
    const scenarios = buildDefaultPolicySimulationScenarios({ projectRoot: '/home/dev/project', rules: [rule] });
    const probe = scenarios.find((scenario) => scenario.id.startsWith('rule-deny-project-writes'));
    expect(probe?.args['path']).toBe('/home/dev/project/secrets/probe.txt');
  });
});

describe('a candidate that revises the current bundle', () => {
  const currentRules: PolicyRule[] = Array.from({ length: 8 }, (_, index) => ({
    id: `current-${index}`, type: 'path-scope', origin: 'user', effect: 'allow', toolPattern: 'write', pathPatterns: [`/home/dev/project/dir-${index}/**`],
  }));
  const denyOwn: PolicyRule = { ...denyProjectWrites, id: 'deny-new', pathPatterns: ['/home/dev/project/new-area/**'] };

  test('the new rule is probed even when the candidate repeats every current rule', async () => {
    const simulator = createPermissionSimulator(
      { mode: 'default', projectRoot: '/home/dev/project', rules: currentRules, defaultEffect: 'allow' },
      { mode: 'default', projectRoot: '/home/dev/project', rules: [...currentRules, denyOwn], defaultEffect: 'allow' },
      'simulation-only',
    );
    const summary = await runPolicySimulationScenarios(simulator, buildDefaultPolicySimulationScenarios());
    const diverged = summary.results.filter((result) => result.diverged).map((result) => result.scenario.id);
    expect(diverged.some((id) => id.startsWith('rule-deny-new'))).toBe(true);
  });

  test('a target named by both the current and the candidate rules is probed once', () => {
    const scenarios = buildDefaultPolicySimulationScenarios({ projectRoot: '/home/dev/project', rules: [...currentRules, ...currentRules, denyOwn] });
    expect(scenarios.filter((scenario) => scenario.id.startsWith('rule-current-0-'))).toHaveLength(1);
    expect(scenarios.filter((scenario) => scenario.id.startsWith('rule-current-')).length).toBe(8);
  });
});

describe('divergence counting', () => {
  test('the divergence rate keeps counting after the record list is full', async () => {
    const simulator = createPermissionSimulator(
      { mode: 'default', projectRoot: '/p', rules: [], defaultEffect: 'allow' },
      { mode: 'default', projectRoot: '/p', rules: [{ ...denyProjectWrites, pathPatterns: ['/p/**'] }], defaultEffect: 'allow' },
      'simulation-only',
      { maxDivergenceRecords: 2 },
    );
    for (let index = 0; index < 5; index++) {
      await simulator.evaluateAsync('write', { path: `/p/file-${index}.txt`, content: 'x' }, 'write');
    }
    const report = simulator.getDivergenceReport();
    expect(report.records).toHaveLength(2);
    expect(report.overall.total).toBe(5);
    expect(report.overall.divergenceRate).toBe(1);
  });
});
