import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInvocationAdmitted, withExecutionMode } from '../sdk/src/platform/gate/execution-context.ts';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateReadingsPort } from './_helpers/gate-readings.ts';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { OwnerProfileStore } from '../sdk/src/platform/owner-profile/store.ts';
import { bindProfileMutationOptionsToInvocation, captureProfileDelegation, readProfileAdmittedInvocation } from '../sdk/src/platform/owner-profile/delegation.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { registerOwnerProfileGatewayMethods } from '../sdk/src/platform/control-plane/routes/owner-profile.ts';
import { evaluatePaymentTaint, type PaymentIntent } from '../sdk/src/platform/payments/taint-gate.ts';
import { evaluateProfileRemoval, evaluateProfileWrite } from '../sdk/src/platform/owner-profile/trust.ts';
import { evaluateOutwardEffect, UntrustedContentLedger } from '../sdk/src/platform/security/untrusted-content.ts';
import { useSecurityReadings } from './helpers/security-readings.ts';

const readings = useSecurityReadings({ derives: () => false });
const ownerIntent: PaymentIntent = { origin: 'owner', merchantDiscovered: true,
  merchant: 'shop.example', checkoutUrl: undefined, item: 'A requested book', requestedMax: 'Twenty dollars' };
const ingest = (ledger: UntrustedContentLedger, content?: string) => ledger.record({
  surface: 'web-page', origin: 'https://source.example', at: '2026-11-04T00:00:00Z', ...(content === undefined ? {} : { content }),
});
const write = (ledger: UntrustedContentLedger) => evaluateProfileWrite({ authority: 'owner-direct', value: 'A personally supplied fact', said: 'A personally supplied fact', ledger });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function profileFixture(ledger: UntrustedContentLedger) {
  const root = mkdtempSync(join(tmpdir(), 'gv-taint-admission-')); roots.push(root);
  const path = join(root, 'profile.md');
  const initial = '## Contact\n\nemail: owner@example.invalid\n';
  writeFileSync(path, initial);
  return { path, initial, store: new OwnerProfileStore({ path, ledger }) };
}

describe('shared taint coverage consumers', () => {
  test('payment cannot clear missing source text by comparing a different retained source', async () => {
    const ledger = new UntrustedContentLedger();
    ingest(ledger);
    ingest(ledger, 'A complete unrelated source');
    expect((await evaluatePaymentTaint({ intent: ownerIntent, ledger })).allowed).toBe(false);
    expect(readings.requests).toHaveLength(0);
  });

  test('payment cannot clear a truncated source or one evicted during the current turn', async () => {
    for (const loss of ['truncated', 'evicted'] as const) {
      const ledger = new UntrustedContentLedger();
      ingest(ledger, loss === 'truncated' ? 'a'.repeat(20_001) : 'The original source');
      if (loss === 'evicted') for (let i = 0; i < 1_000; i++) ingest(ledger, `Complete later source ${i}`);
      expect((await evaluatePaymentTaint({ intent: ownerIntent, ledger })).allowed).toBe(false);
    }
    expect(readings.requests).toHaveLength(0);
  });

  test('profile cannot clear incomplete evidence by crossing one owner turn boundary', async () => {
    const ledger = new UntrustedContentLedger();
    ingest(ledger);
    ledger.startTurn();
    expect((await write(ledger)).allowed).toBe(false);
    expect(readings.requests).toHaveLength(0);
  });

  test('historical retained text is checked exactly without becoming a semantic comparison window', async () => {
    const ledger = new UntrustedContentLedger();
    ingest(ledger, 'An unrelated historical page');
    ledger.startTurn();
    ledger.startTurn();
    expect((await write(ledger)).allowed).toBe(true);
    expect(readings.requests).toHaveLength(0);
  });

  test('profile cannot report clean exact evidence when retained source text was truncated', async () => {
    const ledger = new UntrustedContentLedger();
    ingest(ledger, 'a'.repeat(20_001));
    ledger.startTurn();
    ledger.startTurn();
    expect((await write(ledger)).allowed).toBe(false);
    expect(readings.requests).toHaveLength(0);
  });

  test('coverage reports eviction only within the selected source window', () => {
    const ledger = new UntrustedContentLedger();
    for (let i = 0; i < 1_000; i++) ingest(ledger, `Complete historical source ${i}`);
    ledger.startTurn();
    ingest(ledger, 'Complete current source');
    expect(ledger.captureTaintEvidence('turn')).toMatchObject({ complete: true, missing: false, truncated: false, evicted: false });
    expect(ledger.captureTaintEvidence('since-last-boundary')).toMatchObject({ complete: false, evicted: true });
    expect(ledger.captureTaintEvidence('retained')).toMatchObject({ complete: false, evicted: true });
    ledger.startTurn();
    expect(ledger.captureTaintEvidence('since-last-boundary')).toMatchObject({ complete: true, evicted: false });
  });

  test('missing evidence ages out of semantic windows while retained exact coverage remains explicit', () => {
    const ledger = new UntrustedContentLedger();
    ingest(ledger);
    ledger.startTurn();
    expect(ledger.captureTaintEvidence('turn')).toMatchObject({ complete: true, missing: false });
    expect(ledger.captureTaintEvidence('since-last-boundary')).toMatchObject({ complete: false, missing: true });
    ledger.startTurn();
    expect(ledger.captureTaintEvidence('since-last-boundary')).toMatchObject({ complete: true, missing: false });
    expect(ledger.captureTaintEvidence('retained')).toMatchObject({ complete: false, missing: true });
  });

  test('standalone profile refuses incomplete retained history without making historical semantic calls', async () => {
    const ledger = new UntrustedContentLedger();
    for (let i = 0; i < 1_001; i++) ingest(ledger, `Complete historical source ${i}`);
    ledger.startTurn();
    ledger.startTurn();
    expect((await write(ledger)).allowed).toBe(false);
    expect(readings.requests).toHaveLength(0);
  });

  test('YOLO execution does not erase payment or persistent-profile domain authority', async () => {
    const ledger = new UntrustedContentLedger();
    ingest(ledger);
    const run = async () => {
      expect((await evaluatePaymentTaint({ intent: { ...ownerIntent, origin: 'content' }, ledger })).allowed).toBe(false);
      expect((await evaluateProfileWrite({ authority: 'web-page', value: 'A value', said: '', ledger })).allowed).toBe(false);
      expect(evaluateProfileRemoval({ authority: 'web-page' }).allowed).toBe(false);
      expect((await evaluateProfileWrite({ authority: 'owner-direct', value: 'A supplied fact', said: '', ledger: new UntrustedContentLedger() })).allowed).toBe(false);
      expect((await evaluateOutwardEffect({ request: { toolName: 'email', action: 'send', description: 'send a message' }, ledger })).allowed).toBe(true);
    };
    await withExecutionMode('yolo', run);
    expect(readings.requests).toHaveLength(0);
  });

  test('an unrelated admitted tool cannot authorize other effects or modify the profile store', async () => {
    const ledger = new UntrustedContentLedger();
    ingest(ledger);
    const profile = profileFixture(ledger);
    await profile.store.load();
    const permissions: ReturnType<PermissionConfigReader['getSnapshot']>['permissions'] = {
      mode: 'safe-owner', tools: {}, backgroundAgents: 'inherit', engine: 'baseline', simulation: false,
      divergenceDashboard: false, commandParser: 'ast', divergenceThreshold: 0.05, maxDivergenceRecords: 500,
    };
    const config: PermissionConfigReader = {
      getAutonomousSnapshot: () => ({ permissions, autoApprove: false, directory: '/synthetic/taint' }),
      getSnapshot: () => ({ permissions }), isAutoApproveEnabled: () => false,
      getWorkingDirectory: () => '/synthetic/taint',
    };
    const gate = gateReadingsPort();
    const previous = installJudgmentPort(gate.port);
    try {
      const manager = new PermissionManager(undefined, config, new PolicyRuntimeState());
      const registry = new ToolRegistry(manager);
      let ran = false;
      registry.register({ definition: { name: 'write', description: 'Intercepted body for taint policy integration', parameters: { type: 'object' } },
        async execute(args, options) {
          ran = true;
          expect(isInvocationAdmitted('write', args)).toBe(true);
          const before = gate.requests.length;
          expect((await evaluatePaymentTaint({ intent: { ...ownerIntent, origin: 'content' }, ledger })).allowed).toBe(false);
          expect((await evaluateProfileWrite({ authority: 'web-page', value: 'A value', said: '', ledger })).allowed).toBe(false);
          expect(evaluateProfileRemoval({ authority: 'web-page' }).allowed).toBe(false);
          expect((await evaluateOutwardEffect({ request: { toolName: 'email', action: 'send', description: 'send a message' }, ledger })).allowed).toBe(false);
          expect((await profile.store.set({ authority: 'web-page', surface: 'agent', said: '', fieldId: 'contact.email', value: 'attacker@example.invalid' })).ok).toBe(false);
          const sourceOnly = captureProfileDelegation(args, options);
          expect((await profile.store.forget({ authority: 'autonomous', fieldId: 'contact.email' }, { delegation: sourceOnly })).ok).toBe(false);
          expect((await profile.store.set({ authority: 'autonomous', surface: 'agent', said: '', fieldId: 'contact.email', value: 'attacker@example.invalid' }, { delegation: sourceOnly })).ok).toBe(false);
          expect(readFileSync(profile.path, 'utf8')).toBe(profile.initial);
          expect(gate.requests).toHaveLength(before);
          return { success: true };
        },
      });
      const call = await registry.prepareCall('taint-consumer', 'write', {});
      const admission = await manager.admitAutonomous('taint-consumer-source', call.name, call.args, {
        sourceOf: () => ({ goal: 'Run the intercepted body', criteria: ['Run exactly once'] }),
        schemaRevision: call.schemaRevision, preparedCall: { registry, call },
      });
      expect(admission.result.approved).toBe(true);
      expect((await registry.executePrepared(call, admission)).success).toBe(true);
      expect(ran).toBe(true);
      expect(isInvocationAdmitted('write', call.args)).toBe(false);
      expect(readFileSync(profile.path, 'utf8')).toBe(profile.initial);
    } finally { installJudgmentPort(previous); }
  });

  test.each((['safe-owner', 'safe-jev', 'yolo'] as const).flatMap(mode =>
    (['exact', 'changed-payload', 'changed-target', 'replay', 'detached-forget', 'accessor-forget', 'tainted-value', 'tainted-section', 'missing-evidence', 'untrusted-authority'] as const)
      .map(variation => ({ mode, variation }))))('actual profile admission preserves domain checks and exact binding: $mode / $variation', async ({ mode, variation }) => {
    const ledger = new UntrustedContentLedger();
    if (variation === 'tainted-value') ingest(ledger, 'The attacker address is permitted@example.invalid');
    if (variation === 'tainted-section') ingest(ledger, 'CompromisedHeading');
    if (variation === 'missing-evidence') ingest(ledger);
    const refusedByDomain = variation === 'tainted-value' || variation === 'tainted-section' || variation === 'missing-evidence' || variation === 'untrusted-authority';
    const appending = variation === 'tainted-section';
    const profile = profileFixture(ledger);
    await profile.store.load();
    const other = profileFixture(ledger);
    await other.store.load();
    const permissions: ReturnType<PermissionConfigReader['getSnapshot']>['permissions'] = {
      mode, tools: {}, backgroundAgents: 'inherit', engine: 'baseline', simulation: false,
      divergenceDashboard: false, commandParser: 'ast', divergenceThreshold: 0.05, maxDivergenceRecords: 500,
    };
    const config: PermissionConfigReader = {
      getAutonomousSnapshot: () => ({ permissions, autoApprove: false, directory: '/synthetic/taint' }),
      getSnapshot: () => ({ permissions }), isAutoApproveEnabled: () => false, getWorkingDirectory: () => '/synthetic/taint',
    };
    const gate = gateReadingsPort();
    const log = new SqliteDecisionLog(':memory:');
    const autonomous = fakePort((_key, question) => choiceAnswer(question, 'act', 0.99));
    const previous = installJudgmentPort(withDecisionLog({ ...gate.port, ask(request) {
      return 'disposition' in request.questions ? autonomous.port.ask(request) : gate.port.ask(request);
    } }, log));
    const forgetting = variation === 'detached-forget' || variation === 'accessor-forget';
    let release: () => void = () => {};
    const publication = new Promise<void>(resolve => { release = resolve; });
    let detached: Promise<unknown> | undefined;
    let getterReads = 0;
    const set = profile.store.set.bind(profile.store);
    const intercepted = spyOn(profile.store, 'set').mockImplementation(async (input, options) => {
      if (variation === 'changed-payload') return set({ ...input, value: 'unadmitted@example.invalid' }, options);
      if (variation === 'changed-target') return other.store.set(input, options);
      const result = await set(input, options);
      if (variation === 'replay') {
        const before = readFileSync(profile.path, 'utf8');
        await expect(set(input, options)).rejects.toThrow('consumed profile mutation admission');
        expect(readFileSync(profile.path, 'utf8')).toBe(before);
      }
      return result;
    });
    const forget = profile.store.forget.bind(profile.store);
    const interceptedForget = spyOn(profile.store, 'forget').mockImplementation(async (input, options) => {
      if (variation === 'accessor-forget') {
        const changed = { ...input };
        Object.defineProperty(changed, 'fieldId', { get() { getterReads++; return 'contact.email'; }, enumerable: true });
        return forget(changed, options);
      }
      if (variation === 'detached-forget') {
        detached = forget(input, { admittedMutation: options?.admittedMutation }).catch((error: unknown) => error);
        return { ok: true, reason: null, changes: [], disclosure: 'Synthetic detached caller returned early.' };
      }
      return forget(input, options);
    });
    try {
      const catalog = new GatewayMethodCatalog();
      registerOwnerProfileGatewayMethods(catalog, profile.store, undefined, { target: {
        profilePath: profile.path, captureProfileRead: () => profile.store.captureRead(), assertOwnerCurrent() {},
      } });
      const manager = new PermissionManager(undefined, config, new PolicyRuntimeState());
      const registry = new ToolRegistry(manager);
      registry.register({ definition: { name: 'profile', description: 'Exact profile field update', parameters: { type: 'object' } },
        async execute(args, options) {
          const delegation = captureProfileDelegation(args, options);
          const identity = readProfileAdmittedInvocation(delegation);
          expect(Object.isFrozen(identity)).toBe(true);
          expect(() => Object.assign(identity ?? {}, { kind: 'native' })).toThrow();
          const invocation = { body: forgetting ? { fieldId: args.fieldId, section: args.section, text: args.text, authority: 'autonomous' }
            : appending ? { section: args.section, text: args.text, authority: 'autonomous', said: '', surface: 'agent' }
              : { fieldId: args.fieldId, value: args.value, authority: args.authority ?? 'autonomous', said: args.said ?? '', surface: 'agent' },
            context: { admin: true }, isAuthorized: () => true };
          bindProfileMutationOptionsToInvocation({ delegation, ...(variation === 'detached-forget' ? { withPublication: async operation => {
            await publication; return operation(() => {});
          } } : {}) }, invocation);
          const before = gate.requests.length;
          const result = await catalog.invoke(forgetting ? 'profile.forget' : appending ? 'profile.append' : 'profile.set', invocation);
          expect(result).toMatchObject({ ok: !refusedByDomain });
          if (variation === 'tainted-value' || variation === 'tainted-section') expect(gate.requests.length).toBeGreaterThan(before);
          else expect(gate.requests).toHaveLength(before);
          return { success: true };
        },
      });
      const args = variation === 'accessor-forget' ? { action: 'forget', section: 'Notes', text: 'A note' }
        : variation === 'detached-forget' ? { action: 'forget', fieldId: 'contact.email' }
          : appending ? { action: 'append', section: 'CompromisedHeading', text: 'A personally supplied clean note' }
            : { action: 'set', fieldId: 'contact.email', value: 'permitted@example.invalid',
              ...(variation === 'untrusted-authority' ? { authority: 'web-page', said: 'Imported from a page' } : {}) };
      const call = await registry.prepareCall('profile-call', 'profile', args);
      const admission = await manager.admitAutonomous('profile-source', call.name, call.args, {
        sourceOf: () => ({ goal: 'Update the requested profile field', criteria: ['Apply the exact value once'] }),
        schemaRevision: call.schemaRevision, preparedCall: { registry, call },
      });
      const changed = variation === 'changed-payload' || variation === 'changed-target' || variation === 'accessor-forget';
      if (changed) {
        if (variation === 'accessor-forget') await expect(registry.executePrepared(call, admission)).rejects.toMatchObject({ problem: 'unsupported-input' });
        else await expect(registry.executePrepared(call, admission)).rejects.toThrow('does not match the admitted effect');
        expect(readFileSync(profile.path, 'utf8')).toBe(profile.initial);
      } else {
        expect((await registry.executePrepared(call, admission)).success).toBe(true);
        if (variation === 'detached-forget') {
          expect(detached).toBeDefined();
          release();
          expect(await detached).toMatchObject({ ok: false, changes: [] });
          expect(readFileSync(profile.path, 'utf8')).toBe(profile.initial);
        } else if (refusedByDomain) expect(readFileSync(profile.path, 'utf8')).toBe(profile.initial);
        else expect(readFileSync(profile.path, 'utf8')).toContain('permitted@example.invalid');
      }
      expect(getterReads).toBe(0);
      expect(readFileSync(other.path, 'utf8')).toBe(other.initial);
    } finally { release(); await detached; interceptedForget.mockRestore(); intercepted.mockRestore(); installJudgmentPort(previous); log[Symbol.dispose](); }
  });
});
