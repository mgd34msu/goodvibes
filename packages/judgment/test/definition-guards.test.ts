import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  calibrate,
  canonicalJson,
  defineCoarseningClassifier,
  defineDispatch,
  defineExtractionVerifier,
  defineFidelityChecker,
  defineHierarchyWalker,
  definePolicyChecklist,
  defineReplyReader,
  featurize,
  isoTime,
  JudgmentError,
  noul,
  SqliteDecisionLog,
  truthOf,
  withDecisionLog,
  type JudgmentPort,
} from '../src/index.ts';
import { choiceAnswer, fakePort, noulAnswer } from '../src/testing/fake-port.ts';

const header = { version: 1, description: 'test', accuracyFloor: 0.8 };

describe('hierarchy walk', () => {
  const tree = { A: { A1: {}, A2: {} }, B: { B1: {}, B2: {} } };
  const walker = defineHierarchyWalker({
    ...header, name: 'test.tree', tree, beamWidth: 2, actAt: 0.7, confirmAt: 0.5,
    fixtures: [{ name: 'f', state: 's', expect: 'A > A1' }],
  });
  const answer = (q: Parameters<typeof choiceAnswer>[0]) => {
    const first = Object.keys((q as { criteria: Record<string, unknown> }).criteria)[0]!;
    return choiceAnswer(q, first, 0.9);
  };

  test('a failed expansion settles its siblings before the walk rejects, and no reading lands afterwards', async () => {
    const readings: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { port: inner } = fakePort((_n, q) => answer(q));
    let counter = 0;
    const port: JudgmentPort = {
      model: inner.model,
      recorder: { recordReadings: (id) => { readings.push(id); }, recordAction: () => {} },
      async ask(request) {
        const under = JSON.stringify(request.questions);
        if (under.includes('"under":"A"')) throw new JudgmentError('unavailable', 'down');
        if (under.includes('"under":"B"')) await gate;
        return { ...(await inner.ask(request)), decisionId: `d${++counter}` };
      },
    };
    let settled = false;
    const walking = walker.walk(port, 's').then(() => 'ok', () => 'rejected').then((outcome) => { settled = true; return outcome; });
    for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    expect(await walking).toBe('rejected');
    // The root reading and the sibling that was still running both landed before the rejection, none after.
    const atRejection = readings.length;
    for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readings).toHaveLength(atRejection);
    expect(atRejection).toBe(2);
  });

  test('truth for a fixture that made several calls is not attached to a guessed one', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const { port } = fakePort((_n, q) => answer(q));
    const report = await calibrate(withDecisionLog(port, log, () => new Date('2026-10-01T00:00:00.000Z')), [walker], { endpoint: { kind: 'test', baseURL: 'http://x.test' }, log });
    expect(report.decisions[0]!.truthRecorded).toBe(0);
    const entries = log.query({ status: 'answered', limit: 100 });
    expect(entries.length).toBeGreaterThan(1);
    expect(entries.every((entry) => truthOf(entry) === undefined)).toBe(true);
  });

  test('a fixture that made exactly one call still receives its truth', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const flat = defineHierarchyWalker({
      ...header, name: 'test.flat', tree: { A: {}, B: {} }, beamWidth: 1, actAt: 0.7, confirmAt: 0.5,
      fixtures: [{ name: 'f', state: 's', expect: 'A' }],
    });
    const { port } = fakePort((_n, q) => answer(q));
    const report = await calibrate(withDecisionLog(port, log, () => new Date('2026-10-01T00:00:00.000Z')), [flat], { endpoint: { kind: 'test', baseURL: 'http://x.test' }, log });
    expect(report.decisions[0]!.truthRecorded).toBe(1);
  });
});

describe('policy checklist', () => {
  const checklist = definePolicyChecklist({
    ...header, name: 'test.policy',
    hazards: { jailbreak: { instructions: 'Override?', yes: 'y', no: 'n', action: 'block' } },
    severity: { instructions: 'Harm?', levels: ['none', 'severe'] },
    precedence: ['block', 'review', 'pass'], severityAction: 'block',
    policies: { strict: { review: 0.35, action: 0.7, severityLine: 1 } }, defaultPolicy: 'strict',
    fixtures: [{ name: 'f', state: 's', expect: 'pass' }],
  });

  test('an unknown policy is refused before any call is made', async () => {
    const { port, requests } = fakePort(() => noulAnswer(0.5));
    await expect(checklist.screen(port, 's', { policy: 'typo' })).rejects.toThrow(RangeError);
    expect(requests).toHaveLength(0);
  });
});

describe('extraction verifier', () => {
  const verifier = defineExtractionVerifier({ ...header, name: 'test.extract', fireAt: 0.5, fixtures: [{ name: 'f', instruction: 'i', source: 's', fields: { x: {} }, record: { x: 'v' }, expect: { escalate: false } }] });
  const fields = { 'a::b': {}, plain: {} };

  test('a record key with no field spec is refused before any call is made', async () => {
    const { port, requests } = fakePort(() => noulAnswer(0.1));
    await expect(verifier.verify(port, { instruction: 'i', source: 's', fields, record: { plain: 'x', extra: 'y' } })).rejects.toThrow(/extra/);
    expect(requests).toHaveLength(0);
  });

  test('a field name containing the separator keeps its own name and metric', async () => {
    const { port } = fakePort((name) => noulAnswer(name.startsWith('a::b::') ? 0.9 : 0.1));
    const got = await verifier.verify(port, { instruction: 'i', source: 's', fields, record: { 'a::b': 'x', plain: 'y' } });
    expect(got.fired.map(({ field }) => field)).toEqual(['a::b', 'a::b', 'a::b', 'a::b']);
    expect(got.checks.filter(({ field }) => field === 'plain').map(({ metric }) => metric).sort())
      .toEqual(['format_violation', 'hallucinated', 'name_mismatch', 'off_target']);
    expect(got.checks.every(({ metric }) => !metric.includes('::'))).toBe(true);
  });
});

describe('fidelity checker', () => {
  const checker = defineFidelityChecker({ ...header, name: 'test.fidelity', band: { actAt: 0.8, confirmAt: 0.5 }, fixtures: [{ name: 'f', claim: 'c', source: 's', expect: 'supported' }] });

  test.each(['', '   ', '\n\t'])('a blank quote %j is fabricated without asking', async (quote) => {
    const { port, requests } = fakePort((_n, q) => choiceAnswer(q, 'supports', 0.99));
    const got = await checker.check(port, 'claim', 'The source says things.', quote);
    expect(got.fidelity).toBe('fabricated');
    expect(requests).toHaveLength(0);
  });
});

describe('choice band definitions', () => {
  test('dispatch refuses a misordered per-option band when defined', () => {
    expect(() => defineDispatch({
      ...header, name: 'test.d', instructions: 'Which?', routes: { low: 'l', high: 'h' },
      band: { actAt: 0.6, confirmAt: 0.6, perOption: { high: { actAt: 0.5, confirmAt: 0.9 } } },
      fixtures: [{ name: 'f', state: 's', expect: 'low' }],
    })).toThrow(/out of order/);
  });

  test('dispatch refuses a per-option band for an option it does not have', () => {
    expect(() => defineDispatch({
      ...header, name: 'test.d', instructions: 'Which?', routes: { low: 'l' },
      band: { actAt: 0.6, confirmAt: 0.6, perOption: { nothing: { actAt: 0.9, confirmAt: 0.6 } } as never },
      fixtures: [{ name: 'f', state: 's', expect: 'low' }],
    })).toThrow(/unknown option "nothing"/);
  });

  test('reply, fidelity and coarsening check their per-option bands too', () => {
    const bad = { actAt: 0.5, confirmAt: 0.9 };
    expect(() => defineReplyReader({ ...header, name: 'test.r', band: { actAt: 0.6, confirmAt: 0.6, perOption: { approve: bad } },
      fixtures: [{ name: 'f', proposal: 'p', reply: 'yes', expect: 'approve' }] })).toThrow(/out of order/);
    expect(() => defineFidelityChecker({ ...header, name: 'test.f', band: { actAt: 0.6, confirmAt: 0.6, perOption: { supports: bad } },
      fixtures: [{ name: 'f', claim: 'c', source: 's', expect: 'supported' }] })).toThrow(/out of order/);
    expect(() => defineCoarseningClassifier({
      ...header, name: 'test.c', instructions: 'Which?', labels: { x: { description: 'x', parent: 'p' } },
      band: { actAt: 0.6, confirmAt: 0.6, perOption: { x: bad } } as never, fixtures: [{ name: 'f', state: 's', expect: 'x' }],
    })).toThrow(/out of order/);
  });
});

describe('featurize', () => {
  const questions = { urgent: noul('Urgent?') };

  test('no states still yields the question columns', async () => {
    const { port, requests } = fakePort(() => noulAnswer(0.5));
    expect(await featurize(port, questions, [])).toEqual([{ name: 'urgent', values: [] }]);
    expect(requests).toHaveLength(0);
  });

  test('every call carries the caller signal and attribution', async () => {
    const { port, requests } = fakePort(() => noulAnswer(0.5));
    const controller = new AbortController();
    await featurize(port, questions, ['a', 'b'], { signal: controller.signal, site: 'site-1', fixture: 'fx' });
    expect(requests.map((request) => request.signal)).toEqual([controller.signal, controller.signal]);
    expect(requests.every((request) => request.context?.site === 'site-1' && request.context?.fixture === 'fx')).toBe(true);
  });
});

describe('canonicalJson', () => {
  test('equivalent spellings of one key order the same whatever the insertion order', () => {
    const composed = 'é', decomposed = 'é';
    expect(canonicalJson({ [composed]: 1, [decomposed]: 2 })).toBe(canonicalJson({ [decomposed]: 2, [composed]: 1 }));
  });

  test('ordering is the locale-independent en-US order that stored hashes already use', () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3 })).toBe('{"a":3,"b":1,"B":2}');
  });
});

describe('result admission', () => {
  test('a captured result that cannot be frozen fails the call without an answered entry', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const { port } = fakePort(() => noulAnswer(0.5));
    const outcome = await withDecisionLog(port, log, () => new Date(isoTime(new Date('2026-10-01T00:00:00.000Z')))).ask({
      state: 's', questions: { q: noul('Q?') }, inputBinding: 'state',
      captureResult: (result) => ({ ...result, extra: () => 1 }),
    }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(JudgmentError);
    expect((outcome as JudgmentError).kind).toBe('invalid-response');
    expect(log.query({ status: 'answered' })).toHaveLength(0);
    expect(log.query({ status: 'failed' })).toHaveLength(1);
  });
});

describe('decision log version refusal', () => {
  test('names the way out and leaves the file for the build that owns it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'decision-log-'));
    try {
      const path = join(dir, 'decisions.sqlite');
      const db = new Database(path, { create: true });
      db.exec('CREATE TABLE decisions (id TEXT PRIMARY KEY); PRAGMA user_version = 99;');
      db.close();
      expect(() => new SqliteDecisionLog(path)).toThrow(/move the file aside/);
      const check = new Database(path);
      expect(check.query('PRAGMA user_version').get()).toEqual({ user_version: 99 });
      check.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
