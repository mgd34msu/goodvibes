import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { completionEvidenceCommitment } from '../../sdk/src/platform/contract/completion-evidence-binding.js';
import { contractWorkReceipts, workReceiptIdentity } from '../../sdk/src/platform/contract/work-receipts.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentFileObservations } from '../../sdk/src/platform/contract/evidence.js';
import { finalAnswerEvidence, finalContentEvidence } from '../../sdk/src/platform/contract/final-answer-evidence.js';
import { commandObservation } from '../../sdk/src/platform/contract/command-observation.js';
import { makeContract, makeUnit } from './fixtures.js';


test('content review references previously checked read accounting while preserving all primary content, failures and scope comparisons', () => {
  const f = fixture();
  const reads = Array.from({ length: 500 }, (_, index) => ({ path: `src/file-${index}.ts`, returnedRanges: ['1-10'], returnedLines: 10 }));
  f.evidence.orchestration.units[0].readObservations = reads;
  f.evidence.orchestration.sourceReferenceComparisons = [{ missing: ['src/unread.ts:1-20'] }];
  const primary = finalAnswerEvidence(f.contract, f.evidence, {})!.evidence;
  const before = JSON.stringify(primary);
  const view = finalContentEvidence(primary);
  expect(view).toMatchObject({ commands: primary['commands'], currentArtifacts: primary['currentArtifacts'], gates: primary['gates'],
    orchestration: { sourceReferenceComparisons: [{ missing: ['src/unread.ts:1-20'] }], units: [{ readObservations: {
      representation: 'native-source-accounting-reference', checkedBy: 'u1.k1',
      source: { storage: 'native-contract-store', unitId: 'u1', field: 'readEvidence' },
    } }] } });
  expect(JSON.stringify(view).length).toBeLessThan(before.length / 2);
  expect(JSON.stringify(primary)).toBe(before);
  expect(finalContentEvidence({ orchestration: { units: [{ status: 'running', readObservations: reads }] } }))
    .toMatchObject({ orchestration: { units: [{ status: 'running', readObservations: reads }] } });
});
const fixtureRoots: string[] = [];
afterEach(() => { for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const contract = makeContract({ units: [makeUnit({ status: 'passed', answer: 'A historical draft with superseded progress.',
    checks: [{ id: 'u1.k1', at: 1, trigger: 'completion', result: 'pass', quality: {}, decisionIds: ['native-unit-check'],
      goal: { verdict: 'met', probabilityUnmet: 0.1, outcome: 'act' }, evidenceDigest: 'checked-evidence' }],
    readEvidence: [{ path: 'review.md', returnedRanges: ['1-1'], returnedLines: 1,
      contentKind: 'declared-reference', returnedContent: '1 | Ready.' }],
  })] });
  const root = mkdtempSync(join(tmpdir(), 'native-final-artifact-')); fixtureRoots.push(root);
  writeFileSync(join(root, 'review.md'), 'Ready.\n');
  const current = currentFileObservations(root, ['review.md'])[0];
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Missing native current-file fixture');
  const evidence = { orchestration: { currentFiles: [current], continuationEvidence: 'Initial work was unfinished.',
    units: [{ id: 'u1', status: 'passed', acceptedAnswer: contract.units[0]!.answer!,
      latestCheck: contract.units[0]!.checks[0]!, criteria: [{ text: 'The review is complete', verdict: 'met' }], readObservations: [] }] },
    diff: '-Initial limited draft\n+Ready.', hostOperations: [current],
    commands: [{ command: 'verify-archive', success: true, head: 'Integrity passed.' }], gates: [] };
  // Other metadata is detached, while real judgeEvidence preserves the native
  // current-file objects themselves. A JSON copy carries no native byte proof.
  const projected = JSON.parse(JSON.stringify(evidence));
  projected.orchestration.currentFiles = [current]; projected.hostOperations = [current];
  return { contract, evidence: projected, current, root };
}

test('content review receives only byte-matched current primary artifact text and actual native receipts', () => {
  const f = fixture(); const before = JSON.stringify(f.contract);
  const checks = [{ criterion: 'c1', servedBy: ['u1.c1'] }];
  const view = finalAnswerEvidence(f.contract, f.evidence, { reports: 'Superseded draft', checks })!;
  expect(view.artifacts).toMatchObject([{ path: 'review.md', observationId: expect.any(String), content: '1 | Ready.',
    sourceUnitId: 'u1', sourceCheckId: 'u1.k1', decisionIds: ['native-unit-check'] }]);
  expect(view.evidence).toMatchObject({ originalRequest: f.contract.ask, criteria: checks,
    commands: f.evidence.commands, gates: f.evidence.gates,
    orchestration: { units: [{ latestCheck: { id: 'u1.k1', result: 'pass', decisionIds: ['native-unit-check'] } }] } });
  expect(JSON.stringify(view)).not.toContain('A historical draft with superseded progress.');
  expect(JSON.stringify(view)).not.toContain('Initial work was unfinished.');
  expect(JSON.stringify(f.contract)).toBe(before);
  expect(f.evidence.diff).toContain('Initial limited draft');
  expect(view.evidence['fullSourceEvidence']).toMatchObject({ storage: 'native-contract-store', contractId: f.contract.id });
});

test('root projection retains actual scope calculations and repair-plan admissions rather than replacing them with acceptance labels', () => {
  const f = fixture();
  const sourceJsonReferenceComparisons = [{ source: 'native-host-interval-comparison', referencePath: 'input.json',
    referenceObservationId: 'bound-reference', groups: [{ referencedLines: 12, coveredReferencedLines: 11, missingReferencedLines: 1,
      missing: [{ path: 'source.ts', ranges: [[7, 7]] }] }] }];
  const repairPlanAdmissions = [{ id: 'repair-plan', decisionIds: ['native-repair-validation'] }];
  const native = { ...f.evidence, orchestration: { ...f.evidence.orchestration, sourceJsonReferenceComparisons, repairPlanAdmissions } };
  const result = finalAnswerEvidence(f.contract, native, {})!;
  expect(result.evidence['orchestration']).toMatchObject({ sourceJsonReferenceComparisons, repairPlanAdmissions });
  expect(JSON.stringify(result.evidence)).toContain('"missingReferencedLines":1');
  expect(result.evidence).not.toHaveProperty('passed');
});

test('substantive accepted research stays visible with its actual check while old delivery drafts remain bound in storage', () => {
  const f = fixture();
  const source = makeUnit({ id: 'source-review', role: 'research', status: 'passed', answer: 'The reconnect guard suppresses duplicate sockets; the loss of restoration controls is retained.',
    checks: f.contract.units[0]!.checks.map(check => ({ ...check, id: 'source-review.k1', decisionIds: ['native-source-check'] })),
    readEvidence: [{ path: 'src/reconnect.ts', returnedRanges: ['1-20'], returnedLines: 20, contentKind: 'cited-source' }] });
  f.contract.units.push(source);
  f.evidence.orchestration.units.push({ id: source.id, status: 'passed', acceptedAnswer: source.answer!,
    latestCheck: source.checks.at(-1), criteria: source.criteria, readObservations: source.readEvidence });
  const before = JSON.stringify(f.contract);
  const view = finalAnswerEvidence(f.contract, f.evidence, {})!;
  const units = (view.evidence['orchestration'] as { units: { id: string; acceptedAnswer?: string }[] }).units;
  expect(units.find(unit => unit.id === source.id)?.acceptedAnswer).toBe(source.answer);
  expect(units.find(unit => unit.id === 'u1')).not.toHaveProperty('acceptedAnswer');
  expect(JSON.stringify(f.contract)).toBe(before);
  source.status = 'running';
  expect((finalAnswerEvidence(f.contract, f.evidence, {})!.evidence['orchestration'] as { units: { id: string }[] }).units.find(unit => unit.id === source.id))
    .not.toHaveProperty('acceptedAnswer');
});

test('source references and retained research text require exact source equality without hashing bodies', () => {
  const f = fixture();
  const source = makeUnit({ id: 'research-source', role: 'research', status: 'passed', answer: 'Actual accepted research text.',
    checks: f.contract.units[0]!.checks.map(check => ({ ...check, id: 'research-source.k1', decisionIds: ['research-native-check'] })),
    readEvidence: [{ path: 'src/source.ts', returnedRanges: ['1-2'], returnedLines: 2, contentKind: 'cited-source' }] });
  f.contract.units.push(source);
  const supplied = { id: source.id, status: source.status, acceptedAnswer: source.answer, latestCheck: source.checks.at(-1), criteria: source.criteria, readObservations: source.readEvidence };
  f.evidence.orchestration.units.push(supplied);
  const hashes = spyOn(crypto, 'createHash'), stateHashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    const view = finalAnswerEvidence(f.contract, f.evidence, {})!;
    expect(JSON.stringify(view.evidence)).toContain(source.answer!);
    const receipts = contractWorkReceipts(f.contract, { readObservations: true });
    expect(receipts.units.find(unit => unit.id === source.id)?.acceptedAnswer).toBe(source.answer);
    expect(view.evidence['fullSourceEvidence']).toMatchObject({ storage: 'native-contract-store', contractId: f.contract.id });
    expect(hashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    expect(stateHashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    supplied.acceptedAnswer = 'Copied source label with different text.';
    const mismatched = finalAnswerEvidence(f.contract, f.evidence, {})!;
    const units = (mismatched.evidence['orchestration'] as { units: { id: string; acceptedAnswer?: string }[] }).units;
    expect(units.find(unit => unit.id === source.id)).not.toHaveProperty('acceptedAnswer');
  } finally { stateHashes.mockRestore(); hashes.mockRestore(); }
});

test('an omitted passed answer remains privately bound to saved repair identity without per-answer hashes', () => {
  const f = fixture(), old = f.contract.units[0]!.answer ?? '';
  const hashes = spyOn(crypto, 'createHash'), stateHashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    const first = contractWorkReceipts(f.contract, { readObservations: true });
    expect(first.units[0]).not.toHaveProperty('acceptedAnswer');
    expect(JSON.stringify(first)).not.toContain('exactAcceptedAnswers');
    const identity = workReceiptIdentity(first);
    expect(identity.exactAcceptedAnswers).toEqual([{ unitId: f.contract.units[0]!.id, answer: old }]);
    f.contract.units[0]!.answer = old + ' Actual changed accepted answer.';
    const next = contractWorkReceipts(f.contract, { readObservations: true });
    expect(next.units[0]).not.toHaveProperty('acceptedAnswer');
    expect(workReceiptIdentity(next)).not.toEqual(identity);
    // The earlier receipt still owns the earlier immutable string.
    expect(workReceiptIdentity(first)).toEqual(identity);
    expect(() => workReceiptIdentity(structuredClone(first))).toThrow('original native receipt');
    expect(hashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    expect(stateHashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { stateHashes.mockRestore(); hashes.mockRestore(); }
});

test('current execution citations and every failure keep full primary bodies while unrelated successful history retains exact native pointers', () => {
  const f = fixture();
  const capture = (callId: string, exitCode = 0) => {
    const command = `verify-${callId}`;
    return { agentId: 'actual-worker', turn: 1, callIndex: 0, callId, command, success: true,
      head: JSON.stringify({ cmd: command, exit_code: exitCode, success: exitCode === 0,
        stdout: `Actual result for ${callId}`, stderr: exitCode === 0 ? '' : 'Actual failure' }) };
  };
  const receipts = [capture('call-inactive'), capture('call-used'), capture('call-failed', 2),
    { ...capture('call-unknown'), head: 'Actual unstructured result; child exit status not supplied.' }, capture('call-prefix')];
  f.contract.units[0]!.commandEvidence = receipts;
  const observed = receipts.map(receipt => commandObservation(receipt));
  const unbound = commandObservation(capture('call-unbound'));
  f.evidence.commands = [...observed, unbound];
  const before = JSON.stringify(f.contract);
  const view = finalAnswerEvidence(f.contract, f.evidence, {}, [], 'The execution call-used. succeeded; call-prefix-other is a distinct identifier.')!;
  const commands = view.evidence['commands'] as Record<string, unknown>[];
  expect(commands[0]).toMatchObject({ callId: 'call-inactive', executionSucceeded: true, exitCode: 0,
    commandBytes: Buffer.byteLength(receipts[0]!.command), stdoutBytes: Buffer.byteLength('Actual result for call-inactive'),
    bodySource: { storage: 'native-contract-store', contractId: f.contract.id, unitId: 'u1', field: 'commandEvidence', index: 0 } });
  expect(commands[0]).not.toHaveProperty('command');
  expect(commands[0]).not.toHaveProperty('head');
  expect(commands[0]).not.toHaveProperty('commandDigest');
  expect(commands[0]).not.toHaveProperty('stdoutDigest');
  expect(commands.slice(1, 4)).toEqual(observed.slice(1, 4));
  expect(commands[4]).toHaveProperty('observationKind', 'retained-command-receipt-index');
  expect(commands[5]).toEqual(unbound);
  // A reused execution ID is insufficient: every field must match the real
  // retained observation, including additional attribution and returned text.
  for (const altered of [
    { ...observed[0], head: 'Different successful output' },
    { ...observed[0], agentId: 'another-worker' },
    { ...observed[0], extra: 'Unretained source metadata' },
  ]) {
    f.evidence.commands = [altered];
    expect(finalAnswerEvidence(f.contract, f.evidence, {}, [], 'The report is ready.')!.evidence['commands']).toEqual([altered]);
  }
  f.evidence.commands = [...observed, unbound];
  expect(JSON.stringify(f.contract)).toBe(before);
  expect(view.evidence['fullSourceEvidence']).toMatchObject({ storage: 'native-contract-store', contractId: f.contract.id });
  f.contract.units[0]!.readEvidence = [{ ...f.contract.units[0]!.readEvidence![0]!, returnedContent: '1 | call-inactive.' }];
  writeFileSync(join(f.root, 'review.md'), 'call-inactive.\n');
  f.evidence.orchestration.currentFiles = currentFileObservations(f.root, ['review.md']);
  const artifactView = finalAnswerEvidence(f.contract, f.evidence, {}, [], 'Read the report.')!;
  expect((artifactView.evidence['commands'] as unknown[])[0]).toEqual(observed[0]);
});

test('native read tables preserve every original field, range and unit attribution while avoiding repeated column names', () => {
  const f = fixture();
  const reads = Array.from({ length: 200 }, (_, index) => ({ path: `src/file-${index}.ts`, returnedRanges: ['1-4', '8-12'], returnedLines: 9,
    ...(index === 0 ? { contentKind: 'declared-reference', bodySource: { storage: 'native-contract-store', field: 'readEvidence', index },
      returnedContentBytes: 85, validatedByCheckId: 'u1.k1', decisionIds: ['native-unit-check'], extra: null } : {}) }));
  f.evidence.orchestration.units[0].readObservations = reads;
  const before = JSON.stringify(f.evidence);
  const view = finalAnswerEvidence(f.contract, f.evidence, {})!;
  const unit = (view.evidence['orchestration'] as { units: { id: string; readObservations: {
    columns: string[]; rows: [string, string[], number, Record<string, unknown>?][];
  }; latestCheck: { id: string; decisionIds: string[] } }[] }).units[0]!;
  expect(unit.id).toBe('u1');
  expect(unit.readObservations.columns).toEqual(['path', 'returnedRanges', 'returnedLines', 'additionalFields']);
  const restored = unit.readObservations.rows.map(([path, returnedRanges, returnedLines, additionalFields]) => {
    const { nativeCheckRef, ...fields } = additionalFields ?? {};
    return { path, returnedRanges, returnedLines, ...fields, ...(nativeCheckRef === 'latestCheck'
      ? { validatedByCheckId: unit.latestCheck.id, decisionIds: unit.latestCheck.decisionIds } : {}) };
  });
  expect(restored).toEqual(reads);
  expect(JSON.stringify(unit.readObservations).length).toBeLessThan(JSON.stringify(reads).length);
  expect(JSON.stringify(f.evidence)).toBe(before);
  expect(view.evidence['fullSourceEvidence']).toMatchObject({ storage: 'native-contract-store', contractId: f.contract.id });
});

test('read validation references preserve mismatched and unaccepted check identities inline', () => {
  for (const mismatch of [
    { validatedByCheckId: 'other-check', decisionIds: ['native-unit-check'] },
    { validatedByCheckId: 'u1.k1', decisionIds: ['different-native-decision'] },
    { validatedByCheckId: 'u1.k1', decisionIds: [] },
    { validatedByCheckId: 'u1.k1', decisionIds: ['native-unit-check'], nativeCheckRef: 'untrusted-existing-reference' },
  ]) {
    const f = fixture();
    const observation = { path: 'src/a.ts', returnedRanges: ['1-2'], returnedLines: 2, ...mismatch };
    f.evidence.orchestration.units[0].readObservations = [observation];
    const view = finalAnswerEvidence(f.contract, f.evidence, {})!;
    expect((view.evidence['orchestration'] as { units: { readObservations: unknown[] }[] }).units[0]!.readObservations).toEqual([observation]);
  }
});

test('root criterion references resolve to complete identical unit criteria and preserve conflicting or extended values inline', () => {
  const f = fixture();
  const criterion = { id: 'u1.c1', text: 'Inspect all required source and return the reviewed artifact.', verdict: 'met' };
  f.evidence.orchestration.units[0].criteria = [criterion];
  const conflicting = { ...criterion, verdict: 'unmet' }, extended = { ...criterion, note: 'Additional evidence must not disappear.' };
  const checks = [{ criterion: 'original-c1', servedBy: [criterion, conflicting, extended] }];
  const view = finalAnswerEvidence(f.contract, f.evidence, { checks })!;
  expect(view.evidence['criteria']).toEqual([{ criterion: 'original-c1', servedBy: [{ criterionRef: 'u1.c1' }, conflicting, extended] }]);
  expect(view.evidence['orchestration']).toMatchObject({ units: [{ criteria: [criterion] }] });
  f.evidence.orchestration.units.push({ ...f.evidence.orchestration.units[0], id: 'duplicate-conflicting-unit', criteria: [conflicting] });
  expect(finalAnswerEvidence(f.contract, f.evidence, { checks })!.evidence['criteria']).toEqual(checks);
});

test('stale reads and unaccepted observations never replace full original evidence', () => {
  const f = fixture();
  f.evidence.orchestration.currentFiles[0] = { ...f.current, observationId: 'copied-stale-observation' };
  expect(finalAnswerEvidence(f.contract, f.evidence, {})).toBeUndefined();
  f.evidence.orchestration.currentFiles[0] = f.current;
  f.contract.units[0]!.checks[0] = { ...f.contract.units[0]!.checks[0]!, decisionIds: [] };
  expect(finalAnswerEvidence(f.contract, f.evidence, {})).toBeUndefined();
});

test('an unrepresented textual change keeps the full evidence path; binary identity is not semantic approval', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'unknown.txt'), 'Unrepresented text');
  f.evidence.orchestration.currentFiles.push(currentFileObservations(f.root, ['unknown.txt'])[0]);
  expect(finalAnswerEvidence(f.contract, f.evidence, {})).toBeUndefined();
  writeFileSync(join(f.root, 'unknown.txt'), Buffer.from([0, 1, 2]));
  f.evidence.orchestration.currentFiles[1] = currentFileObservations(f.root, ['unknown.txt'])[0];
  expect(finalAnswerEvidence(f.contract, f.evidence, {})?.artifacts).toHaveLength(1);
  writeFileSync(join(f.root, 'review.md'), Buffer.from([0, 1, 2]));
  f.evidence.orchestration.currentFiles[0] = currentFileObservations(f.root, ['review.md'])[0];
  expect(finalAnswerEvidence(f.contract, f.evidence, {})).toBeUndefined();
});

test('an auxiliary file keeps its complete actual native diff without dropping current primary report contents', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'SHA256SUMS'), 'new-checksum');
  const extra = currentFileObservations(f.root, ['SHA256SUMS'])[0]!;
  f.evidence.orchestration.currentFiles.push(extra);
  const change = { path: 'SHA256SUMS', diff: '--- SHA256SUMS\n-old-checksum\n+new-checksum' };
  f.evidence.diff += '\n' + change.diff;
  const before = JSON.stringify(f.evidence);
  const primary = finalAnswerEvidence(f.contract, f.evidence, {}, [change])!;
  expect(primary.artifacts).toHaveLength(1);
  expect(primary.evidence['currentTextualChanges']).toEqual([{ ...change, observationId: expect.any(String) }]);
  expect(JSON.stringify(f.evidence)).toBe(before);
  expect(finalAnswerEvidence(f.contract, f.evidence, {}, [{ ...change, diff: 'Invented replacement text' }])).toBeUndefined();
});

test('large historical reports stay retained with actual storage references without overflowing the current verification view', () => {
  const f = fixture();
  const history = 'Earlier accepted report. '.repeat(60_000);
  f.contract.units[0]!.answer = history;
  f.evidence.orchestration.units[0].acceptedAnswer = history;
  const projected = finalAnswerEvidence(f.contract, f.evidence, { checks: [{ criterion: 'original-c1' }] })!;
  expect(Buffer.byteLength(JSON.stringify(projected.evidence))).toBeLessThan(20_000);
  expect(projected.evidence['fullSourceEvidence']).toMatchObject({ storage: 'native-contract-store', contractId: f.contract.id });
  expect(f.contract.units[0]!.answer).toBe(history);
  expect(projected.evidence['orchestration']).toMatchObject({ units: [{ acceptedAnswerSource: { storage: 'native-contract-store', contractId: f.contract.id, unitId: 'u1', field: 'answer' },
    latestCheck: { result: 'pass', decisionIds: ['native-unit-check'] } }] });
  expect(projected.evidence['fullSourceEvidence']).not.toHaveProperty('digest');
  expect(projected.evidence['fullSourceEvidence']).not.toHaveProperty('bytes');
  expect(projected.evidence['orchestration']).not.toHaveProperty('acceptedAnswerDigest');
});

test('saved refusal and review bindings change when a privately omitted old body changes even though the model projection stays identical', () => {
  const f = fixture();
  const first = finalAnswerEvidence(f.contract, f.evidence, {})!;
  const before = completionEvidenceCommitment({ output: 'The current answer.', evidence: first.evidence }, f.evidence);
  const firstBody = f.evidence.orchestration.units[0].acceptedAnswer;
  f.evidence.orchestration.units[0].acceptedAnswer = firstBody + ' Actual changed retained non-research body.';
  const second = finalAnswerEvidence(f.contract, f.evidence, {})!;
  // This unrelated old answer is deliberately not repeated in the model view.
  expect(second.evidence).toEqual(first.evidence);
  expect(completionEvidenceCommitment({ output: 'The current answer.', evidence: second.evidence }, f.evidence)).not.toBe(before);
  expect(second.evidence['fullSourceEvidence']).not.toHaveProperty('digest');
  expect(JSON.stringify(second.evidence)).not.toContain('Actual changed retained non-research body.');
});

test('final artifact review receives complete actual current text when the diff omits unchanged sections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'current-review-text-'));
  try {
    const text = '# Current review\n\nUnchanged findings and source assessments.\n\nUpdated execution attribution.\n';
    writeFileSync(join(dir, 'review.md'), text);
    const observed = currentFileObservations(dir, ['review.md'], { includeText: true });
    const contract = makeContract({ units: [] });
    const evidence = { orchestration: { currentFiles: observed }, hostOperations: observed,
      diff: '-Old attribution\n+Updated execution attribution.' };
    const view = finalAnswerEvidence(contract, evidence, {})!;
    expect(view.artifacts).toMatchObject([{ path: 'review.md', observationId: expect.any(String), content: text,
      decisionIds: [], sourceHostOperation: { operation: 'read-current-file', source: 'native-host-filesystem', success: true } }]);
    expect(JSON.stringify(view.evidence).split('Unchanged findings and source assessments.')).toHaveLength(2);
    expect(view.artifacts[0]).not.toHaveProperty('sourceCheckId');
    expect(view.evidence['orchestration']).toMatchObject({ currentFiles: [{ observationId: expect.any(String) }] });
    expect(view.evidence['fullSourceEvidence']).toMatchObject({ storage: 'native-contract-store', contractId: contract.id });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupted current text observation cannot stand in for actual artifact bytes', () => {
  const f = fixture();
  f.evidence.orchestration.currentFiles[0] = { ...f.current, source: 'native-host-filesystem', text: 'Invented contents' };
  expect(finalAnswerEvidence(f.contract, f.evidence, {})).toBeUndefined();
});

test('binary and non-UTF8 bytes never become lossy text evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'current-review-binary-'));
  try {
    writeFileSync(join(dir, 'archive.zip'), Buffer.from([0, 1, 2]));
    writeFileSync(join(dir, 'legacy.txt'), Buffer.from([0xff, 0xfe]));
    for (const observation of currentFileObservations(dir, ['archive.zip', 'legacy.txt'], { includeText: true })) {
      expect(observation).not.toHaveProperty('text');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
