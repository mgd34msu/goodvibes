/** Native nested-attempt checkpoint regressions; source authored, UNRUN. */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentFileObservations } from '../../sdk/src/platform/contract/current-file-observations.ts';
import { contractWithStoredReviewObservations, retainOriginalReviewDescriptors, reviewedFileFromObservation, reviewedFileVersionState } from '../../sdk/src/platform/contract/review-file-observations.ts';
import { ContractStore, contractPath, deserializeContract, serializeContract } from '../../sdk/src/platform/contract/store.ts';
import type { ContractUnit, UnitCheck } from '../../sdk/src/platform/contract/types.ts';
import { makeContract, makeUnit } from './fixtures.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nested-native-review-'));
  writeFileSync(join(root, 'report.md'), 'Reviewed original bytes.\n');
  const file = currentFileObservations(root, ['report.md'])[0]!, descriptor = reviewedFileFromObservation(file)!;
  const check: UnitCheck = { id: 'leaf.k1', at: 1, trigger: 'completion', result: 'pass', quality: {},
    decisionIds: ['native-nested-check'], goal: { verdict: 'met', probabilityUnmet: 0.1, outcome: 'act' },
    evidenceDigest: 'fixture-existing-evidence', reviewedFiles: [descriptor] };
  const leaf = makeUnit({ id: 'leaf', checks: [check] });
  const attempt = makeUnit({ id: 'attempt', checks: [], attemptUnits: [leaf] });
  const unit = makeUnit({ id: 'parent', checks: [], attemptUnits: [attempt] });
  const contract = makeContract({ projectRoot: root, units: [unit] });
  const store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
  const nested = (units: readonly ContractUnit[]) => units[0]!.attemptUnits![0]!.attemptUnits![0]!;
  return { root, contract, file, descriptor, store, nested, close() { store.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

test('nested attempt reviews preserve private facts through actual checkpoint write and reopen', () => {
  const f = fixture(); let reopened: ContractStore | undefined;
  try {
    f.store.hold(f.contract); expect(f.store.write(f.contract.id)).toBe(true);
    const saved = JSON.parse(readFileSync(contractPath(f.root, f.contract.id), 'utf8'));
    expect(f.nested(saved.contract.units).checks[0]!.reviewedFiles![0]).toHaveProperty('nativeFileObservation');
    reopened = new ContractStore({ projectRoot: f.root, sweepIntervalMs: 0 });
    const restored = reopened.load(f.contract.id)!;
    const reference = f.nested(restored.units).checks[0]!.reviewedFiles![0]!;
    expect(reviewedFileVersionState(f.file, reference)).toBe('current');
    expect(JSON.stringify(restored)).not.toContain('nativeFileObservation');
    const imported = deserializeContract(JSON.stringify(saved))!;
    expect(reviewedFileVersionState(f.file, f.nested(imported.units).checks[0]!.reviewedFiles![0]!)).toBe('unverified');
  } finally { reopened?.dispose(); f.close(); }
});

test('graceful checkpoint copies retain exact native nested descriptors without granting copies provenance', () => {
  const f = fixture();
  try {
    const copy = structuredClone(f.contract);
    expect(reviewedFileVersionState(f.file, f.nested(copy.units).checks[0]!.reviewedFiles![0]!)).toBe('unverified');
    retainOriginalReviewDescriptors(f.contract, copy);
    expect(f.nested(copy.units).checks[0]!.reviewedFiles![0]).toBe(f.descriptor);
    expect(serializeContract(copy, 1)).toContain('nativeFileObservation');
    const wrong = structuredClone(f.contract); Reflect.set(f.nested(wrong.units), 'id', 'foreign-leaf');
    expect(() => retainOriginalReviewDescriptors(f.contract, wrong)).toThrow('unavailable');
  } finally { f.close(); }
});

test('review serialization rejects cyclic or multiply aliased units instead of losing nested facts', () => {
  const f = fixture();
  try {
    const leaf = f.nested(f.contract.units); leaf.attemptUnits = [f.contract.units[0]!];
    expect(() => contractWithStoredReviewObservations(f.contract)).toThrow('unavailable');
    leaf.attemptUnits = []; f.contract.units[0]!.attemptUnits!.push(leaf);
    expect(() => contractWithStoredReviewObservations(f.contract)).toThrow('unavailable');
  } finally { f.close(); }
});
