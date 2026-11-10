import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unpackStaticSourceStorage } from '../scripts/static-source-storage.ts';
import { gunzipSync, gzipSync } from 'node:zlib';
import { JudgmentError, noul, toJson, validateContextBudget, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { captureStaticInputs, CheckpointValueReader, loadStaticSourceCheckpoint, loadStaticSourceJournal, loadStaticSourceReadings, openStaticSourceJournal, parseStaticSourceReadings, readStaticInput, revalidateStaticInput, saveStaticSourceReadings, STATIC_CHECKPOINT_MAX_SCALAR_CHARS, staticInputCaptureComplete, staticInputKey, staticInputStanding, staticSelectionCandidates, staticSelectionContext, type StaticSourceReadings, type StaticSourceInput, type StaticSourceProgress } from '../scripts/static-source-readings.ts';
import { INTERNAL_IDENTIFIER_INSTRUCTIONS, internalIdentifier, staticOffendingAnchor } from '../scripts/batteries/static-source.ts';
import { createStaticCallRecorder } from '../scripts/static-source-call-recording.ts';
import { preparedStaticReadings } from './_helpers/static-source-evidence.ts';

const input = () => captureStaticInputs('internal-identifier', 'platform/src/example.ts', '// Exact public source\nconst value = 3;')[0]!;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function readCapturedInput(port: JudgmentPort, input: StaticSourceInput, signal?: AbortSignal, progress?: StaticSourceProgress) {
  const recorded = createStaticCallRecorder(port);
  return readStaticInput(recorded.port, recorded.capture, input, signal, progress);
}

test('a durable interrupted subset tree resumes only its missing call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'static-partial-subsets-'));
  try {
    const captured = input();
    const journalPath = join(root, 'checkpoint.journal');
    let answeredBeforeRestart = 0;
    const readings: Record<string, unknown> = {};
    const current: StaticSourceReadings = { format: 2, readings };
    {

      using journal = openStaticSourceJournal(journalPath);
      journal.append(current);
      const fixture = fakePort((_name, _question, state) => {
        if (typeof state !== 'object' || state === null || !('anchors' in state) || !Array.isArray(state.anchors)) throw new Error('Unexpected state');
        return noulAnswer(state.anchors.length > 1 ? 0.5 : 0.01);
      });
      let calls = 0;
      const interrupted: JudgmentPort = { model: fixture.port.model, ask(request) {
        if (++calls === 3) throw new JudgmentError('internal', 'The decision client failed internally. The operation has stopped.');
        return fixture.port.ask(request);
      } };
      await expect(readCapturedInput(interrupted, captured, undefined, {
        previous: current, onReceipt(source, receipt) {
          readings[staticInputKey(source)] = receipt;
          journal.append({ ...current, readings: { [staticInputKey(source)]: receipt } }, source);
        },
      })).rejects.toMatchObject({ kind: 'internal', message: 'The decision client failed internally. The operation has stopped.' });
      expect(fixture.requests).toHaveLength(2);
      answeredBeforeRestart = fixture.requests.length;
      expect(calls).toBe(3);
    }
    const retained = loadStaticSourceJournal(journalPath, null);
    if (!retained) throw new Error('Missing durable partial receipts');
    expect(staticInputCaptureComplete(captured, retained)).toBe(false);
    expect(staticInputStanding(captured, retained).kind).toBe('held');
    const rawJournal: unknown = JSON.parse(readFileSync(journalPath, 'utf8').split('\n')[1]!);
    expect(rawJournal).toMatchObject({ capturedInput: captured });
    const rootPresence = retained.readings[staticInputKey(captured)];
    const mutable = { ...retained.readings };
    const resumed = { ...retained, readings: mutable };

    using journal = openStaticSourceJournal(journalPath);
    const fixture = fakePort(() => noulAnswer(0.01));
    const receipt = await readCapturedInput(fixture.port, captured, undefined, {
      previous: resumed, onReceipt(source, value) {
        mutable[staticInputKey(source)] = value;
        journal.append({ ...resumed, readings: { [staticInputKey(source)]: value } }, source);
      },
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.state).toMatchObject({ source: captured.source, anchors: [captured.anchors[1]] });
    if (typeof rootPresence !== 'object' || rootPresence === null || !('presence' in rootPresence)) throw new Error('Missing original presence');
    expect(rootPresence.presence).toEqual(receipt.presence);
    expect(answeredBeforeRestart + fixture.requests.length).toBe(3);
    expect(staticInputCaptureComplete(captured, resumed)).toBe(true);
    expect(staticInputStanding(captured, resumed)).toEqual({ kind: 'clear' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an interrupted exact selector resumes without repeating its admitted presence', async () => {
  const captured = input();
  const readings: Record<string, unknown> = {};
  const current: StaticSourceReadings = { format: 2, readings };

  const fixture = fakePort(() => noulAnswer(0.99));
  let calls = 0;
  const interrupted: JudgmentPort = { model: fixture.port.model, ask(request) {
    if (++calls === 2) throw new JudgmentError('internal', 'The decision client failed internally. The operation has stopped.');
    return fixture.port.ask(request);
  } };
  const progress = { previous: current, onReceipt(source: Parameters<typeof staticInputKey>[0], receipt: Awaited<ReturnType<typeof readStaticInput>>) {
    readings[staticInputKey(source)] = receipt;
  } };
  await expect(readCapturedInput(interrupted, captured, undefined, progress)).rejects.toMatchObject({ kind: 'internal', message: 'The decision client failed internally. The operation has stopped.' });
  expect(staticInputCaptureComplete(captured, current)).toBe(false);
  expect(staticInputStanding(captured, current).kind).toBe('held');
  const original = readings[staticInputKey(captured)];
  const resumed = fakePort((name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.99) : noulAnswer(name === 'violation' ? 0.01 : 0.99));
  const receipt = await readCapturedInput(resumed.port, captured, undefined, progress);
  expect(resumed.requests).toHaveLength(1);
  expect(resumed.requests[0]?.state).toHaveProperty('candidates');
  if (typeof original !== 'object' || original === null || !('presence' in original)) throw new Error('Missing original presence');
  expect(original.presence).toEqual(receipt.presence);
  expect(staticInputCaptureComplete(captured, current)).toBe(true);
  expect(staticInputStanding(captured, current).kind).toBe('held');
  const noRepeat = fakePort(() => { throw new Error('An answered held selector must not be asked again'); });
  await readCapturedInput(noRepeat.port, captured, undefined, progress);
  expect(noRepeat.requests).toHaveLength(0);
  expect(staticInputStanding(captured, current).kind).toBe('held');
});

test('journal recovery rejects torn or malformed records without altering original bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'static-partial-journal-'));
  try {
    const captured = input();
    const current = await preparedStaticReadings([captured]);
    const path = join(root, 'checkpoint.journal');
    const original = `${JSON.stringify(current)}\n{\"format\":2,\"readings\":{\"unfinished\":\"`;
    writeFileSync(path, original);
    expect(loadStaticSourceJournal(path, null)).toEqual(current);
    {
      using journal = openStaticSourceJournal(path);
      journal.append({ ...current, readings: { malformed: { presence: 'invalid' } } });
    }
    expect(readFileSync(path, 'utf8').startsWith(original)).toBe(true);
    const recovered = loadStaticSourceJournal(path, null);
    expect(staticInputStanding(captured, recovered)).toEqual({ kind: 'clear' });
    expect(staticInputStanding({ ...captured, source: captured.source + 'changed' }, recovered).kind).toBe('held');
    expect(recovered?.readings.malformed).toEqual({ presence: 'invalid' });
    const prototypePath = join(root, 'prototype.journal');
    writeFileSync(prototypePath, `${JSON.stringify({ ...current, readings: { ['__proto__']: { [staticInputKey(captured)]: current.readings[staticInputKey(captured)] } } })}\n`);
    const prototype = loadStaticSourceJournal(prototypePath, null);
    if (!prototype) throw new Error('Missing controlled history record');
    expect(Object.hasOwn(prototype.readings, '__proto__')).toBe(true);
    expect(Object.hasOwn(prototype.readings, staticInputKey(captured))).toBe(false);
    expect(staticInputStanding(captured, prototype).kind).toBe('held');
    expect(revalidateStaticInput(captured, prototype)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('chunked journal replay preserves original complete-line order, UTF-8 and own keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'static-chunked-journal-'));
  try {
    const path = join(root, 'checkpoint.journal');
    const prefix = '{"format":2,"readingPlanVersion":2,"readings":{"unicode":{"text":"';
    const text = `${'x'.repeat(64 * 1024 - Buffer.byteLength(prefix) - 1)}😀é`;
    const first = Buffer.from(`${prefix}${text}"},"replaced":"first"}}\n`);
    expect(first.subarray(64 * 1024 - 1, 64 * 1024 + 3)).toEqual(Buffer.from('😀'));
    const next = { format: 2, readingPlanVersion: 3,
      readings: { replaced: 'last', ['__proto__']: { retained: true }, large: 'y'.repeat(128 * 1024) } };
    const torn = Buffer.concat([Buffer.from('{"format":2,"readings":{"text":"'), Buffer.from([0xf0, 0x9f])]);
    const bytes = Buffer.concat([first, Buffer.from('{"format":2,"readingPlanVersion":4,"readings":{}}\n'),
      Buffer.from([0xc3, 10]), Buffer.from('null\n'), Buffer.from(`${JSON.stringify(next)}\n`), torn]);
    writeFileSync(path, bytes);
    let readingPlanVersion: StaticSourceReadings['readingPlanVersion'];
    let complete = false;
    const readings: Record<string, unknown> = {};
    // Native whole-string parsing is independent of the streaming implementation.
    for (const line of bytes.toString('utf8').split('\n').slice(0, -1)) {
      let record: StaticSourceReadings | null;
      try { record = parseStaticSourceReadings(JSON.parse(line)); } catch { continue; }
      if (!record) continue;
      complete = true; readingPlanVersion = record.readingPlanVersion;
      Object.defineProperties(readings, Object.getOwnPropertyDescriptors(record.readings));
    }
    expect(complete).toBe(true);
    const expected: StaticSourceReadings = { format: 2, readings,
      ...(readingPlanVersion === undefined ? {} : { readingPlanVersion }) };
    const replayed = loadStaticSourceJournal(path, null);
    expect(replayed).toEqual(expected);
    expect(replayed?.readings.unicode).toEqual({ text });
    expect(replayed?.readings.replaced).toBe('last');
    expect(Object.hasOwn(replayed!.readings, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(replayed!.readings)).toBe(Object.prototype);
    expect(readFileSync(path)).toEqual(bytes);
    {
      using journal = openStaticSourceJournal(path);
      journal.append({ format: 2, readings: { after: true } });
    }
    const after = readFileSync(path);
    expect(after.subarray(0, bytes.length)).toEqual(bytes);
    expect(after.subarray(bytes.length).toString('utf8').startsWith('\tINCOMPLETE_RECORD\n')).toBe(true);
    expect(loadStaticSourceJournal(path, null)).toEqual({ format: 2, readings: { ...readings, after: true } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the single-byte journal tail check preserves absent, empty and complete file behavior', () => {
  const root = mkdtempSync(join(tmpdir(), 'static-journal-tail-'));
  try {
    const record: StaticSourceReadings = { format: 2, readings: {} };
    for (const [name, original] of [['absent', undefined], ['empty', ''], ['complete', `${JSON.stringify(record)}\n`]] as const) {
      const path = join(root, `${name}.journal`);
      if (original !== undefined) writeFileSync(path, original);
      {
        using journal = openStaticSourceJournal(path);
        journal.append(record);
      }
      expect(readFileSync(path, 'utf8')).toBe(`${original ?? ''}${original === '' ? '\tINCOMPLETE_RECORD\n' : ''}${JSON.stringify(record)}\n`);
      expect(loadStaticSourceJournal(path, null)).toEqual(record);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stale raw question evidence cannot affect a new source capture or revive its old answer', async () => {
  const captured = input();
  const original = await preparedStaticReadings([captured], 0.2);
  const prior = original.readings[staticInputKey(captured)];
  if (!object(prior) || !object(prior.presence)) throw new Error('Missing prior unit fixture');
  const staleCapture = { ...prior, presence: { ...prior.presence, questions: { violation: noul('A different original question.') } } };
  const readings: Record<string, unknown> = { [staticInputKey(captured)]: staleCapture };
  const previous = { ...original, readings };
  const fixture = fakePort(() => noulAnswer(0.01));
  const receipt = await readCapturedInput(fixture.port, captured, undefined, {
    previous, onReceipt(source, value) { readings[staticInputKey(source)] = value; },
  });
  expect(fixture.requests).toHaveLength(1);
  expect(receipt.presence.answers).toEqual({ violation: noulAnswer(0.01) });
  expect(receipt.input).toEqual(captured);
  expect(receipt.previousCaptures?.[0]).toEqual(staleCapture);
  expect(staticInputStanding(captured, previous)).toEqual({ kind: 'clear' });
});

test('replacing an invalid inherited subset preserves its original raw capture', async () => {
  const captured = input();
  const original = await preparedStaticReadings([captured], 0.5);
  const root = original.readings[staticInputKey(captured)];
  if (typeof root !== 'object' || root === null || !('parts' in root) || !Array.isArray(root.parts)
    || !object(root.parts[0]) || !object(root.parts[0].input)) throw new Error('Missing authored subset tree');
  const stalePart = { ...root.parts[0], input: { ...root.parts[0].input, source: 'stale original source' } };
  const readings: Record<string, unknown> = { [staticInputKey(captured)]: { ...root, parts: [stalePart, root.parts[1]] } };
  const previous = { ...original, readings };
  const fixture = fakePort(() => noulAnswer(0.01));

  const receipt = await readCapturedInput(fixture.port, captured, undefined, {
    previous, onReceipt(source, value) { readings[staticInputKey(source)] = value; },
  });
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]?.state).toMatchObject({ anchors: [captured.anchors[0]], source: captured.source });
  expect(receipt.parts[0]?.previousCaptures?.[0]).toEqual(stalePart);
  expect(receipt.parts[1]?.presence).toEqual(root.parts[1].presence);
  expect(staticInputCaptureComplete(captured, previous)).toBe(true);
  expect(staticInputStanding(captured, previous).kind).toBe('held');
});

test('gzip receipts preserve exact answers and provenance with deterministic epoch bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'static-receipt-codec-'));
  try {
    const captured = input();
    const readings = await preparedStaticReadings([captured], 0.12345678901234567);
    const value = { ...readings,
      readings: { ...readings.readings, archived: { previousCaptures: [{ answers: { violation: { type: 'noul', noul: 0.9876543210987654 } }, at: '2026-10-01T00:00:00Z' }] } } };
    const path = join(root, 'receipt.json.gz');
    saveStaticSourceReadings(value, path);
    const bytes = readFileSync(path);
    expect(bytes.readUInt32LE(4)).toBe(0);
    expect(unpackStaticSourceStorage(JSON.parse(gunzipSync(bytes).toString('utf8')))).toEqual(value);
    expect(loadStaticSourceReadings(path)).toEqual(value);
    saveStaticSourceReadings(value, path);
    expect(readFileSync(path)).toEqual(bytes);
    const plain = join(root, 'custom.json');
    saveStaticSourceReadings(value, plain);
    expect(loadStaticSourceReadings(plain)).toEqual(value);
    expect(unpackStaticSourceStorage(JSON.parse(readFileSync(plain, 'utf8')))).toEqual(value);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('malformed gzip and compressed schemas hold the same complete evidence gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'static-receipt-invalid-codec-'));
  try {
    const path = join(root, 'receipt.json.gz');
    for (const bytes of [Buffer.from('not gzip'), gzipSync('{'), gzipSync(JSON.stringify({ format: 2, readings: [] }))]) {
      writeFileSync(path, bytes);
      expect(loadStaticSourceReadings(path)).toBeNull();
      expect(staticInputStanding(input(), loadStaticSourceReadings(path)).kind).toBe('held');
    }
    const captured = input();
    const readings = await preparedStaticReadings([captured]);
    saveStaticSourceReadings({ ...readings, readings: { [staticInputKey(captured)]: { answers: 'malformed evidence' } } }, path);
    expect(staticInputStanding(captured, loadStaticSourceReadings(path)).kind).toBe('held');
    const truncated = readFileSync(path);
    writeFileSync(path, truncated.subarray(0, truncated.length - 3));
    expect(loadStaticSourceReadings(path)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only settled current no observations clear an offline source input', async () => {
  const captured = input();
  const readings = await preparedStaticReadings([captured]);
  expect(staticInputStanding(captured, readings)).toEqual({ kind: 'clear' });
  expect(staticInputStanding(captured, null).kind).toBe('held');
  expect(parseStaticSourceReadings({ format: 1, readings: readings.readings })).toBeNull();
  const changed = captureStaticInputs('internal-identifier', captured.path, '// Changed source\nconst value = 3;')[0]!;
  expect(staticInputStanding(changed, readings).kind).toBe('held');
  expect(staticInputStanding({ ...captured, path: 'platform/src/another.ts' }, readings).kind).toBe('held');
});

test('weak no and uncertain observations stay held without changing their probabilities', async () => {
  for (const probability of [0.2, 0.5, 0.8]) {
    const captured = input();
    const readings = await preparedStaticReadings([captured], probability);
    expect(staticInputStanding(captured, readings).kind).toBe('held');
  }
});

test('a settled violation needs exact current canonical selector evidence', async () => {
  const captured = input();
  const readings = await preparedStaticReadings([captured], 0.99, 'line_2');
  expect(staticInputStanding(captured, readings)).toEqual({ kind: 'violation', anchor: captured.anchors[1]! });
  const receipt: unknown = readings.readings[staticInputKey(captured)];
  if (typeof receipt !== 'object' || receipt === null) throw new Error('Missing authored fixture receipt');
  expect(staticInputStanding(captured, { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, selection: null } } }).kind).toBe('held');
});

test('mismatched model, site, state or question evidence cannot clear a source input', async () => {
  const captured = input();
  const readings = await preparedStaticReadings([captured]);
  const receipt: unknown = readings.readings[staticInputKey(captured)];
  if (typeof receipt !== 'object' || receipt === null || !('presence' in receipt) || typeof receipt.presence !== 'object' || receipt.presence === null) throw new Error('Missing fixture presence');
  for (const [key, value] of [['observedModel', 'other-model'], ['requestedModel', 'other-model'], ['site', 'another-site'], ['state', { source: 'other-state' }], ['questions', { violation: noul('Different question.') }], ['version', 99]]) {
    expect(staticInputStanding(captured, { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, presence: { ...receipt.presence, [String(key)]: value } } } }).kind).toBe('held');
  }
});

test('a malformed artifact or non-probability answer stays held', async () => {
  expect(parseStaticSourceReadings({ format: 2, readings: [] })).toBeNull();
  const captured = input();
  const readings = await preparedStaticReadings([captured]);
  const receipt: unknown = readings.readings[staticInputKey(captured)];
  if (typeof receipt !== 'object' || receipt === null || !('presence' in receipt) || typeof receipt.presence !== 'object' || receipt.presence === null) throw new Error('Missing fixture presence');
  for (const noul of [-1, 1.1, '0.01', null]) {
    expect(staticInputStanding(captured, { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, presence: { ...receipt.presence, answers: { violation: { type: 'noul', noul } } } } } }).kind).toBe('held');
  }
});

test('windowing retains complete source lines and every offered anchor', () => {
  const text = Array.from({ length: 401 }, (_, index) => `// source line ${index + 1}`).join('\n');
  const inputs = captureStaticInputs('internal-identifier', 'docs/example.md', text,
    text.split('\n').map((line, index) => ({ id: `line_${index + 1}`, line: index + 1, col: 1, text: line })));
  expect(inputs.flatMap(captured => captured.anchors).map(anchor => anchor.line)).toEqual(Array.from({ length: 401 }, (_, index) => index + 1));
  expect(inputs[1]?.source).toContain('180| // source line 180');
  expect(inputs[0]?.source).toContain('181| // source line 181');
});

test('source windows fit the actual canonical selector without clipping evidence', async () => {
  const text = readFileSync(new URL('../bundle-budgets.json', import.meta.url), 'utf8');
  const inputs = captureStaticInputs('internal-identifier', 'bundle-budgets.json', text);
  const fixture = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.99) : noulAnswer(0.01));
  const port: JudgmentPort = { model: fixture.port.model, ask(request) {
    validateContextBudget(request.state, request.questions);
    return fixture.port.ask(request);
  } };
  for (const captured of inputs) await staticOffendingAnchor.select(port, staticSelectionContext(captured), staticSelectionCandidates(captured));
  expect(fixture.requests).toHaveLength(inputs.length);
  for (const captured of inputs) for (const anchor of captured.anchors) expect(captured.source).toContain(anchor.text);
  const huge = `const text = '${'x'.repeat(200_000)}';`;
  const captured = captureStaticInputs('internal-identifier', 'huge.ts', huge);
  expect(captured).toHaveLength(1);
  expect(captured[0]!.source).toBe(`1| ${huge}`);
});

test('unchanged deferred raw state and question evidence revalidates without a policy certificate', async () => {
  const captured = captureStaticInputs('deferred-work', 'source.ts', '// Intentional read-only adapter.')[0]!;
  const current = await preparedStaticReadings([captured]);
  const receipt = current.readings[staticInputKey(captured)];
  if (!object(receipt) || !object(receipt.presence)) throw new Error('Missing authored unit capture');
  const original = JSON.stringify(receipt);
  const retained = revalidateStaticInput(captured, current);
  expect(retained).toEqual(receipt);
  expect(staticInputStanding(captured, current)).toEqual({ kind: 'clear' });
  const changedQuestions = { ...current, readings: { [staticInputKey(captured)]: { ...receipt,
    presence: { ...receipt.presence, questions: { violation: noul('Different deferred policy question.') } } } } };
  expect(revalidateStaticInput(captured, changedQuestions)).toBeNull();
  expect(staticInputStanding(captured, changedQuestions).kind).toBe('held');
  expect(JSON.stringify(receipt)).toBe(original);
});

test('unchanged complete held deferred evidence keeps exact raw answers without another call', async () => {
  const captured = captureStaticInputs('deferred-work', 'source.ts', '// Intentional read-only adapter.')[0]!;
  const current = await preparedStaticReadings([captured], 0.5);
  const original = current.readings[staticInputKey(captured)];
  if (!object(original)) throw new Error('Missing authored held capture');
  const originalBytes = JSON.stringify(original);
  const retained = revalidateStaticInput(captured, current);
  expect(retained).not.toBeNull();
  const revalidated = { ...current, readings: { [staticInputKey(captured)]: retained } };
  expect(staticInputCaptureComplete(captured, revalidated)).toBe(true);
  expect(staticInputStanding(captured, revalidated).kind).toBe('held');
  const forbidden = fakePort(() => { throw new Error('Unchanged held evidence cannot be resampled'); });
  const result = await readCapturedInput(forbidden.port, captured, undefined, { previous: revalidated, onReceipt() {} });
  expect(forbidden.requests).toHaveLength(0);
  expect<unknown>(result.presence).toEqual(original.presence);
  expect<unknown>(result.selection).toEqual(original.selection);
  expect(JSON.stringify(original)).toBe(originalBytes);
});

test('a changed identifier question retains old raw measurements and measures the new question only once', async () => {
  expect(internalIdentifier.version).toBe(3);
  const boundary = INTERNAL_IDENTIFIER_INSTRUCTIONS.indexOf(' Judge the offered authored use in this repository,');
  expect(boundary).toBeGreaterThan(0);
  const legacyQuestion = INTERNAL_IDENTIFIER_INSTRUCTIONS.slice(0, boundary);
  for (const probability of [0.87, 0.86]) {
    const captured = input();
    const fixture = fakePort((name, question) => question.type === 'choice'
      ? choiceAnswer(question, 'none', 0.45) : noulAnswer(name === 'violation' ? probability : 0.01));
    const authored = await readCapturedInput(fixture.port, captured);
    if (!authored.selection) throw new Error('Missing authored selector measurement');
    const original = { ...authored,
      presence: { ...authored.presence, version: 2, questions: { violation: noul(legacyQuestion) } },
      selection: { ...authored.selection, state: toJson({ context: { ...staticSelectionContext(captured), rule: legacyQuestion },
        candidates: staticSelectionCandidates(captured) }) } };
    const originalBytes = JSON.stringify(original);
    const legacy: StaticSourceReadings = { format: 2, readings: { [staticInputKey(captured)]: original } };
    expect(revalidateStaticInput(captured, legacy)).toBeNull();
    expect(staticInputCaptureComplete(captured, legacy)).toBe(false);
    expect(staticInputStanding(captured, legacy).kind).toBe('held');
    const readings: Record<string, unknown> = { ...legacy.readings }, current = { ...legacy, readings };
    const replacement = fakePort(() => noulAnswer(0.01));
    const updated = await readCapturedInput(replacement.port, captured, undefined, {
      previous: current, onReceipt(value, receipt) { readings[staticInputKey(value)] = receipt; },
    });
    expect(replacement.requests).toHaveLength(1);
    expect(replacement.requests[0]?.questions).toHaveProperty('violation', internalIdentifier.items.violation.question);
    expect(updated.presence.version).toBe(3);
    expect(updated.previousCaptures).toEqual([original]);
    expect(JSON.stringify(original)).toBe(originalBytes);
    expect(original.presence.answers).toEqual({ violation: { type: 'noul', noul: probability } });
    expect(staticInputStanding(captured, current)).toEqual({ kind: 'clear' });
    const forbidden = fakePort(() => { throw new Error('Current answered question cannot repeat'); });
    await readCapturedInput(forbidden.port, captured, undefined, { previous: current, onReceipt() {} });
    expect(forbidden.requests).toHaveLength(0);
    expect(staticInputStanding(captured, legacy).kind).toBe('held');
  }
});

test('bounded semantic revision clears only when complete exact subsets each settle no', async () => {
  const captured = input();

  const fixture = fakePort((_name, _question, state) => {
    if (typeof state !== 'object' || state === null || !('anchors' in state) || !Array.isArray(state.anchors)) throw new Error('Unexpected fixture state');
    return noulAnswer(state.anchors.length > 1 ? 0.5 : 0.01);
  });
  const receipt = await readCapturedInput(fixture.port, captured);
  const readings = { format: 2, readings: { [staticInputKey(captured)]: receipt } } satisfies Parameters<typeof staticInputStanding>[1];
  expect(fixture.requests).toHaveLength(3);
  expect(fixture.requests.map(request => request.state)).toMatchObject([
    { source: captured.source, anchors: captured.anchors },
    { source: captured.source, anchors: [captured.anchors[0]] },
    { source: captured.source, anchors: [captured.anchors[1]] },
  ]);
  expect(staticInputStanding(captured, readings)).toEqual({ kind: 'clear' });
  expect(staticInputStanding(captured, { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, parts: receipt.parts.slice(0, 1) } } }).kind).toBe('held');
  expect(staticInputStanding(captured, { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, parts: [receipt.parts[1], receipt.parts[0]] } } }).kind).toBe('held');
});

test('exact raw observation revalidation rejects changed input, state and questions without changing evidence', async () => {
  const captured = input(), current = await preparedStaticReadings([captured]);
  const receipt = current.readings[staticInputKey(captured)];
  if (!object(receipt) || !object(receipt.presence)) throw new Error('Missing raw capture');
  const original = JSON.stringify(receipt);
  expect(revalidateStaticInput(captured, current)).toEqual(receipt);
  expect(revalidateStaticInput({ ...captured, source: captured.source + '\nchanged' }, current)).toBeNull();
  for (const presence of [
    { ...receipt.presence, state: { source: 'changed original body' } },
    { ...receipt.presence, questions: { violation: noul('A different question.') } },
  ]) {
    const changed = { ...current, readings: { [staticInputKey(captured)]: { ...receipt, presence } } };
    expect(revalidateStaticInput(captured, changed)).toBeNull();
    expect(staticInputStanding(captured, changed).kind).toBe('held');
  }
  const weak = await preparedStaticReadings([captured], 0.2), retainedWeak = revalidateStaticInput(captured, weak);
  expect(retainedWeak).not.toBeNull();
  expect(staticInputStanding(captured, { ...weak, readings: { [staticInputKey(captured)]: retainedWeak } }).kind).toBe('held');
  expect(JSON.stringify(receipt)).toBe(original);
});

test('streaming checkpoints match native complete JSON values and ordered histories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'static-checkpoint-stream-equivalence-'));
  const text = String.raw`{"format":2,"readingPlanVersion":3,"readings":{"original":{"old":true},"__proto__":{"kept":true},"replace":{"history":[{"answers":{"violation":{"type":"noul","noul":0.9876543210987654}}},null]},"numbers":[0,-0,1e-3,1e400],"escaped":"quote\" slash\\ control\b\f\n\r\t unicode\ud800\ud83d\ude00"},"ignored":{"also":"validated"}}`;
  try {
    const expected = parseStaticSourceReadings(JSON.parse(text));
    for (const size of [1, 2, 7, 61, 64 * 1024]) {
      const reader = new CheckpointValueReader();
      for (let at = 0; at < text.length; at += size) reader.feed(text.slice(at, at + size));
      const actual = reader.finish();
      expect(actual).toEqual(expected);
      expect(Object.hasOwn(actual!.readings, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(actual!.readings)).toBe(Object.prototype);
      const numbers = actual!.readings.numbers as readonly number[];
      expect(Object.is(numbers[1], -0)).toBe(true);
      expect(numbers[3]).toBe(Infinity);
    }
    for (const extension of ['.json', '.json.gz']) {
      const path = join(root, `checkpoint${extension}`);
      writeFileSync(path, extension.endsWith('.gz') ? gzipSync(text) : text);
      expect(await loadStaticSourceCheckpoint(path)).toEqual(loadStaticSourceReadings(path));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discarded metadata validates without scalar storage', () => {
  const large = 'x'.repeat(STATIC_CHECKPOINT_MAX_SCALAR_CHARS + 65536);
  const texts = [
    `{"format":2,"readings":{},"ignored":${JSON.stringify(large)}}`,
    `{"format":2,"readings":{},${JSON.stringify(large)}:{"nested":[${JSON.stringify(large)},123.5e-2,true,null]}}`,
  ];
  for (const text of texts) {
    const reader = new CheckpointValueReader();
    for (let at = 0; at < text.length; at += 4093) reader.feed(text.slice(at, at + 4093));
    expect(reader.finish()).toEqual(parseStaticSourceReadings(JSON.parse(text)));
  }
});

test('streaming checkpoints refuse every damaged complete-document boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'static-checkpoint-stream-refusal-'));
  try {
    const path = join(root, 'checkpoint.json');
    const valid = '{"format":2,"readings":{"nested":[{"escaped":"a\\\"b","n":-0.125e+2},false]}}';
    for (let at = 0; at < valid.length; at++) {
      writeFileSync(path, valid.slice(0, at));
      expect(await loadStaticSourceCheckpoint(path)).toBeNull();
    }
    for (const text of [
      valid + ' trailing', valid + valid,
      '{"format":2,"readings":{},"readings":{"last":true}}',
      '{"format":2,"readings":{"entry":0,"entry":1}}',
      '{"format":2,"readings":{},}',
      '{"format":2,"readings":{},"ignored":[1,]}',
      '{"format":2,"readings":{},"ignored":{"x":"\\q"}}',
      '{"format":2,"readings":{},"ignored":{"x":"\\uQQQQ"}}',
      '{"format":2,"readings":{},"ignored":01}',
      '{"format":2,"readings":{},"ignored":1.}',
      '{"format":2,"readings":{},"ignored":1e+}',
      '{"format":2,"readings":{},"ignored":trux}',
      '{"format":2,"readings":[true]}',
      '{"format":2,"readingPlanVersion":4,"readings":{}}',
      '{"format":2,"readings":null}',
    ]) {
      writeFileSync(path, text);
      expect(await loadStaticSourceCheckpoint(path)).toEqual(loadStaticSourceReadings(path));
      expect(await loadStaticSourceCheckpoint(path)).toBeNull();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('streaming plain and gzip checkpoints preserve split text and refuse compressed corruption', async () => {
  const root = mkdtempSync(join(tmpdir(), 'static-checkpoint-stream-text-'));
  try {
    const prefix = '{"format":2,"readings":{"text":"';
    const padding = 'a'.repeat(64 * 1024 - Buffer.byteLength(prefix) - 1);
    const bytes = Buffer.from(`${prefix}${padding}😀é"}}`);
    const malformed = Buffer.concat([Buffer.from(prefix), Buffer.from([0xc3, 0x28]), Buffer.from('"}}')]);
    for (const content of [bytes, malformed]) for (const extension of ['.json', '.json.gz']) {
      const path = join(root, `checkpoint${extension}`);
      writeFileSync(path, extension.endsWith('.gz') ? gzipSync(content) : content);
      expect(await loadStaticSourceCheckpoint(path)).toEqual(loadStaticSourceReadings(path));
    }
    const gzipPath = join(root, 'damaged.json.gz');
    const encoded = gzipSync(bytes);
    const corrupt = Buffer.from(encoded); corrupt[corrupt.length - 5] = corrupt[corrupt.length - 5]! ^ 0xff;
    for (const content of [Buffer.from('not compressed'), encoded.subarray(0, 7), encoded.subarray(0, encoded.length - 1), corrupt]) {
      writeFileSync(gzipPath, content);
      expect(await loadStaticSourceCheckpoint(gzipPath)).toBeNull();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('streaming retained-scalar capacity refuses the complete checkpoint without changing bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'static-checkpoint-stream-capacity-'));
  try {
    const path = join(root, 'checkpoint.json');
    const text = JSON.stringify({ format: 2, readings: { oversized: 'x'.repeat(STATIC_CHECKPOINT_MAX_SCALAR_CHARS + 1) } });
    writeFileSync(path, text);
    expect(await loadStaticSourceCheckpoint(path)).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(text);
    const below = JSON.stringify({ format: 2, readings: { exact: 'x'.repeat(STATIC_CHECKPOINT_MAX_SCALAR_CHARS) } });
    writeFileSync(path, below);
    expect(await loadStaticSourceCheckpoint(path)).toEqual(loadStaticSourceReadings(path));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('streaming checkpoint resumes original complete held evidence without another call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'static-checkpoint-stream-held-'));
  try {
    const captured = input();
    const previous = await preparedStaticReadings([captured], 0.4);
    const path = join(root, 'checkpoint.json');
    saveStaticSourceReadings(previous, path);
    const restored = await loadStaticSourceCheckpoint(path);
    expect(restored).toEqual(previous);
    if (!restored) throw new Error('Missing complete checkpoint');
    expect(staticInputCaptureComplete(captured, restored)).toBe(true);
    expect(staticInputStanding(captured, restored).kind).toBe('held');

    const forbidden = fakePort(() => { throw new Error('Complete unchanged held evidence must not be dispatched'); });
    const receipt = await readCapturedInput(forbidden.port, captured, undefined, { previous: restored, onReceipt() {} });
    expect((Object.values(previous.readings)[0] as { presence: unknown }).presence).toEqual(receipt.presence);
    expect(forbidden.requests).toHaveLength(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cancellation or original input retirement during a provider await cannot publish a raw cache receipt', async () => {
  for (const retirement of ['cancel', 'source'] as const) {
    const captured = { ...input() }, original = structuredClone(captured), controller = new AbortController();
    let release!: () => void, entered!: () => void, publications = 0;
    const held = new Promise<void>(resolve => { release = resolve; }), admitted = new Promise<void>(resolve => { entered = resolve; });
    const fixture = fakePort(() => noulAnswer(0.01));
    const recorded = createStaticCallRecorder({ ...fixture.port, async ask(request) {
      entered(); await held; return fixture.port.ask(request);
    } });
    const reading = readStaticInput(recorded.port, recorded.capture, captured, controller.signal, {
      previous: { format: 2, readings: {} }, onReceipt() { publications++; },
    });
    try {
      await Promise.race([admitted, reading.then(() => { throw new Error('Read settled before its provider seam'); })]);
      const reason = new Error('Original unit owner cancelled');
      if (retirement === 'cancel') controller.abort(reason);
      else captured.source += '\nChanged while awaiting the provider.';
      release();
      if (retirement === 'cancel') await expect(reading).rejects.toBe(reason);
      else await expect(reading).rejects.toThrow('Static input changed during reading');
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]?.state).toHaveProperty('source', original.source);
      expect(recorded.calls).toHaveLength(0); expect(publications).toBe(0);
    } finally { release(); await reading.catch(() => undefined); }
  }
});

test('a receipt callback cannot mutate a nested subset and continue to another model request', async () => {
  const captured = input(), original = structuredClone(captured);
  const fixture = fakePort((_name, _question, state) => {
    if (!object(state) || !Array.isArray(state.anchors)) throw new Error('Missing original anchors');
    return noulAnswer(state.anchors.length > 1 ? 0.5 : 0.01);
  });
  let callbacks = 0;
  await expect(readCapturedInput(fixture.port, captured, undefined, {
    previous: { format: 2, readings: {} }, onReceipt(source) {
      callbacks++;
      if (source.anchors.length === 1) Object.defineProperty(source, 'source', { value: 'Changed nested original context.' });
    },
  })).rejects.toThrow('Static subset changed during reading');
  expect(callbacks).toBe(2); expect(fixture.requests).toHaveLength(2);
  expect(captured).toEqual(original);
});
