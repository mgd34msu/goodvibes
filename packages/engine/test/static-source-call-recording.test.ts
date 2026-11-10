import * as crypto from 'node:crypto';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { STAKES_BANDS, yesNo, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createStaticCallRecorder, openStaticCallLog } from '../scripts/static-source-call-recording.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function request() {
  return { state: { source: 'The original complete declaration.' },
    questions: { violation: yesNo('Does this declaration contain deferred work?', STAKES_BANDS.high.yesNo).question },
    context: { battery: 'synthetic.static-capture', batteryVersion: 1, site: 'synthetic.static-tooling' } };
}

test('saves actual detached request and answer with attribution and no SHA calls', async () => {
  const fake = fakePort(() => noulAnswer(0.01)), captured = createStaticCallRecorder(fake.port), original = request();
  const hashing = spyOn(crypto, 'createHash');
  try {
    const result = await captured.port.ask(original);
    const evidence = captured.capture.get(result.decisionId!);
    expect(evidence?.state).toEqual(original.state);
    expect(evidence?.questions).toEqual(original.questions);
    expect(evidence?.answers).toEqual(result.answers);
    expect(evidence?.requestedModel).toBe(fake.port.model);
    expect(evidence?.observedModel).toBe('jev-1.13.0');
    original.state.source = 'Changed after the actual call';
    expect(evidence?.state).toEqual({ source: 'The original complete declaration.' });
    expect(hashing.mock.calls.filter(call => call[0] === 'sha256')).toHaveLength(0);
  } finally { hashing.mockRestore(); }
});

test('refuses borrowed request accessors without invoking them or the provider', async () => {
  const fake = fakePort(() => noulAnswer(0.01)), captured = createStaticCallRecorder(fake.port);
  let invoked = false;
  const value = { ...request(), get state() { invoked = true; return {}; } };
  await expect(captured.port.ask(value)).rejects.toMatchObject({ kind: 'invalid-request' });
  expect(invoked).toBe(false); expect(fake.requests).toHaveLength(0); expect(captured.calls).toHaveLength(0);
});

test('retired original owner cannot publish a completed provider answer', async () => {
  const fake = fakePort(() => noulAnswer(0.01)); let current = true;
  const inner: JudgmentPort = { ...fake.port, async ask(value) { const answer = await fake.port.ask(value); current = false; return answer; } };
  const captured = createStaticCallRecorder(inner);
  await expect(captured.port.ask({ ...request(), assertLogCurrent() { if (!current) throw new Error('retired'); } })).rejects.toThrow('retired');
  expect(fake.requests).toHaveLength(1); expect(captured.calls).toHaveLength(0);
});

test('drains rejected asynchronous output and refuses publication', async () => {
  const fake = fakePort(() => noulAnswer(0.01));
  const captured = createStaticCallRecorder(fake.port, () => Promise.reject(new Error('rejected owned output')));
  await expect(captured.port.ask(request())).rejects.toMatchObject({ kind: 'unrecorded' });
  expect(captured.calls).toHaveLength(0);
});

test('JSON Lines appends actual metering and refuses an existing foreign log without altering it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'static-source-call-log-')); roots.push(root);
  const path = join(root, 'calls.jsonl'), foreign = join(root, 'foreign.sqlite');
  writeFileSync(foreign, 'SQLite format 3\0original bytes'); const before = readFileSync(foreign);
  expect(() => openStaticCallLog(foreign)).toThrow('JSON Lines'); expect(readFileSync(foreign)).toEqual(before);
  const alias = join(root, 'alias.jsonl'); symlinkSync(foreign, alias);
  expect(() => openStaticCallLog(alias)).toThrow(); expect(readFileSync(foreign)).toEqual(before);
  {
    using log = openStaticCallLog(path);
    const captured = createStaticCallRecorder(fakePort(() => noulAnswer(0.01)).port, log.write);
    await captured.port.ask(request());
  }
  const lines = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(lines[0]).toEqual({ format: 'static-source-calls', version: 1 });
  expect(lines[1].usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  expect(lines[1].call.state).toEqual(request().state);
});
