import { describe, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, type Answerer } from '@goodvibes-jev/judgment/testing';
import { BrowserJudgmentError, type AuthenticatedPrincipal, type BrowserJudgmentInputMap, type BrowserJudgmentRequest } from '../daemon-api/src/index.ts';
import { BrowserJudgmentReferences, BrowserJudgmentRegistry, BrowserJudgmentService } from '../platform/src/platform/judgment-browser/index.ts';
import { webuiDaemonRefusalAdapter } from '../platform/src/platform/judgment-browser/batteries/webui-adapters.ts';
import { readStructuredDaemonRefusal } from '../platform/src/platform/judgment-browser/batteries/webui-readers.ts';
import { readWebuiStatusCatalog } from '../platform/src/platform/judgment-browser/batteries/webui-status-catalog.ts';
import { withWebuiAnswerBoundary } from '../platform/src/platform/judgment-browser/batteries/webui-answers.ts';

const ERRORS = 'webui.errors.daemon-refusal';
const PALETTE = 'webui.palette.command-rank';
const owner: AuthenticatedPrincipal = { principalId: 'fixture-owner', principalKind: 'user', admin: false, scopes: ['write:judgment', 'read:sessions'] };
const body = <K extends keyof BrowserJudgmentInputMap>(battery: K, input: BrowserJudgmentInputMap[K]): BrowserJudgmentRequest<K> => ({ protocolVersion: 1, requestId: crypto.randomUUID(), battery, batteryVersion: 1, input }) as BrowserJudgmentRequest<K>;
const source = (message = 'This daemon does not host a live runtime for the existing session.', status = 404) => ({ methodId: 'sessions.contextUsage.get', status, message });

function harness(options: { answer?: Answerer; authorize?: () => boolean; beforeAnswer?: (request: JudgmentRequest<Questions>) => Promise<void> } = {}) {
  const fake = fakePort(options.answer ?? ((name) => noulAnswer(name === 'session_not_local' ? 0.99 : 0.01)));
  const log = new SqliteDecisionLog(':memory:');
  const references = new BrowserJudgmentReferences();
  const registry = new BrowserJudgmentRegistry();
  registry.register(webuiDaemonRefusalAdapter);
  let current = owner;
  let active = 0;
  let peak = 0;
  const inner: JudgmentPort = { model: fake.port.model, async ask(request) {
    active++; peak = Math.max(peak, active);
    try { await options.beforeAnswer?.(request as JudgmentRequest<Questions>); return await fake.port.ask(request); }
    finally { active--; }
  } };
  const port = withDecisionLog(withWebuiAnswerBoundary(inner), log);
  const service = new BrowserJudgmentService({ registry, references,
    currentRoute: () => ({ revision: 'fixture-route', kind: 'local', port, assertCurrent() {} }),
    authorize: options.authorize ?? (() => true),
  });
  return { ...fake, port, log, references, service, peak: () => peak,
    principal: (value: AuthenticatedPrincipal) => { current = value; },
    issue: (battery: keyof BrowserJudgmentInputMap, snapshot: unknown, extra: { mayRead?: (principal: AuthenticatedPrincipal) => boolean; assertCurrent?: () => void } = {}) => references.issue({
      principalId: owner.principalId, battery, revision: 'fixture-source-v1', expiresAt: Date.now() + 60_000, snapshot,
      mayRead: extra.mayRead ?? ((principal) => principal.principalId === owner.principalId), assertCurrent: extra.assertCurrent ?? (() => {}),
    }),
    execute: (request: BrowserJudgmentRequest, signal = new AbortController().signal) => service.execute(request, owner, signal, () => current),
    async close() { await service.close(); log[Symbol.dispose](); },
  };
}

describe('actual WebUI descriptors through the published service', () => {
  test('known refusal codes resolve structurally and cannot create endpoint readings', async () => {
    const f = harness();
    try {
      const known = { ...source(), code: 'SESSION_NOT_FOUND' };
      expect(readStructuredDaemonRefusal(known)).toEqual({ status: 'ready', basis: 'structured', value: { session_not_found: true, session_closed: false, session_active: false, session_not_local: false, method_unknown: false } });
      const ref = f.issue(ERRORS, known);
      await expect(f.execute(body(ERRORS, { errorRef: ref }))).rejects.toMatchObject({ code: 'JUDGMENT_INPUT_HELD' });
      expect(f.requests).toHaveLength(0); expect(f.log.query()).toHaveLength(0);
    } finally { await f.close(); }
  });

  test('unknown error refs produce genuine five-item readings and decision evidence', async () => {
    const f = harness();
    try {
      const ref = f.issue(ERRORS, source());
      const result = await f.execute(body(ERRORS, { errorRef: ref })) as Record<string, unknown>;
      expect(result).toMatchObject({ status: 'settled', outcome: 'act', value: { session_not_local: true, session_not_found: false }, readings: { session_not_local: { probability: 0.99, verdict: 'yes', outcome: 'act' } } });
      expect(f.requests).toHaveLength(1); expect(f.log.query()).toHaveLength(1);
      expect(result.evidence).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(source().message);
    } finally { await f.close(); }
  });

  test('non-404 omits method_unknown reading while returning its structural false value', async () => {
    const f = harness({ answer: () => noulAnswer(0.01) });
    try {
      const ref = f.issue(ERRORS, source('Gateway storage unavailable.', 500));
      const result = await f.execute(body(ERRORS, { errorRef: ref })) as Record<string, unknown>;
      expect(result).toMatchObject({ status: 'settled', value: { method_unknown: false }, structuralBasis: { method_unknown: 'http-status-not-404' } });
      expect(result.readings).not.toHaveProperty('method_unknown');
      expect(Object.keys(f.requests[0]!.questions)).toHaveLength(4);
    } finally { await f.close(); }
  });

  test('an unknown refusal without an actual HTTP status is held before the port or log', async () => {
    const f = harness();
    try {
      const ref = f.issue(ERRORS, { methodId: 'sessions.get', message: 'An unresolved refusal with no wire status.' });
      await expect(f.execute(body(ERRORS, { errorRef: ref }))).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
      expect(f.requests).toHaveLength(0); expect(f.log.query()).toHaveLength(0);
    } finally { await f.close(); }
  });

  test('a conflicting all-act compound escalates without altering individual readings or returning a value', async () => {
    const f = harness({ answer: (name) => noulAnswer(name === 'session_closed' || name === 'session_active' ? 0.99 : 0.01) });
    try {
      const ref = f.issue(ERRORS, source('Mixed current-state evidence.'));
      const result = await f.execute(body(ERRORS, { errorRef: ref })) as Record<string, unknown>;
      expect(result).toMatchObject({ status: 'held', outcome: 'escalate', readings: { session_closed: { outcome: 'act' }, session_active: { outcome: 'act' } } });
      expect(result).not.toHaveProperty('value');
      expect(result).not.toHaveProperty('compoundOutcome');
    } finally { await f.close(); }
  });

  test('confirm and escalate survive the service projection with no guessed value', async () => {
    for (const [p, outcome] of [[0.8, 'confirm'], [0.5, 'escalate']] as const) {
      const f = harness({ answer: (name) => noulAnswer(name === 'session_closed' ? p : 0.01) });
      try {
        const result = await f.execute(body(ERRORS, { errorRef: f.issue(ERRORS, source()) })) as Record<string, unknown>;
        expect(result).toMatchObject({ status: 'held', outcome, readings: { session_closed: { probability: p, outcome } } });
        expect(result).not.toHaveProperty('value');
      } finally { await f.close(); }
    }
  });

  test('current status catalogs use exhaustive structural mappings', () => {
    expect(readWebuiStatusCatalog('session.closed', 'badge')).toEqual({ vocabulary: 'badge', tone: 'neutral' });
    expect(readWebuiStatusCatalog('knowledge-job.running', 'library-dot')).toEqual({ vocabulary: 'library-dot', tone: 'info' });
    expect(readWebuiStatusCatalog('knowledge-job.completed', 'library-dot')).toEqual({ vocabulary: 'library-dot', tone: 'ok' });
    expect(readWebuiStatusCatalog('knowledge-job.future-status', 'badge')).toBeUndefined();
  });

});

describe('adapter source ownership and full-input admission', () => {
  test('source refs require the right principal, purpose and current literal read grant', async () => {
    const f = harness();
    try {
      const ref = f.issue(ERRORS, source(), { mayRead: () => false });
      await expect(f.execute(body(ERRORS, { errorRef: ref }))).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
      const wrongPurpose = f.issue(PALETTE, source());
      await expect(f.execute(body(ERRORS, { errorRef: wrongPurpose }))).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
      const nonBoolean = f.issue(ERRORS, source(), { mayRead: (async () => true) as unknown as () => boolean });
      await expect(f.execute(body(ERRORS, { errorRef: nonBoolean }))).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
      f.principal({ ...owner, principalId: 'different' });
      await expect(f.execute(body(ERRORS, { errorRef: f.issue(ERRORS, source()) }))).rejects.toMatchObject({ code: 'JUDGMENT_AUTH_REQUIRED' });
      expect(f.requests).toHaveLength(0); expect(f.log.query()).toHaveLength(0);
    } finally { await f.close(); }
  });

  test('source access alone does not grant route/retention permission, even with a thenable true grant', async () => {
    for (const authorize of [() => false, (async () => true) as unknown as () => boolean]) {
      const f = harness({ authorize });
      try {
        await expect(f.execute(body(ERRORS, { errorRef: f.issue(ERRORS, source()) }))).rejects.toMatchObject({ code: 'JUDGMENT_PERMISSION_HELD' });
        expect(f.requests).toHaveLength(0); expect(f.log.query()).toHaveLength(0);
      } finally { await f.close(); }
    }
  });

  test('source revision and principal are rechecked after asynchronous provider work', async () => {
    for (const change of ['source', 'principal'] as const) {
      let valid = true;
      let release!: () => void;
      let enter!: () => void;
      const started = new Promise<void>((resolve) => { enter = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const f = harness({ beforeAnswer: async () => { enter(); await gate; } });
      try {
        const ref = f.issue(ERRORS, source(), { assertCurrent: () => { if (!valid) throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD'); } });
        const pending = f.execute(body(ERRORS, { errorRef: ref }));
        await started;
        if (change === 'source') valid = false; else f.principal({ ...owner, scopes: [] });
        release();
        await expect(pending).rejects.toMatchObject({ code: change === 'source' ? 'JUDGMENT_REFERENCE_HELD' : 'JUDGMENT_AUTH_REQUIRED' });
      } finally { release?.(); await f.close(); }
    }
  });

});
