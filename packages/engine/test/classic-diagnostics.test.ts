import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { decisionModelPolicyState, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { readServiceLogPosture } from '../terminal-shell/src/service-posture.js';
import { readEditorMessage } from '../platform/src/platform/presentation/editor-message.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';
import { classifyFailure } from '../platform/src/platform/runtime/forensics/classifier.js';
import { ForensicsCollector } from '../platform/src/platform/runtime/forensics/collector.js';
import { ForensicsRegistry } from '../platform/src/platform/runtime/forensics/registry.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { emitTurnSubmitted, emitTurnError } from '../platform/src/platform/runtime/emitters/turn.js';
import { readSystemMessagePriority } from '../platform/src/platform/runtime/batteries/system-message-priority.js';
import { replyInstructsTyping } from '../platform/src/platform/runtime/batteries/setup-reply-command.js';
import { readSlowPhases } from '../platform/src/platform/runtime/forensics/slow-phases.js';
import { readUserErrorClass, describeUserError } from '../platform/src/platform/routing/user-error.js';
import { lintPolicyConfig } from '../platform/src/platform/runtime/permissions/lint.js';

function install(port: JudgmentPort) {
  const previous = installJudgmentPort(port); restore = () => { installJudgmentPort(previous); };
}

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

test('Classic service logs and editor presentation retain local output without acquiring a decision owner', async () => {
  const fake = fakePort(() => noulAnswer(0.99));
  const previous = installJudgmentPort(fake.port);
  restore = () => { installJudgmentPort(previous); };
  const root = makeProjectTempDir('classic-diagnostics');
  const path = join(root, 'service.log');
  writeFileSync(path, 'Ordinary service log line.\n');
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    let captures = 0;
    const result = await readServiceLogPosture(path, 4096, {}, () => { captures++; throw new Error('No decision owner should be acquired'); });
    expect(result).toMatchObject({ provenance: 'classic', exists: true, tail: 'Ordinary service log line.\n' });
    expect(captures).toBe(0);
    const presentation = await readEditorMessage({ message: 'Saved the file.', kind: 'note', mode: 'create' }, new AbortController().signal);
    expect(presentation).toEqual({ provenance: 'classic' });
  });
  expect(fake.requests).toHaveLength(0);
});

test('Classic failure handling and system notices use native evidence without borrowing a semantic port', async () => {
  let metadata = 0, requests = 0;
  const forbidden: JudgmentPort = { get model(): never { metadata++; throw new Error('Must not read model'); },
    async ask() { requests++; throw new Error('Must not ask'); } };
  install(forbidden);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const options = { get port(): never { metadata++; throw new Error('Must not acquire a semantic owner'); } };
    expect(await classifyFailure({ errorMessage: 'timeout according to untrusted wording' }, options)).toBe('unknown');
    expect(await classifyFailure({ errorMessage: 'anything', hasPermissionDenial: true }, options)).toBe('permission_denied');
    expect(await classifyFailure({ errorMessage: 'anything', stopReason: 'max_tokens' }, options)).toBe('max_tokens');
    expect(await readSystemMessagePriority('An unfamiliar system message', 'test.classic.priority')).toBe('high');
    const error = { status: 401, message: 'Expired session according to arbitrary wording' };
    const reading = await readUserErrorClass(error);
    expect(reading).toMatchObject({ kind: 'auth', operationProvenance: 'classic', semanticAssessment: 'not-evaluated' });
    expect(describeUserError(error, reading).message).toContain('credentials or sign-in session');
    expect(await readUserErrorClass(new Error('Context limit according to arbitrary wording'))).toMatchObject({ kind: 'generic' });
    await expect(replyInstructsTyping('Some setup prose', 'test.classic.setup')).rejects.toMatchObject({ code: 'decision-models-disabled' });
    await expect(readSlowPhases('turn', [{ phase: 'STREAM', startedAt: 0, durationMs: 1234, success: false }], 'test.classic.slow'))
      .rejects.toMatchObject({ code: 'decision-models-disabled' });
  });
  expect({ metadata, requests }).toEqual({ metadata: 0, requests: 0 });
});

test.each(['Classic - Off', 'Preferred'] as const)('%s failure reports retain native events and disclose missing semantic assessment', async policy => {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic exhausted chain'); }); install(fake.port);
  const bus = new RuntimeEventBus(), reports = new ForensicsRegistry();
  const collector = new ForensicsCollector(bus, reports);
  const ready = Promise.withResolvers<void>(), unsubscribe = reports.subscribe(ready.resolve);
  try {
    await withDecisionModelPolicy(() => policy, async () => {
      const context = { sessionId: 'classic-errors', source: 'fixture', traceId: 'classic-errors-trace' };
      emitTurnSubmitted(bus, context, { turnId: 'failed-turn', prompt: 'Original prompt stays in its conversation' });
      emitTurnError(bus, context, { turnId: 'failed-turn', error: 'An unstructured provider failure', stopReason: 'provider_error' });
      await ready.promise;
      expect(reports.latest()).toMatchObject({ turnId: 'failed-turn', classification: 'llm_error',
        errorMessage: 'An unstructured provider failure', operationProvenance: 'classic', slowPhaseAssessment: 'not-evaluated' });
      expect(reports.latest()?.causalChain.length).toBeGreaterThan(0);
    });
    expect(fake.requests.length).toBe(policy === 'Classic - Off' ? 0 : 1);
  } finally { unsubscribe(); collector.dispose(); }
});

test('Classic permission lint retains deterministic errors without pretending pattern breadth was assessed', async () => {
  const fake = fakePort(() => { throw new Error('Must not ask'); }); install(fake.port);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const findings = await lintPolicyConfig({ mode: 'custom', rules: [
      { id: 'duplicate', type: 'prefix', origin: 'user', effect: 'allow', toolPattern: '*' },
      { id: 'duplicate', type: 'path-scope', origin: 'user', effect: 'allow', toolPattern: ['write'], pathPatterns: ['/workspace/**'] },
      { id: 'network', type: 'network-scope', origin: 'managed', effect: 'deny', toolPattern: ['fetch'], hostPatterns: ['example.com'] },
    ] });
    expect(findings.some(finding => finding.severity === 'error' && finding.message.includes('Duplicate'))).toBe(true);
    expect(findings.some(finding => finding.severity === 'error' && finding.message.includes('every tool'))).toBe(true);
    expect(findings.filter(finding => finding.semanticAssessment === 'not-evaluated')).toHaveLength(2);
    expect(findings.some(finding => finding.message.includes('overly broad'))).toBe(false);
  });
  expect(fake.requests).toHaveLength(0);
});

test('Preferred user error presentation falls back once on exhaustion without interpreting later prose', async () => {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic exhausted chain'); }); install(fake.port);
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    expect(await readUserErrorClass(new Error('Unstructured error'))).toMatchObject({ kind: 'generic', operationProvenance: 'classic' });
    expect(decisionModelPolicyState().operation).toBe('classic');
    expect(await readSystemMessagePriority('An unfamiliar message', 'test.priority')).toBe('high');
  });
  expect(fake.requests).toHaveLength(1);
});
