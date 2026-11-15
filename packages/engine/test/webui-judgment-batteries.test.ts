import { describe, expect, test } from 'bun:test';
import {
  withDecisionLog, type DecisionEntry, type DecisionId, type DecisionLog,
  type DecisionNote, type JudgmentPort, type NewDecisionEntry,
} from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { daemonRefusalBattery, mailReplySubjectBattery, WEBUI_BATTERY_QUESTIONS } from '../platform/src/platform/judgment-browser/batteries/webui-specs.ts';
import { readStructuredDaemonRefusal } from '../platform/src/platform/judgment-browser/batteries/webui-readers.ts';
import { webuiDaemonRefusalAdapter } from '../platform/src/platform/judgment-browser/batteries/webui-adapters.ts';
import { REFUSAL_ITEMS, type ResolvedDaemonRefusal } from '../platform/src/platform/judgment-browser/batteries/webui-types.ts';

const refusal = (message: string, status = 404): ResolvedDaemonRefusal => ({ methodId: 'sessions.delete', message, status });
const readyFalse = { session_not_found: false, session_closed: false, session_active: false, session_not_local: false, method_unknown: false };
function memoryLog() {
  const entries: NewDecisionEntry[] = [];
  const notes: { id: string; note: DecisionNote }[] = [];
  const log: DecisionLog = {
    record(entry) { entries.push(entry); return `decision-${entries.length}` as DecisionId; },
    attach(id, note) { notes.push({ id, note }); },
    get() { return undefined; }, query() { return [] as DecisionEntry[]; },
  };
  return { log, entries, notes };
}
function configured(answer: Parameters<typeof fakePort>[0]) {
  const fake = fakePort(answer);
  const recording = memoryLog();
  return { ...fake, ...recording, port: withDecisionLog(fake.port, recording.log) };
}

const never = (): never => { throw new Error('must not call'); };
/** What the service does with one adapter: read, project, then retain the action. */
interface Adapter<S, R, P> {
  run(port: JudgmentPort, state: S, options: { readonly signal: AbortSignal }): Promise<R>;
  project(run: R): P;
  record?(run: R, projection: P): void;
}
async function judge<S, R, P>(adapter: Adapter<S, R, P>, port: JudgmentPort, state: S, signal = new AbortController().signal): Promise<P> {
  const run = await adapter.run(port, state, { signal });
  const projection = adapter.project(run);
  adapter.record?.(run, projection);
  return projection;
}
const refuse = <S>(adapter: { run(port: JudgmentPort, state: S, options: { readonly signal: AbortSignal }): Promise<unknown> }, port: JudgmentPort, state: unknown, signal = new AbortController().signal) =>
  adapter.run(port, state as S, { signal });
const outcomes = (projection: { readings: Readonly<Record<string, { outcome: string }>> }) => Object.values(projection.readings).map((reading) => reading.outcome);
const held = { code: 'JUDGMENT_INPUT_HELD' };

describe('fixed WebUI batteries', () => {
  test('IDs, versions and complete fixed question maps match the registrations', () => {
    expect([daemonRefusalBattery, mailReplySubjectBattery].map(({ name, version }) => [name, version])).toEqual([
      ['webui.errors.daemon-refusal', 1], ['webui.mail.reply-subject', 1],
    ]);
    expect(Object.keys(WEBUI_BATTERY_QUESTIONS[daemonRefusalBattery.name]!)).toEqual([...REFUSAL_ITEMS]);
    expect(Object.keys(WEBUI_BATTERY_QUESTIONS[mailReplySubjectBattery.name]!)).toEqual(['already_reply']);
  });

  test('calibration fixtures state the readings a human would give, independent of the fixtures themselves', () => {
    // The replay below can only prove plumbing; these are the hard cases written out by hand, so a
    // wrong fixture expectation (the thing calibration exists to catch) fails here.
    const none = { session_not_found: 'no', session_closed: 'no', session_active: 'no', session_not_local: 'no', method_unknown: 'no' };
    const hand: [typeof daemonRefusalBattery | typeof mailReplySubjectBattery, string, Record<string, string>][] = [
      [daemonRefusalBattery, 'missing session', { ...none, session_not_found: 'yes' }],
      [daemonRefusalBattery, 'negated active state', none],
      [daemonRefusalBattery, 'quoted troubleshooting is not current refusal', none],
      [daemonRefusalBattery, 'method wording without required status', none],
      [daemonRefusalBattery, 'runtime on another daemon', { ...none, session_not_local: 'yes' }],
      [mailReplySubjectBattery, 'Replies due tomorrow', { already_reply: 'no' }],
      [mailReplySubjectBattery, 'Antw: Lunch?', { already_reply: 'yes' }],
    ];
    for (const [battery, name, expected] of hand) {
      expect(battery.fixtures.find((fixture) => fixture.name === name)?.expect, `${battery.name}: ${name}`).toEqual(expected);
    }
  });

  test('synthetic calibration fixtures cover negation and missing resources', async () => {
    // Fixture-driven answer replay checks plumbing and coverage, not live accuracy.
    for (const battery of [daemonRefusalBattery, mailReplySubjectBattery]) {
      const expectations = new Map(battery.fixtures.map((fixture) => [JSON.stringify(fixture.state), fixture.expect]));
      const { port } = fakePort((name, question, state) => {
        const expected = expectations.get(JSON.stringify(state)) as Record<string, string> | undefined;
        return question.type === 'noul' ? noulAnswer(expected?.[name] === 'yes' ? 0.99 : 0.01) : choiceAnswer(question, expected?.[name] ?? '', 0.99);
      });
      const checks = await battery.checkFixtures(port);
      expect(checks.length).toBeGreaterThanOrEqual(battery.fixtureCount);
      expect(checks.every((check) => check.correct && check.outcome === 'act')).toBe(true);
    }
    expect(daemonRefusalBattery.fixtures.some((fixture) => fixture.name === 'attachment absent but session exists')).toBe(true);
  });
});

describe('daemon refusal', () => {
  test('caller-side exact codes override prose without probabilities or decision IDs', () => {
    for (const [code, item] of [['SESSION_NOT_FOUND', 'session_not_found'], ['SESSION_CLOSED', 'session_closed'], ['SESSION_ACTIVE', 'session_active'], ['SESSION_NOT_LOCAL', 'session_not_local'], ['METHOD_NOT_FOUND', 'method_unknown']] as const) {
      const result = readStructuredDaemonRefusal({ ...refusal('Unrelated contradictory explanation'), code });
      expect(result).toEqual({ status: 'ready', basis: 'structured', value: { ...readyFalse, [item]: true } });
      expect(JSON.stringify(result)).not.toContain('probabilit');
      expect(result).not.toHaveProperty('decisionIds');
    }
    expect(readStructuredDaemonRefusal({ ...refusal('Unknown gateway method', 500), code: 'METHOD_NOT_FOUND' })).toEqual({ status: 'ready', basis: 'structured', value: readyFalse });
  });

  test('the adapter holds known structural cases without a port call or fabricated reading', async () => {
    const fake = configured(never);
    const known = [
      ...['SESSION_NOT_FOUND', 'SESSION_CLOSED', 'SESSION_ACTIVE', 'SESSION_NOT_LOCAL', 'METHOD_NOT_FOUND', 'NO_ACTIVE_TURN', 'CONFLICT', 'IMAP_AUTH_FAILED', 'SMTP_AUTH_FAILED'].map((code) => ({ ...refusal('Unrelated contradictory explanation'), code })),
      { ...refusal('Unknown gateway method', 500), code: 'METHOD_NOT_FOUND' },
      refusal('session closed', 401), refusal('session closed', 0),
      { ...refusal('session closed'), category: 'network' as const },
    ];
    for (const source of known) await expect(refuse(webuiDaemonRefusalAdapter, fake.port, source)).rejects.toMatchObject(held);
    expect(fake.requests).toHaveLength(0);
    expect(fake.entries).toHaveLength(0);
    expect(fake.notes).toHaveLength(0);
  });

  test('known auth/network and non-session wire codes remain deterministic', () => {
    for (const source of [{ ...refusal('session not found'), code: 'CONFLICT' }, { ...refusal('session is active'), code: 'NO_ACTIVE_TURN' }, { ...refusal('session closed'), code: 'IMAP_AUTH_FAILED' }, { ...refusal('session closed'), code: 'SMTP_AUTH_FAILED' }, refusal('session closed', 401), refusal('session closed', 0), { ...refusal('session closed'), category: 'network' as const }]) {
      expect(readStructuredDaemonRefusal(source)).toEqual({ status: 'ready', value: readyFalse, basis: 'structured' });
    }
    expect(readStructuredDaemonRefusal(refusal('Unknown gateway method'))).toBeUndefined();
  });

  test('one request reads five facts; non-404 excludes method_unknown and fixes it false', async () => {
    const fake = configured((name) => noulAnswer(name === 'session_not_local' ? 0.98 : 0.02));
    const source = refusal('This daemon does not host a live runtime for the existing session.');
    expect(readStructuredDaemonRefusal(source)).toBeUndefined();
    const result = await judge(webuiDaemonRefusalAdapter, fake.port, source);
    expect(result).toMatchObject({ status: 'settled', value: { ...readyFalse, session_not_local: true } });
    expect(fake.requests).toHaveLength(1);
    expect(Object.keys(fake.requests[0]!.questions)).toEqual([...REFUSAL_ITEMS]);
    expect(fake.entries).toHaveLength(1);
    expect(fake.entries[0]).toMatchObject({ status: 'answered', context: { battery: 'webui.errors.daemon-refusal', batteryVersion: 1 } });
    expect(fake.notes.find(({ note }) => note.kind === 'readings')?.note).toMatchObject({ kind: 'readings', readings: { session_not_local: { kind: 'yes-no', probability: 0.98, verdict: 'yes', outcome: 'act' } } });
    expect(fake.notes.find(({ note }) => note.kind === 'action')?.note).toMatchObject({ kind: 'action', action: 'ready' });
    const other = configured(() => noulAnswer(0.01));
    expect(await judge(webuiDaemonRefusalAdapter, other.port, refusal('Unknown gateway method', 500))).toMatchObject({ status: 'settled', value: readyFalse, structuralBasis: { method_unknown: 'http-status-not-404' } });
    expect(Object.keys(other.requests[0]!.questions)).not.toContain('method_unknown');
  });

  test('semantic answers decide, contrary to the old substring rules', async () => {
    const fake = configured(() => noulAnswer(0.01));
    expect(await judge(webuiDaemonRefusalAdapter, fake.port, refusal('The session was found; its attachment was not found.'))).toMatchObject({ status: 'settled', value: readyFalse });
    expect(await judge(webuiDaemonRefusalAdapter, fake.port, refusal('No session is active. Storage unavailable.', 500))).toMatchObject({ status: 'settled', value: readyFalse });
    expect(fake.requests).toHaveLength(2);
  });

  test('confirm and escalate remain distinct, with no executable value', async () => {
    for (const [probability, outcome] of [[0.8, 'confirm'], [0.5, 'escalate']] as const) {
      const fake = configured((name) => noulAnswer(name === 'session_closed' ? probability : 0.01));
      const result = await judge(webuiDaemonRefusalAdapter, fake.port, refusal('Ambiguous current failure'));
      expect(result).toMatchObject({ status: 'held', reason: 'uncertain' });
      expect(result).not.toHaveProperty('value');
      expect(outcomes(result).filter((each) => each !== 'act')).toEqual([outcome]);
    }
    const mixed = configured((name) => noulAnswer(name === 'session_closed' ? 0.8 : name === 'session_active' ? 0.5 : 0.01));
    expect(outcomes(await judge(webuiDaemonRefusalAdapter, mixed.port, refusal('Mixed evidence'))).filter((each) => each !== 'act').sort()).toEqual(['confirm', 'escalate']);
  });

  test('conflicting acted facts escalate, but locality alone is not a missing session', async () => {
    for (const yes of [['session_not_found', 'session_not_local'], ['session_closed', 'session_active'], ['method_unknown', 'session_not_found']]) {
      const fake = configured((name) => noulAnswer(yes.includes(name) ? 0.99 : 0.01));
      expect(await judge(webuiDaemonRefusalAdapter, fake.port, refusal('Contradictory evidence'))).toMatchObject({ status: 'held', compoundOutcome: 'escalate' });
      expect(fake.notes.find(({ note }) => note.kind === 'action')?.note).toMatchObject({ action: 'conflicting-evidence' });
    }
  });
});

describe('source preflight and retention boundary', () => {
  test('credential material past every proposed clip never reaches a port or log', async () => {
    const fake = configured(() => noulAnswer(0.99));
    await expect(refuse(webuiDaemonRefusalAdapter, fake.port, refusal('x'.repeat(5000) + ' apiKey=synthetic-secret'))).rejects.toMatchObject(held);
    expect(fake.requests).toHaveLength(0);
    expect(fake.entries).toHaveLength(0);
  });

  test('unclipped source bounds, unknown fields and accessors hold without invoking hooks', async () => {
    const fake = configured(() => noulAnswer(0.99));
    await expect(refuse(webuiDaemonRefusalAdapter, fake.port, refusal('é'.repeat(2100)))).rejects.toMatchObject(held);
    let calls = 0;
    const input = { ...refusal(''), get message() { calls++; return 'secret'; } };
    await expect(refuse(webuiDaemonRefusalAdapter, fake.port, input)).rejects.toMatchObject(held);
    expect(calls).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });
});
