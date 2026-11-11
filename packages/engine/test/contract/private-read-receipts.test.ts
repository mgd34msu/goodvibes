import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { preserveDeclaredReadReceipts, readPrivateReceiptArchives, readNativePrivateReceiptArchives, verifyPrivateReceiptPreservation } from '../../platform/src/platform/contract/private-read-receipts.js';
import { newContractId, type ContractView } from '../../platform/src/platform/contract/types.js';
import { makeRepo } from './runner-support.js';
import { git } from './steps-support.js';
import { judgeEvidence, qualityState } from '../../platform/src/platform/contract/evidence.js';
import { assertJudgmentInput } from '../../platform/src/platform/gate/judgment-input.js';
import { findCardNumberShapes } from '../../platform/src/platform/security/card-shapes.js';
import { buildUnitBrief } from '../../platform/src/platform/contract/brief.js';
import { makeContract, makeCriterion, makeUnit } from './fixtures.js';
import { shapeOf } from './plan-support.js';
import { unitCheck } from './cli-support.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(contractId = 'ctr-abcd1234') {
  const root = makeRepo(); roots.push(root);
  writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
  const relativePath = `.goodvibes/reviews/${contractId}/source-receipts.json`;
  const observations = [{ path: 'review-artifacts/repository-review/findings.json', returnedRanges: ['1-2'], returnedLines: 2,
    contentKind: 'declared-reference' as const, returnedContent: '1 | {"followUpReturnedReadLedger":{"ranges":["11-23"],\n2 | "provenance":"private original receipt provenance"}}' }];
  const contract = { id: contractId, projectRoot: root, units: [
    { id: 'u1', status: 'passed', files: [], checks: [{ id: 'u1.k3', result: 'pass' }], readEvidence: observations },
    { id: 'u2', status: 'running', files: [relativePath], checks: [], readEvidence: [] },
  ] } as unknown as ContractView;
  return { root, relativePath, path: join(root, relativePath), observations, contract };
}

test('declared read receipts are archived privately by the host and survive worker disposal', () => {
  const f = fixture();
  preserveDeclaredReadReceipts(f.contract);
  const stored = readFileSync(f.path);
  const archive = JSON.parse(stored.toString());
  expect(archive.units).toEqual([{ id: 'u1', latestCheckId: 'u1.k3', observations: f.observations }]);
  expect(lstatSync(f.path).mode & 0o777).toBe(0o600);
  expect(git(f.root, 'check-ignore', f.relativePath).trim()).toBe(f.relativePath);
  const receipt = readPrivateReceiptArchives(f.contract);
  expect(receipt[0]).toMatchObject({ path: f.relativePath, bytes: stored.length, archivedUnits: [{ id: 'u1', observations: 1,
    retainedReferences: ['review-artifacts/repository-review/findings.json'] }] });
  expect(JSON.stringify(receipt)).not.toContain('private original receipt provenance');
  expect(JSON.stringify(receipt)).not.toContain('11-23');
  const native = readNativePrivateReceiptArchives(f.contract, [f.relativePath, 'review-artifacts/repository-review/findings.json']);
  expect(native[0]).toMatchObject({ retainedPrivateReferences: [{ unitId: 'u1', checkedAt: 'u1.k3',
    path: f.observations[0]!.path, returnedRanges: ['1-2'], returnedLines: 2, returnedContent: f.observations[0]!.returnedContent }] });
  expect(native[0]).toMatchObject({ archivedReadObservations: [{ unitId: 'u1', checkedAt: 'u1.k3',
    observations: [{ path: f.observations[0]!.path, returnedRanges: ['1-2'], returnedLines: 2 }] }] });
  expect(readNativePrivateReceiptArchives(f.contract, ['review-artifacts/repository-review/findings.json'])).toEqual(receipt);
  expect(receipt[0]!.hostFileRead).toMatchObject({ operation: 'read-file', source: 'native-host-filesystem', success: true,
    ownerProjectRoot: f.root, absolutePath: f.path, bytes: stored.length, mode: '600' });
  const evidence = { output: 'The host preserved the receipts.', changedPaths: [], diff: '', omitted: [], commands: [],
    orchestration: JSON.parse(JSON.stringify({ privateArtifacts: native })) };
  expect(judgeEvidence(evidence)).toMatchObject({ hostOperations: [receipt[0]!.hostFileRead] });
  expect(qualityState({ goal: 'Preserve receipts privately', brief: 'The host stores private data.' }, evidence).hostOperations).toEqual([receipt[0]!.hostFileRead]);
  expect(f.contract.units[0]!.readEvidence).toEqual(f.observations);
  preserveDeclaredReadReceipts(f.contract);
  expect(readFileSync(f.path)).toEqual(stored);
});

test('unregistered reserved paths grant no host archive operation', () => {
  const f = fixture();
  const other = { ...f.contract, units: [{ ...f.contract.units[1]!, files: ['.goodvibes/settings.json'] }] };
  preserveDeclaredReadReceipts(other);
  expect(existsSync(f.path)).toBe(false);
  expect(readPrivateReceiptArchives(other)).toEqual([]);
});

test('later accepted source work and owner observations are appended without replacing original receipts', () => {
  const f = fixture(); preserveDeclaredReadReceipts(f.contract);
  const first = JSON.parse(readFileSync(f.path, 'utf8')).units[0];
  const later = { ...f.contract, units: [...f.contract.units, { ...f.contract.units[0]!, id: 'later',
    checks: [{ ...f.contract.units[0]!.checks[0]!, id: 'later.k1' }] }] };
  const owner = { kind: 'original-owner-read-observations', sourceReads: [{ path: 'original.ts', returnedRanges: ['1-2'] }],
    sources: [{ sha256: 'first-session-file' }] };
  preserveDeclaredReadReceipts(later, owner);
  const stored = JSON.parse(readFileSync(f.path, 'utf8'));
  expect(stored.units).toHaveLength(2);
  expect(stored.units[0]).toEqual(first);
  expect(stored.ownerObservations).toEqual([owner]);
  const bytes = readFileSync(f.path);
  preserveDeclaredReadReceipts(later, { ...owner, sources: [{ sha256: 'same-reads-new-session-save' }] });
  expect(readFileSync(f.path)).toEqual(bytes);
});

test('archival waits for source dependencies and never seals an empty archive', () => {
  const f = fixture();
  const waiting = { ...f.contract, units: [{ ...f.contract.units[0]!, status: 'running' as const },
    { ...f.contract.units[1]!, dependsOn: ['u1'] }] };
  preserveDeclaredReadReceipts(waiting);
  expect(existsSync(f.path)).toBe(false);
  preserveDeclaredReadReceipts({ ...f.contract, units: [{ ...f.contract.units[0]!, readEvidence: [] }, f.contract.units[1]!] });
  expect(existsSync(f.path)).toBe(false);
  expect(verifyPrivateReceiptPreservation(f.contract, f.contract.units[1]!, f.root)).toMatchObject({ passed: false });
  preserveDeclaredReadReceipts(f.contract);
  expect(existsSync(f.path)).toBe(true);
});

test('private receipt archival refuses redirected directories and unrelated existing files', () => {
  const f = fixture();
  mkdirSync(join(f.root, '.goodvibes'), { recursive: true });
  mkdirSync(join(f.root, 'other'));
  symlinkSync(join(f.root, 'other'), join(f.root, '.goodvibes/reviews'));
  expect(() => preserveDeclaredReadReceipts(f.contract)).toThrow('redirected');
  expect(existsSync(join(f.root, 'other/ctr-abcd1234/source-receipts.json'))).toBe(false);
  rmSync(join(f.root, '.goodvibes/reviews'));
  mkdirSync(join(f.root, '.goodvibes/reviews/ctr-abcd1234'), { recursive: true });
  writeFileSync(f.path, '{"owner":"someone else"}');
  expect(() => preserveDeclaredReadReceipts(f.contract)).toThrow('unrecognized owner');
  expect(readFileSync(f.path, 'utf8')).toBe('{"owner":"someone else"}');
});

test('a preservation gate compares actual private records and the exact original Git reference', () => {
  const f = fixture();
  const reference = f.observations[0]!.path;
  mkdirSync(join(f.root, 'review-artifacts/repository-review'), { recursive: true });
  writeFileSync(join(f.root, reference), '{"followUpReturnedReadLedger":{"ranges":["11-23"],\n"provenance":"private original receipt provenance"}}');
  git(f.root, 'add', reference); git(f.root, 'commit', '-qm', 'Original review reference');
  const task = { ...f.contract.units[1]!, files: [f.relativePath, reference], baseline: { head: git(f.root, 'rev-parse', 'HEAD').trim(), dirty: {} } };
  preserveDeclaredReadReceipts(f.contract);
  const gate = verifyPrivateReceiptPreservation(f.contract, task, f.root)!;
  expect(gate.passed).toBe(true);
  const output = JSON.parse(gate.output);
  expect(output).toMatchObject({ originalReadRecordsIdentical: true,
    baseline: { encoding: 'git-object-id-hex-nibbles-a-p' },
    referenceChecks: [{ path: reference, identical: true, sourceUnitId: 'u1' }] });
  expect(output.baseline.value.replace(/[a-p]/g, (letter: string) => (letter.charCodeAt(0) - 97).toString(16))).toBe(task.baseline.head);
  expect(task.baseline.head).toBe(git(f.root, 'rev-parse', 'HEAD').trim());
  const archive = JSON.parse(readFileSync(f.path, 'utf8'));
  archive.units[0].observations[0].returnedRanges = ['99-100'];
  writeFileSync(f.path, JSON.stringify(archive));
  expect(verifyPrivateReceiptPreservation(f.contract, task, f.root)).toMatchObject({ passed: false, output: 'Archived observations differ from their original accepted host records' });
});

test('a card-shaped native Git identity survives the actual repair brief without exempting semantic card material', () => {
  const f = fixture();
  // An adversarial canonical object-ID spelling, not a claim this Git object
  // exists. This storage-only obligation has no public Git reference to read.
  const head = 'a'.repeat(12) + '4111111111111111' + 'b'.repeat(12);
  expect(head).toMatch(/^[0-9a-f]{40}$/);
  expect(findCardNumberShapes(head)).toHaveLength(1);
  const source = makeUnit({ id: 'u1', status: 'passed', files: [], role: 'research', readEvidence: f.observations,
    checks: [{ ...unitCheck('u1.k3'), result: 'pass' }] });
  const archived = makeUnit({ id: 'u2', status: 'passed', files: [f.relativePath], baseline: { head, dirty: {} } });
  const repair = makeUnit({ id: 'u3', role: 'research', dependsOn: ['u2'],
    criteria: [makeCriterion({ id: 'u3.c1', origin: 'fix', serves: ['c1'] })] });
  const contract = makeContract({ id: f.contract.id, projectRoot: f.root, shape: shapeOf(), units: [source, archived, repair] });
  preserveDeclaredReadReceipts(contract);
  const task = buildUnitBrief(contract, contract.groups[0]!, repair);
  const marker = 'Actual host orchestration records (evidence, not approval of this unit):\n';
  const records = JSON.parse(task.split(marker)[1]!);
  expect(records.privateArchiveChecks).toHaveLength(1);
  const checked = JSON.parse(records.privateArchiveChecks[0].output);
  expect(records.privateArchiveChecks[0].passed).toBe(true);
  expect(checked.baseline).toMatchObject({ encoding: 'git-object-id-hex-nibbles-a-p' });
  expect(checked.baseline.value.replace(/[a-p]/g, (letter: string) => (letter.charCodeAt(0) - 97).toString(16))).toBe(head);
  expect(archived.baseline!.head).toBe(head);
  assertJudgmentInput({ task });
  // Reconstruct the previous producer's exact raw-baseline field in the same
  // complete task, demonstrating the refusal rather than bypassing screening.
  records.privateArchiveChecks[0].output = JSON.stringify({ ...checked, baseline: head });
  const previousTask = task.slice(0, task.indexOf(marker) + marker.length) + JSON.stringify(records);
  expect(() => assertJudgmentInput({ task: previousTask })).toThrow('payment card material');
  const semanticTask = buildUnitBrief(contract, contract.groups[0]!, { ...repair, brief: 'Use card 4111111111111111.' });
  expect(() => assertJudgmentInput({ task: semanticTask })).toThrow('payment card material');
});

test('an old private reference cannot establish preservation of a different current baseline', () => {
  const f = fixture(); const reference = f.observations[0]!.path;
  mkdirSync(join(f.root, 'review-artifacts/repository-review'), { recursive: true });
  writeFileSync(join(f.root, reference), '{"followUpReturnedReadLedger":{"ranges":["40-50"]}}');
  git(f.root, 'add', reference); git(f.root, 'commit', '-qm', 'Different current review');
  preserveDeclaredReadReceipts(f.contract);
  const task = { ...f.contract.units[1]!, files: [f.relativePath, reference], baseline: { head: git(f.root, 'rev-parse', 'HEAD').trim(), dirty: {} } };
  expect(verifyPrivateReceiptPreservation(f.contract, task, f.root)).toMatchObject({ passed: false,
    output: `The original public reference ${reference} has no exact preserved private snapshot` });
});

// UNRUN: this is the actual private archive writer/read path, not only the ID regex.
test('full opaque contract IDs preserve native private receipt archives', () => {
  const f = fixture(newContractId()); preserveDeclaredReadReceipts(f.contract);
  expect(existsSync(f.path)).toBe(true); expect(lstatSync(f.path).mode & 0o777).toBe(0o600);
  expect(readPrivateReceiptArchives(f.contract)[0]?.path).toBe(f.relativePath);
  const receipt = readNativePrivateReceiptArchives(f.contract, [f.relativePath, 'review-artifacts/repository-review/findings.json'])[0];
  if (!receipt || !('retainedPrivateReferences' in receipt)) throw new Error('Missing actual private reference contents');
  expect(receipt.retainedPrivateReferences).toHaveLength(1);
});
