/** Source regression UNRUN during the coding-first pass. */
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashState } from '@goodvibes-jev/judgment';
import { captureAnswerClaimOutput, answerClaimScopes, completeAnswerClaimCoverage, recordAnswerClaimReview, scopedClaimQuestion } from '../../platform/src/platform/contract/final-answer-claims.js';
import { createNativeDataWriteOwner, nativeReaderCapabilities, assertNativeReaderCompatible } from '../../platform/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../../platform/src/platform/runtime/update-file-io.js';

test('fresh actual claim coverage uses its exact original immutable answer without hashing the same passages again', () => {
  const output = 'A supported claim with its complete surrounding qualification.\n'.repeat(200);
  const scopes = answerClaimScopes(output);
  const hashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    const reviews = scopes.map((scope, index) => recordAnswerClaimReview(scope, { stateHash: 'actual-recorded-state', decisionId: `decision-${index}`,
      reading: { probability: 0.01, verdict: 'no', outcome: 'act' } }));
    expect(completeAnswerClaimCoverage(output, reviews)).toBe(true);
    expect(completeAnswerClaimCoverage(output.slice(0, -1) + 'x', reviews)).toBe(false);
    expect(hashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    expect(Object.isFrozen(reviews[0])).toBe(true);
    expect(JSON.stringify(reviews)).not.toContain('A supported claim');
    expect(() => recordAnswerClaimReview({ ...scopes[0]! }, { stateHash: 'copied', decisionId: 'copied', reading: { probability: 0.01, verdict: 'no', outcome: 'act' } })).toThrow('original host scope');
    // Actual saved/read-back rows carry no private current-input provenance:
    // they retain the real logged-question commitment verification path.
    expect(completeAnswerClaimCoverage(output, structuredClone(reviews))).toBe(true);
    expect(hashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
  } finally { hashes.mockRestore(); }
});

test('actual whole-output owner is reused through parent/child ranges and saved verification; copied handles do not prove content', () => {
  const output = 'Supported source text and all qualifying context.\n'.repeat(300), owner = captureAnswerClaimOutput(output);
  const hashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    const scopes = answerClaimScopes(output, 0, output.length, 4000, owner);
    const children = answerClaimScopes(output, scopes[0]!.start, scopes[0]!.end, 2000, owner);
    const complete = [...children, ...scopes.slice(1)];
    expect(complete.every(scope => scope.version === 2 && scope.outputDigest === owner.digest)).toBe(true);
    expect(completeAnswerClaimCoverage(output, complete, owner)).toBe(true);
    expect(completeAnswerClaimCoverage(output, structuredClone(complete), owner)).toBe(true);
    expect(hashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    expect(() => answerClaimScopes(output, 0, output.length, 4000, { ...owner })).toThrow('original host owner');
    expect(() => answerClaimScopes('Different output', 0, 16, 4000, owner)).toThrow('original host owner');
    const forged = complete.map(scope => ({ ...scope, outputDigest: '0'.repeat(64) }));
    expect(completeAnswerClaimCoverage(output, forged, { digest: '0'.repeat(64) })).toBe(false);
    expect(hashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
    const question = scopedClaimQuestion({ type: 'noul', instructions: 'Supported?' }, complete[0]!, owner.digest);
    expect(question.instructions).toMatchObject({ claimScope: { version: 2, start: complete[0]!.start, end: complete[0]!.end, outputDigest: owner.digest } });
    expect(JSON.stringify(question)).not.toContain('textDigest');
  } finally { hashes.mockRestore(); }
});

test('historical saved passage commitments/questions remain exact while invalid mixed/future scopes refuse', () => {
  const output = 'Historical saved complete answer', scope = { start: 0, end: output.length, textDigest: hashState(output) };
  expect(completeAnswerClaimCoverage(output, [scope])).toBe(true);
  expect(completeAnswerClaimCoverage(output + '.', [scope])).toBe(false);
  const question = scopedClaimQuestion({ type: 'noul', instructions: 'Supported?' }, scope, hashState(output));
  expect(question.instructions).toMatchObject({ claimScope: { ...scope, outputDigest: hashState(output) } });
  const fresh = answerClaimScopes(output)[0]!;
  expect(completeAnswerClaimCoverage(output, [{ ...fresh, textDigest: scope.textDigest } as unknown as typeof fresh])).toBe(false);
  expect(completeAnswerClaimCoverage(output, [{ ...fresh, version: 3 } as unknown as typeof fresh])).toBe(false);
  let invoked = 0;
  expect(completeAnswerClaimCoverage(output, [{ ...fresh, get outputDigest() { invoked++; return 'foreign'; } }])).toBe(false);
  expect(completeAnswerClaimCoverage(output, [new Proxy(fresh, { get() { invoked++; return undefined; } })])).toBe(false); expect(invoked).toBe(0);
});

test('later map/Reflect overrides cannot manufacture original output or review ownership', () => {
  const output = 'Exact original complete output', owner = captureAnswerClaimOutput(output), scope = answerClaimScopes(output, 0, output.length, 4000, owner)[0]!;
  const get = WeakMap.prototype.get, set = WeakMap.prototype.set, apply = Reflect.apply; const results: boolean[] = [];
  try {
    WeakMap.prototype.get = () => ({ output, digest: '0'.repeat(64) }); WeakMap.prototype.set = function () { throw new Error('Replacement writer'); }; Reflect.apply = (() => ({ output })) as typeof Reflect.apply;
    try { recordAnswerClaimReview({ ...scope }, { stateHash: 'forged', decisionId: 'forged', reading: { probability: 0.01, verdict: 'no', outcome: 'act' } }); results.push(false); } catch { results.push(true); }
    try { answerClaimScopes(output, 0, output.length, 4000, { ...owner }); results.push(false); } catch { results.push(true); }
    const actual = recordAnswerClaimReview(scope, { stateHash: 'actual', decisionId: 'actual', reading: { probability: 0.01, verdict: 'no', outcome: 'act' } }); results.push(completeAnswerClaimCoverage(output, [actual], owner));
  } finally { WeakMap.prototype.get = get; WeakMap.prototype.set = set; Reflect.apply = apply; }
  expect(results).toEqual([true, true, true]);
});

test('the same version without the actual scope2 reader cannot admit its saved requirement floor', () => {
  const root = mkdtempSync(join(tmpdir(), 'answer-scope-reader-')), execPath = join(root, 'goodvibes');
  try {
    writeFileSync(execPath, 'Inert original native reader fixture', { mode: 0o755 });
    const writer = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} }); writer.declare('contract-answer-claim-scopes-v2');
    const capabilities = nativeReaderCapabilities('3.1.2');
    expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, capabilities)).not.toThrow();
    expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, { ...capabilities, formats: capabilities.formats.filter(format => format !== 'contract-answer-claim-scopes-v2') })).toThrow('does not confirm');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('invalid claim ranges and nonadvancing chunk sizes refuse before hashing rather than looping', () => {
  const hashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    for (const limit of [0, -1, NaN, Infinity, 4_001, 1.5]) expect(() => answerClaimScopes('answer', 0, 6, limit)).toThrow(RangeError);
    for (const [start, end] of [[-1, 6], [0, 7], [4, 3], [0.5, 6], [0, NaN]]) expect(() => answerClaimScopes('answer', start, end)).toThrow(RangeError);
    expect(hashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hashes.mockRestore(); }
  expect(completeAnswerClaimCoverage('', answerClaimScopes(''))).toBe(true);
});
