// `/policy`, hoisted from goodvibes-tui src/input/commands/policy.ts and
// policy-dispatch.ts. The record-trend tests are ported from goodvibes-tui
// src/test/input/policy-record-trend-command.test.ts (`/policy record-trend`
// is a thin wrapper over PolicyRuntimeState.recordTrendEntry(), which forwards
// to the attached DivergencePanel, so the verb is honest about needing an
// active simulation dashboard). The rest pin the narrow context the TUI now
// hands the engine: the panel opener, the working-directory getter the
// simulation reads, and the config and MCP getters the preflight reads.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useGateReadings } from './_helpers/gate-readings.ts';
import type { GoodVibesConfig } from '../platform/src/platform/config/schema-types.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { runPolicyCommand, type PolicyFrontDoorContext } from '../platform/src/platform/gate/policy/policy-command.ts';
import type { PolicyMcpServerSecurity } from '../platform/src/platform/gate/policy/policy-dispatch.ts';
import { PolicyRegistry, createUnsignedBundle } from '../platform/src/platform/runtime/permissions/index.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort } from '@goodvibes-jev/judgment/testing';

/** Writes a bundle file the way an export holds it and returns its directory. */
function writeBundleFile(name: string, bundleId: string, ruleCount: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'policy-bundle-'));
  const rules = Array.from({ length: ruleCount }, (_, index) => (
    { type: 'prefix', id: `${bundleId}-rule-${index}`, origin: 'user', effect: 'deny', toolPattern: 'exec' }
  ));
  writeFileSync(join(dir, name), JSON.stringify({ bundleId, issuedAt: '2026-01-01T00:00:00.000Z', payload: { version: 1, rules } }));
  return dir;
}

const unused = (): never => { throw new Error('not used by this verb'); };

function makeContext(out: string[], policyRuntimeState: PolicyRuntimeState, over: Partial<PolicyFrontDoorContext> = {}): PolicyFrontDoorContext {
  return {
    policyRuntimeState,
    print: (text: string) => { out.push(text); },
    workingDirectory: unused,
    config: unused,
    listMcpServerSecurity: unused,
    ...over,
  };
}

describe('/policy status with a configured bundle that failed to load', () => {
  test('says why the bundle is not enforced, in the output and the snapshot', async () => {
    const out: string[] = [];
    const state = new PolicyRuntimeState();
    state.recordConfiguredBundleFailure('/etc/policy.json: signature does not verify');
    await runPolicyCommand(['status'], makeContext(out, state));
    const printed = out.join('\n');
    expect(printed).toContain('/etc/policy.json: signature does not verify');
    expect(printed).toContain('not enforced');
    expect(state.getSnapshot().configuredBundleFailure).toBe('/etc/policy.json: signature does not verify');
    state.recordConfiguredBundleFailure(null);
    expect(state.getSnapshot().configuredBundleFailure).toBeNull();
  });
});

describe('/policy record-trend', () => {
  test('reports honestly when no simulation dashboard is active (no silent no-op)', async () => {
    const out: string[] = [];
    // A fresh PolicyRuntimeState has no dashboard attached.
    await runPolicyCommand(['record-trend'], makeContext(out, new PolicyRuntimeState()));
    const printed = out.join('\n');
    expect(printed).toContain('No active simulation dashboard');
    expect(printed).toContain('/policy simulate');
  });

  test("'trend' alias resolves to the same handler", async () => {
    const out: string[] = [];
    await runPolicyCommand(['trend'], makeContext(out, new PolicyRuntimeState()));
    expect(out.join('\n')).toContain('No active simulation dashboard');
  });
});

describe('/policy front door and dispatch', () => {
  // /policy simulate reads each sample scenario through the gate's batteries.
  useGateReadings();
  test('no arguments opens the panel when the surface has one, and prints usage when it does not', async () => {
    let opened = 0;
    const out: string[] = [];
    await runPolicyCommand([], makeContext(out, new PolicyRuntimeState(), { openPolicyPanel: () => { opened += 1; } }));
    expect(opened).toBe(1);
    expect(out).toEqual([]);

    await runPolicyCommand([], makeContext(out, new PolicyRuntimeState()));
    expect(out.join('\n')).toContain('Usage: /policy <subcommand>');
  });

  test('a verb that needs policy state says so when the runtime has none', async () => {
    const out: string[] = [];
    const ctx: PolicyFrontDoorContext = { print: (text) => { out.push(text); }, workingDirectory: unused, config: unused, listMcpServerSecurity: unused };
    await expect(runPolicyCommand(['status'], ctx)).rejects.toThrow('Policy runtime state is not available in this runtime.');
  });

  test('load, then simulate against the working directory and the owner\'s threshold, then report status', async () => {
    const state = new PolicyRuntimeState();
    const out: string[] = [];
    let rootsAsked = 0;
    const dir = writeBundleFile('bundle-a.json', 'bundle-a', 2);
    const config = { permissions: { divergenceThreshold: 0.2 } } as unknown as GoodVibesConfig;
    const ctx = makeContext(out, state, {
      workingDirectory: () => { rootsAsked += 1; return dir; },
      config: () => config,
    });

    await runPolicyCommand(['load', 'bundle-a.json'], ctx);
    expect(rootsAsked).toBe(1);
    expect(out.join('\n')).toContain('[policy] Candidate loaded: bundle-a');
    expect(out.join('\n')).toContain('[2 rules, loaded]');

    await runPolicyCommand(['simulate', 'silent'], ctx);
    expect(rootsAsked).toBe(2);
    expect(out.join('\n')).toContain('[policy] Simulation started in "simulation-only" mode.');
    expect(state.getDashboard()?.checkEnforceGate().threshold).toBe(0.2);

    await runPolicyCommand(['status'], ctx);
    expect(out.join('\n')).toContain('[policy] Candidate: bundle-a');
    expect(out.join('\n')).toContain('[policy] Divergence gate:');
  });

  test('simulation keeps no more divergence records than permissions.maxDivergenceRecords', async () => {
    const recordsHeld = async (maxDivergenceRecords: number): Promise<number> => {
      const state = new PolicyRuntimeState();
      const out: string[] = [];
      const dir = writeBundleFile('deny-exec.json', 'deny-exec', 1);
      const config = { permissions: { divergenceThreshold: 0.2, maxDivergenceRecords } } as unknown as GoodVibesConfig;
      const ctx = makeContext(out, state, { workingDirectory: () => dir, config: () => config });
      await runPolicyCommand(['load', 'deny-exec.json'], ctx);
      await runPolicyCommand(['simulate', 'silent'], ctx);
      return state.getDashboard()?.getSnapshot().report.records.length ?? -1;
    };
    const unbounded = await recordsHeld(500);
    expect(unbounded).toBeGreaterThan(1);
    expect(await recordsHeld(1)).toBe(1);
  });

  test('load takes the rules from the named file and never invents any', async () => {
    const state = new PolicyRuntimeState();
    const out: string[] = [];
    const dir = writeBundleFile('exported.json', 'acme', 3);
    const ctx = makeContext(out, state, { workingDirectory: () => dir });
    await runPolicyCommand(['load', 'exported.json'], ctx);
    expect(state.getRegistry().getCandidate()?.rules.map((rule) => rule.id)).toEqual(['acme-rule-0', 'acme-rule-1', 'acme-rule-2']);
    expect(state.getRegistry().getCandidate()?.rules.every((rule) => rule.effect === 'deny')).toBe(true);
  });

  test('a load that cannot read a bundle says so and leaves the existing candidate in place', async () => {
    const state = new PolicyRuntimeState();
    const out: string[] = [];
    const dir = writeBundleFile('good.json', 'good', 1);
    writeFileSync(join(dir, 'broken.json'), '{ "bundleId": "x", "payload": { "rules": "none" } }');
    const ctx = makeContext(out, state, { workingDirectory: () => dir });
    await runPolicyCommand(['load', 'good.json'], ctx);

    for (const args of [['load'], ['load', 'missing.json'], ['load', 'broken.json'], ['load', 'acme', '3']]) {
      out.length = 0;
      await runPolicyCommand(args, ctx);
      expect(out.join('\n')).toMatch(/Nothing was loaded|Load failed/);
      expect(state.getRegistry().getCandidate()?.bundle.bundleId).toBe('good');
    }
  });

  test('preflight reads the live config and the MCP servers through the getters', async () => {
    const out: string[] = [];
    const servers: PolicyMcpServerSecurity[] = [
      { name: 'deploy', trustMode: 'allow-all', role: 'ops', allowedPaths: [], allowedHosts: [] },
    ];
    const config = { permissions: { mode: 'allow-all', rules: [] } } as unknown as GoodVibesConfig;
    const state = new PolicyRuntimeState();
    await runPolicyCommand(['preflight'], makeContext(out, state, { config: () => config, listMcpServerSecurity: () => servers }));
    const printed = out.join('\n');
    expect(printed).toContain('[policy] Preflight review: BLOCK');
    expect(printed).toContain('deploy');
    expect(state.getSnapshot().lastPreflightReview?.status).toBe('block');
  });

  test('a candidate that diverges on every scenario is refused at promotion without --force', async () => {
    const state = new PolicyRuntimeState();
    const registry = new PolicyRegistry();
    registry.loadCandidate(createUnsignedBundle('deny-all', {
      version: 1,
      rules: [{ type: 'prefix', id: 'deny-all-rule', origin: 'user', effect: 'deny', toolPattern: '*' }],
    }));
    const out: string[] = [];
    const config = { permissions: { divergenceThreshold: 0.05 } } as unknown as GoodVibesConfig;
    const ctx = makeContext(out, state, { policyRegistry: registry, workingDirectory: () => '/work/project', config: () => config });

    await runPolicyCommand(['simulate'], ctx);
    expect(registry.getCandidate()?.gateResult?.status).toBe('blocked');

    await runPolicyCommand(['promote'], ctx);
    expect(out.join('\n')).toContain('[policy] Promotion blocked:');
    expect(registry.getCurrent()).toBeNull();
    expect(registry.getCandidate()?.state).toBe('promoting');

    // The blocked candidate can be simulated again, as the refusal suggests.
    await runPolicyCommand(['simulate'], ctx);
    expect(registry.getCandidate()?.state).toBe('promoting');
  });

  test('a simulation that fails returns the candidate to "loaded" so it can be simulated again', async () => {
    const state = new PolicyRuntimeState();
    const out: string[] = [];
    const config = { permissions: { divergenceThreshold: 0.2 } } as unknown as GoodVibesConfig;
    const dir = writeBundleFile('bundle-b.json', 'bundle-b', 1);
    const ctx = makeContext(out, state, { workingDirectory: () => dir, config: () => config });
    await runPolicyCommand(['load', 'bundle-b.json'], ctx);

    const previous = installJudgmentPort(fakePort(() => { throw new Error('model unavailable'); }).port);
    try {
      await runPolicyCommand(['simulate'], ctx);
    } finally {
      installJudgmentPort(previous);
    }
    expect(out.join('\n')).toContain('[policy] Simulation failed:');
    expect(state.getRegistry().getCandidate()?.state).toBe('loaded');

    await runPolicyCommand(['simulate'], ctx);
    expect(state.getRegistry().getCandidate()?.state).toBe('promoting');
  });
});
