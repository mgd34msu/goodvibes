import { expect, spyOn, test } from 'bun:test';
import { canonicalJson, createSystemOnePort, JudgmentError, DEFAULT_MODEL, SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions, type StateHash,
} from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import {
  decideNativeIntake, NATIVE_INTAKE_COVERAGE_SITE, NATIVE_INTAKE_DECISION_SITE, NATIVE_INTAKE_ROUTE_SITE,
  readNativeIntakeRoute, validateNativeRequirementProposal, type NativeIntakeReadInput,
} from '../platform/src/platform/workflow/work-ledger/native-intake-decisions.js';
import { requestRoute } from '../platform/src/platform/contract/batteries/request-route.js';

const binding = { sourceId: 'source', inputRevision: 'source-1', actionId: 'intake', actionRevision: 'routing-1', authorityId: 'owner', authorityRevision: 'authority-1', scopeId: 'project', scopeRevision: 'scope-1',
};
const text = 'Add JSON export.';
const proposal = { sourceRevision: 'source-1', spans: [{ partId: 'input' as const, start: 0, end: text.length }] };
const requirements = () => validateNativeRequirementProposal(text, 'source-1', proposal);
const repair = { ref: { id: 'repair', revision: 'repair-1', kind: 'revise-action' as const }, description: 'Propose new ranges from the unchanged complete source.', input: { operation: 'propose-ranges' },
};
function input(port: JudgmentPort, log: SqliteDecisionLog): NativeIntakeReadInput { return { text, sourceRevision: 'source-1', port, decisionLog: log, binding, assertCurrent() {} }; }
function answers(options: { route?: 'converse' | 'answer' | 'contract'; routeConfidence?: number; fidelity?: 'supports' | 'contradicts' | 'says_nothing'; missing?: number; final?: string;
  } = {},
) {
  return fakePort((name, question) => {
    if (name === 'route') return choiceAnswer(question, options.route ?? 'contract', options.routeConfidence ?? 0.99);
    if (name === 'relation') return choiceAnswer(question, options.fidelity ?? 'supports', 0.99);
    if (name.startsWith('part_')) return noulAnswer(options.missing ?? 0.01);
    if (name === 'refuse') return noulAnswer(0.99);
    return choiceAnswer(question, options.final ?? 'act', 0.99);
  });
}

test('range materialization preserves exact Unicode, whitespace, duplicate occurrences and uncovered positions', () => {
  const source = ' 🌻 Keep logs. Keep logs.\n';
  const first = source.indexOf('Keep logs.'), second = source.lastIndexOf('Keep logs.');
  const raw = { sourceRevision: 'v1', spans: [{ partId: 'input', start: first, end: first + 10 }, { partId: 'input', start: second, end: second + 10 },
    ],
  };
  const value = validateNativeRequirementProposal(source, 'v1', raw);
  expect(value.criteria).toEqual(['Keep logs.', 'Keep logs.']);
  expect(value.uncovered.map((range) => range.text)).toEqual([' 🌻 ', ' ', '\n']);
  expect(value.uncovered.every((range) => source.slice(range.start, range.end) === range.text)).toBe(true);
  raw.spans[0]!.start = 0;
  expect(value.proposal.spans[0]!.start).toBe(first);
  expect(Object.isFrozen(value.criteria)).toBe(true);
  const one = validateNativeRequirementProposal(source, 'v1', { sourceRevision: 'v1', spans: [{ partId: 'input', start: first, end: first + 10 }],
  });
  expect(one.uncovered.at(-1)?.text).toBe(' Keep logs.\n');
});

test('range validator refuses stale, malformed, generated, overlapping and surrogate-splitting proposals', () => {
  const bad: unknown[] = [
    { ...proposal, sourceRevision: 'old' }, { ...proposal, criteria: ['fabricated'] },
    { sourceRevision: 'source-1', spans: [{ partId: 'input', start: 0, end: 3, text: 'Add' }] },
    { sourceRevision: 'source-1', spans: [{ partId: 'input', start: 3, end: 6 }, { partId: 'input', start: 0, end: 3 },
      ],
    },
    { sourceRevision: 'source-1', spans: [{ partId: 'input', start: 0, end: 5 }, { partId: 'input', start: 4, end: 8 },
      ],
    },
    { sourceRevision: 'source-1', spans: [{ partId: 'attachment', start: 0, end: 3 }] },
    { sourceRevision: 'source-1', spans: [{ partId: 'input', start: -1, end: 3 }] },
    { sourceRevision: 'source-1', spans: [{ partId: 'input', start: 0.5, end: 3 }] },
    { sourceRevision: 'source-1', spans: new Array(1) }, new Proxy(proposal, {}),
  ];
  let getterCalls = 0;
  bad.push({ get sourceRevision() { getterCalls++; return 'source-1'; }, spans: [],
  });
  for (const value of bad) expect(() => validateNativeRequirementProposal(text, 'source-1', value)).toThrow();
  expect(getterCalls).toBe(0);
  expect(() => validateNativeRequirementProposal('🌻 task', 'v1', { sourceRevision: 'v1', spans: [{ partId: 'input', start: 1, end: 7 }] }),
  ).toThrow();
});

test('work admission records route, per-range fidelity, exact completeness, final disposition and claim', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(); const read = input(withDecisionLog(fake.port, log), log);
  const routeEvidence = await readNativeIntakeRoute(read);
  expect(fake.requests).toHaveLength(1);
  const result = await decideNativeIntake({ ...read, binding: { ...binding, actionRevision: 'proposal-1' }, routeEvidence, requirements: requirements(), allowAct: true, continuations: [repair], conditions: [],
  });
  expect(result).toMatchObject({ route: 'work', requirementsSettled: true, problems: [], autonomous: { decision: { outcome: 'act', binding: { actionRevision: 'proposal-1' } } },
  });
  expect(result.decisionIds).toHaveLength(4);
  for (const id of result.decisionIds) expect(log.get(id)?.status).toBe('answered');
  expect(fake.requests.map((request) => request.context?.site)).toEqual([NATIVE_INTAKE_ROUTE_SITE, 'work-ledger.native-intake.requirement', NATIVE_INTAKE_COVERAGE_SITE, NATIVE_INTAKE_DECISION_SITE,
  ]);
  expect(fake.requests.every((request) => JSON.stringify(request.state).includes(text))).toBe(true);
  expect(JSON.stringify(fake.requests.at(-1)!.state)).not.toContain('"probabilities"');
  expect(log.get(routeEvidence.decisionId)).toMatchObject({ answers: { route: { probabilities: expect.any(Object) } } });
  result.autonomous.recordClaim();
  for (const id of result.decisionIds) expect(log.get(id)).toMatchObject({ notes: expect.arrayContaining([{ kind: 'action', action: `autonomous:claim:${result.autonomous.decision.decisionId}` }]),
    });
});

test.each(['converse', 'answer'] as const)('%s is routed before extraction but still needs fresh autonomous act', async (route) => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = answers({ route });
  const read = input(withDecisionLog(fake.port, log), log);
  const routeEvidence = await readNativeIntakeRoute(read);
  const result = await decideNativeIntake({ ...read, routeEvidence, allowAct: true, continuations: [], conditions: [] });
  expect(result).toMatchObject({ route: 'turn', requirementsSettled: true, autonomous: { decision: { outcome: 'act' } } });
  expect(fake.requests).toHaveLength(2);
  expect(result.decisionIds).toHaveLength(2);
});

test('split conversation and answer probabilities still authorize only their shared ordinary-turn operation', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((name, question) =>
    name === 'route'
      ? { type: 'choice', choice: 'answer', confidence: 0.1, probabilities: { converse: 0.45, answer: 0.53, contract: 0.02 } }
      : choiceAnswer(question, 'act', 0.99),
  );
  const read = input(withDecisionLog(fake.port, log), log);
  const routeEvidence = await readNativeIntakeRoute(read);
  expect(routeEvidence.reading.outcome).not.toBe('act');
  expect(routeEvidence.ordinaryTurnReading).toMatchObject({ verdict: 'yes', outcome: 'act', probability: 0.98 });
  const result = await decideNativeIntake({ ...read, routeEvidence, allowAct: true, continuations: [], conditions: [] });
  expect(result).toMatchObject({ route: 'turn', autonomous: { decision: { outcome: 'act' } } });
});

test.each(['uncertain-route', 'empty-work', 'bad-fidelity', 'incomplete', 'host-block'] as const)(
  '%s removes act and selects only a registered repair',
  async (kind) => {
    using log = new SqliteDecisionLog(':memory:');
    const fake = answers({
      routeConfidence: kind === 'uncertain-route' ? 0.6 : 0.99,
      fidelity: kind === 'bad-fidelity' ? 'contradicts' : 'supports',
      missing: kind === 'incomplete' ? 0.25 : 0.01,
      final: 'revise_0',
    });
    const read = input(withDecisionLog(fake.port, log), log);
    const routeEvidence = await readNativeIntakeRoute(read);
    const captured =
      kind === 'empty-work'
        ? validateNativeRequirementProposal(text, 'source-1', { sourceRevision: 'source-1', spans: [] })
        : requirements();
    const result = await decideNativeIntake({
      ...read,
      routeEvidence,
      requirements: captured,
      allowAct: kind !== 'host-block',
      continuations: [repair],
      conditions: [],
    });
    expect(result.autonomous.decision).toMatchObject({ outcome: 'revise', next: repair.ref });
    expect(result.problems.length).toBeGreaterThan(0);
    const question = fake.requests.at(-1)!.questions.disposition!;
    expect(question.type === 'choice' && Object.hasOwn(question.criteria, 'act')).toBe(false);
    if (kind === 'uncertain-route') expect(result.route).toBeUndefined();
  },
);

test('missing source context prevents ordinary turn and retains every source marker in recorded reads', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = answers({ route: 'converse', final: 'revise_0' });
  const read = { ...input(withDecisionLog(fake.port, log), log), sourceIssues: [{ kind: 'file', label: 'Referenced specification' }] };
  const routeEvidence = await readNativeIntakeRoute(read);
  const result = await decideNativeIntake({ ...read, routeEvidence, allowAct: false, continuations: [repair], conditions: [] });
  expect(result.autonomous.decision.outcome).toBe('revise');
  expect(fake.requests.every((request) => JSON.stringify(request.state).includes('Referenced specification'))).toBe(true);
  await expect(
    decideNativeIntake({ ...read, sourceIssues: [], routeEvidence, allowAct: true, continuations: [], conditions: [] }),
  ).rejects.toMatchObject({ kind: 'invalid-request' });
});

test('a selected first duplicate leaves the actual second occurrence in completeness evidence', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = answers({ missing: 0.99, final: 'revise_0' });
  const read = { ...input(withDecisionLog(fake.port, log), log), text: 'Keep logs. Keep logs.' };
  const routeEvidence = await readNativeIntakeRoute(read);
  const captured = validateNativeRequirementProposal(read.text, 'source-1', {
    sourceRevision: 'source-1',
    spans: [{ partId: 'input', start: 0, end: 10 }],
  });
  const result = await decideNativeIntake({
    ...read,
    routeEvidence,
    requirements: captured,
    allowAct: true,
    continuations: [repair],
    conditions: [],
  });
  expect(result.coverage?.parts).toMatchObject([
    { kind: 'selected', range: { start: 0, end: 10 } },
    { kind: 'uncovered', range: { start: 10, end: 21, text: ' Keep logs.' } },
  ]);
  expect(result.requirementsSettled).toBe(false);
});

test('unsupported act without alternatives is a recorded refusal, never an invented receipt', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = answers({ route: 'answer' });
  const read = input(withDecisionLog(fake.port, log), log);
  const routeEvidence = await readNativeIntakeRoute(read);
  const result = await decideNativeIntake({ ...read, routeEvidence, allowAct: false, continuations: [], conditions: [] });
  expect(result.autonomous.decision.outcome).toBe('reject');
  expect(fake.requests.at(-1)?.questions.refuse?.type).toBe('noul');
  expect(() => result.autonomous.recordClaim()).toThrow('only an act');
});

test('forged route and changed source or authority cannot reuse real route evidence', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = answers();
  const read = input(withDecisionLog(fake.port, log), log);
  const routeEvidence = await readNativeIntakeRoute(read);
  const base = { ...read, routeEvidence, requirements: requirements(), allowAct: true, continuations: [], conditions: [] };
  for (const altered of [
    { ...base, routeEvidence: { ...routeEvidence } },
    { ...base, text: `${text} Another task.` },
    { ...base, binding: { ...binding, authorityRevision: 'revoked' } },
  ]) {
    await expect(decideNativeIntake(altered)).rejects.toMatchObject({ kind: 'invalid-request' });
  }
  expect(fake.requests).toHaveLength(1);
});

test('missing recorder or mismatched log lineage fails closed', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = answers();
  await expect(readNativeIntakeRoute(input(fake.port, log))).rejects.toMatchObject({ kind: 'unrecorded' });
  expect(fake.requests).toHaveLength(0);
  const read = {
    ...input(withDecisionLog(fake.port, log), log),
    decisionLog: {
      get() {
        return undefined;
      },
    },
  };
  await expect(readNativeIntakeRoute(read)).rejects.toMatchObject({ kind: 'unrecorded' });
});

for (const copied of [false, true]) test(`intake reuses only the actual recorded input commitment (copy=${copied})`, async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(), recorded = withDecisionLog(fake.port, log);
  const selected: JudgmentPort = copied ? { ...recorded, async ask(request) { return { ...await recorded.ask(request) }; } } : recorded;
  const hash = spyOn(Bun.CryptoHasher, 'hash');
  try {
    const route = await readNativeIntakeRoute(input(selected, log)); expect(route.route).toBe('contract');
    expect(fake.requests).toHaveLength(1); expect(log.get(route.decisionId)?.status).toBe('answered');
    // One actual recorder input hash; only a copied result needs one extra
    // independent forwarded-input comparison to the real saved log row.
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(copied ? 2 : 1);
  } finally { hash.mockRestore(); }
});

test('an absent borrowed decision ID has no fallback state-commitment consumer', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(), recorded = withDecisionLog(fake.port, log);
  const port: JudgmentPort = { ...recorded, ask: request => fake.port.ask(request) };
  let assertions = 0;
  const hashing = spyOn(Bun.CryptoHasher, 'hash');
  try {
    await expect(readNativeIntakeRoute({ ...input(port, log), assertCurrent() { assertions++; } })).rejects.toMatchObject({ kind: 'unrecorded' });
    expect(fake.requests).toHaveLength(1); expect(log.query()).toHaveLength(0);
    expect(assertions).toBeGreaterThan(1);
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hashing.mockRestore(); }
});

for (const mode of ['absent', 'failed', 'id', 'id-number', 'id-empty', 'hash-absent', 'hash-shape', 'context', 'context-absent', 'questions', 'answers', 'state'] as const) {
  test(`a present borrowed ID with ${mode} recorded provenance avoids an impossible fallback comparison`, async () => {
    using log = new SqliteDecisionLog(':memory:'); const seedFake = answers(), recorded = withDecisionLog(seedFake.port, log);
    const seeded = await readNativeIntakeRoute(input(recorded, log));
    const seed = log.get(seeded.decisionId);
    if (!seed || seed.status !== 'answered' || seed.stateHash === undefined) throw new Error('Actual bound recorded fixture missing');
    const { stateHash: _seedStateHash, ...seedWithoutHash } = seed;
    const fake = answers(); let reads = 0, assertions = 0;
    let candidate: import('@goodvibes-jev/judgment').DecisionEntry | undefined;
    const port: JudgmentPort = { ...recorded, async ask(request) {
      const raw = await fake.port.ask(request);
      const context = (mode === 'context' ? { site: 'unrelated-native-site' } : mode === 'context-absent' ? undefined : { ...request.context }) as typeof seed.context;
      const questions = mode === 'questions' ? {} : JSON.parse(canonicalJson(request.questions as unknown as import('@goodvibes-jev/judgment').EntryType)) as typeof seed.questions;
      const common = { id: (mode === 'id' ? 'another-recorded-id' : seed.id) as typeof seed.id, at: seed.at, context, questions, requestedModel: seed.requestedModel,
        // Deliberately forged field values exercise the untrusted log boundary;
        // an absent optional field is omitted rather than set to undefined.
        ...(mode === 'hash-absent' ? {} : { stateHash: (mode === 'hash-shape' ? 'not-a-sha256' : 'f'.repeat(64)) as StateHash }), latencyMs: 0, requestId: undefined };
      candidate = mode === 'absent' ? undefined : mode === 'failed'
        ? { ...common, status: 'failed', error: { kind: 'unavailable', message: 'Synthetic failed reading' } }
        : { ...seedWithoutHash, ...common, answers: mode === 'answers' ? {} : JSON.parse(canonicalJson(raw.answers as unknown as import('@goodvibes-jev/judgment').EntryType)) as typeof seed.answers };
      return { ...raw, decisionId: mode === 'id-number' ? 42 : mode === 'id-empty' ? '' : seed.id } as never;
    } };
    const hashing = spyOn(Bun.CryptoHasher, 'hash');
    try {
      await expect(readNativeIntakeRoute({ ...input(port, log), assertCurrent() { assertions++; },
        decisionLog: { get() { reads++; return candidate; } } })).rejects.toMatchObject({ kind: 'unrecorded' });
      expect(fake.requests).toHaveLength(1); expect(reads).toBe(mode === 'id-number' || mode === 'id-empty' ? 0 : 1); expect(assertions).toBeGreaterThan(1);
      // Only the last case has a real possible consumer: its independent state
      // binding must still be computed and rejected, rather than blindly trusted.
      expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(mode === 'state' ? 1 : 0);
    } finally { hashing.mockRestore(); }
  });
}

for (const mode of ['returned', 'thrown', 'typed-error'] as const) test(`native intake observes ${mode} owner guard failure without changing its failure identity`, async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(), recorded = withDecisionLog(fake.port, log);
  let rejected: Promise<never> | undefined; const stale = new JudgmentError('aborted', 'Original owner retired');
  const operation = readNativeIntakeRoute({ ...input(recorded, log), assertCurrent() {
    if (mode === 'typed-error') throw stale;
    rejected = Promise.reject(stale);
    if (mode === 'thrown') throw rejected;
    return rejected as never;
  } });
  if (mode === 'returned') await expect(operation).rejects.toMatchObject({ kind: 'invalid-request' });
  else if (mode === 'typed-error') await expect(operation).rejects.toBe(stale);
  else { await expect(operation).rejects.toBeInstanceOf(Promise); expect(rejected).toBeDefined(); }
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(fake.requests).toHaveLength(0); expect(log.query()).toHaveLength(0);
});

test('a duplicate borrowed decision ID refuses before computing a discarded fallback commitment', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(), recorded = withDecisionLog(fake.port, log);
  const routeEvidence = await readNativeIntakeRoute(input(recorded, log));
  const port: JudgmentPort = { ...recorded, async ask(request) { return { ...await fake.port.ask(request), decisionId: routeEvidence.decisionId }; } };
  const hashing = spyOn(Bun.CryptoHasher, 'hash');
  try {
    await expect(decideNativeIntake({ ...input(port, log), routeEvidence, requirements: requirements(), allowAct: true,
      continuations: [repair], conditions: [] })).rejects.toMatchObject({ kind: 'unrecorded' });
    expect(fake.requests).toHaveLength(2); expect(log.query()).toHaveLength(1);
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hashing.mockRestore(); }
});

test('a custom port cannot mutate the original source before its recorded-input comparison', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(), recorded = withDecisionLog(fake.port, log); let immutable = false;
  const selected: JudgmentPort = { ...recorded, async ask(request) {
    const source = (request.state as { originalSource: { text: string } }).originalSource;
    immutable = Object.isFrozen(source);
    try { source.text = 'Different borrowed requirement'; } catch { /* Frozen original is required. */ }
    return recorded.ask(request);
  } };
  const route = await readNativeIntakeRoute(input(selected, log)); expect(route.route).toBe('contract'); expect(immutable).toBe(true);
  expect((fake.requests[0]!.state as { originalSource: { text: string } }).originalSource.text).toBe(text);
});

test('borrowed response getters cannot run in intake capture or fabricate recorded route answers', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(), recorded = withDecisionLog(fake.port, log); let invoked = 0;
  const selected: JudgmentPort = { ...recorded, async ask(request) { const result = await recorded.ask(request); return { ...result, get answers() { invoked++; return result.answers; } }; } };
  await expect(readNativeIntakeRoute(input(selected, log))).rejects.toMatchObject({ kind: 'invalid-response' }); expect(invoked).toBe(0);
});

test('later route-owner map overrides cannot make copied reading fields an actual source owner', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers({ route: 'answer' }), read = input(withDecisionLog(fake.port, log), log), route = await readNativeIntakeRoute(read);
  const get = WeakMap.prototype.get;
  let pending: ReturnType<typeof decideNativeIntake>;
  try {
    WeakMap.prototype.get = () => ({ text, sourceRevision: 'source-1', sourceIssues: 'null', continuation: 'null', binding, records: [], assertCurrent() {} });
    pending = decideNativeIntake({ ...read, routeEvidence: { ...route }, allowAct: true, continuations: [], conditions: [] });
  } finally { WeakMap.prototype.get = get; }
  await expect(pending!).rejects.toMatchObject({ kind: 'invalid-request' }); expect(fake.requests).toHaveLength(1);
});

for (const mode of ['reject', 'cancel', 'stale'] as const) test(`intake joins both actual retry observers before proceeding (${mode})`, async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(), recorded = withDecisionLog(fake.port, log), controller = new AbortController();
  let current = true, next = false, entered!: () => void, release!: () => void;
  const events: string[] = [], started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const actualRoute = requestRoute.route.bind(requestRoute);
  const routing = spyOn(requestRoute, 'route').mockImplementation((port, state, options) => actualRoute(port, state, { ...options, async onRetry() {
    events.push('request-entered'); entered(); await gate; events.push('request-drained');
  } }));
  const selected: JudgmentPort = { ...recorded, async ask(request) {
    await request.onRetry?.({ logicalRequestId: 'synthetic-retry', attempt: { attempt: 1, endpointIndex: 0, endpointKind: 'local', requestedModel: 'fixture', latencyMs: 1, outcome: 'unavailable' }, elapsedMs: 1, nextDelayMs: 0 });
    next = true; return recorded.ask(request);
  } };
  const pending = readNativeIntakeRoute({ ...input(selected, log), signal: controller.signal,
    assertCurrent() { if (!current) throw new JudgmentError('aborted', 'Synthetic stale owner'); },
    async onRetry() { events.push('owner'); if (mode === 'reject') throw new Error('Synthetic observer rejection'); },
  }); void pending.catch(() => {});
  try {
    await started; expect(next).toBe(false); expect(fake.requests).toHaveLength(0);
    if (mode === 'cancel') controller.abort(new JudgmentError('aborted', 'Synthetic observer cancellation'));
    if (mode === 'stale') current = false;
    release();
    if (mode === 'reject') await expect(pending).rejects.toThrow('Synthetic observer rejection');
    else await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    expect(events).toEqual(['owner', 'request-entered', 'request-drained']); expect(next).toBe(false); expect(fake.requests).toHaveLength(0);
  } finally { release(); await pending.catch(() => {}); routing.mockRestore(); }
});

for (const mode of ['async-owner', 'nonvoid-owner', 'async-request', 'nonvoid-request', 'revoke-in-request'] as const) test(`intake cannot erase a synchronous guard contract (${mode})`, async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(), recorded = withDecisionLog(fake.port, log); let current = true, borrowed = false;
  const actualRoute = requestRoute.route.bind(requestRoute);
  const routing = spyOn(requestRoute, 'route').mockImplementation((port, state, options) => actualRoute(port, state, { ...options, beforeAttempt() {
    if (mode === 'async-request') return Promise.reject(new Error('Synthetic rejected request guard'));
    if (mode === 'nonvoid-request') return true;
    if (mode === 'revoke-in-request') current = false;
  } }));
  const selected: JudgmentPort = { ...recorded, ask(request) { borrowed = true; return recorded.ask(request); } };
  try {
    const pending = readNativeIntakeRoute({ ...input(selected, log), assertCurrent() {
      if (mode === 'async-owner') return Promise.reject(new Error('Synthetic rejected owner guard'));
      if (mode === 'nonvoid-owner') return true;
      if (!current) throw new JudgmentError('aborted', 'Synthetic retired original owner');
    } });
    await expect(pending).rejects.toMatchObject({ kind: mode === 'revoke-in-request' ? 'aborted' : 'invalid-request' });
    expect(borrowed).toBe(false); expect(fake.requests).toHaveLength(0); expect(log.query()).toHaveLength(0);
  } finally { routing.mockRestore(); }
});

test('binding input revision must identify the captured source before any reading', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = answers();
  const read = input(withDecisionLog(fake.port, log), log);
  await expect(readNativeIntakeRoute({ ...read, binding: { ...binding, inputRevision: 'unrelated' } })).rejects.toMatchObject({
    kind: 'invalid-request',
  });
  expect(fake.requests).toHaveLength(0);
});

test('projecting machine readings never weakens the complete-source privacy boundary', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = answers();
  const read = input(withDecisionLog(fake.port, log), log);
  await expect(readNativeIntakeRoute({ ...read, text: 'Use card 4111111111111111 for this task.' })).rejects.toMatchObject({
    problem: 'card-material',
  });
  expect(fake.requests).toHaveLength(0);
  expect(log.query()).toHaveLength(0);
});

test('revocation during an abort-ignoring answer prevents interpretation and later claim', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = answers();
  let current = true;
  const borrowed: JudgmentPort = {
    ...fake.port,
    async ask(request) {
      const result = await fake.port.ask(request);
      current = false;
      return result;
    },
  };
  const read = {
    ...input(withDecisionLog(borrowed, log), log),
    assertCurrent() {
      if (!current) throw new JudgmentError('aborted', 'revoked');
    },
  };
  await expect(readNativeIntakeRoute(read)).rejects.toMatchObject({ kind: 'aborted' });
  expect(log.query()).toMatchObject([{ status: 'answered', notes: [] }]);
});

test('live currentness remains enforced after a successful disposition', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = answers({ route: 'answer' });
  let current = true;
  const read = {
    ...input(withDecisionLog(fake.port, log), log),
    assertCurrent() {
      if (!current) throw new JudgmentError('aborted', 'revoked');
    },
  };
  const routeEvidence = await readNativeIntakeRoute(read);
  const result = await decideNativeIntake({ ...read, routeEvidence, allowAct: true, continuations: [], conditions: [] });
  current = false;
  expect(() => result.autonomous.assertCurrent()).toThrow();
  expect(() => result.autonomous.recordClaim()).toThrow();
});

test('malformed proposal cannot manufacture a full-root criterion or ask semantic verification', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = answers();
  const read = input(withDecisionLog(fake.port, log), log);
  const routeEvidence = await readNativeIntakeRoute(read);
  const malformed = { proposal: { sourceRevision: 'stale', spans: [] }, criteria: [text], uncovered: [] };
  await expect(
    decideNativeIntake({ ...read, routeEvidence, requirements: malformed, allowAct: true, continuations: [repair], conditions: [] }),
  ).rejects.toMatchObject({ kind: 'invalid-request' });
  expect(fake.requests).toHaveLength(1);
  const empty = { proposal: { sourceRevision: 'source-1', spans: [] }, criteria: [text], uncovered: [] };
  const result = await decideNativeIntake({
    ...read,
    routeEvidence,
    requirements: empty,
    allowAct: true,
    continuations: [],
    conditions: [],
  });
  expect(result.requirements?.criteria).toEqual([]);
  expect(result.autonomous.decision.outcome).toBe('reject');
});

test('registered external condition produces a bound defer without acting or waiting inside the reader', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = answers({ route: 'answer', final: 'defer_0' });
  const read = input(withDecisionLog(fake.port, log), log);
  const routeEvidence = await readNativeIntakeRoute(read);
  const condition = { ref: { id: 'evidence-ready', revision: 'pending-1' }, description: 'The registered evidence source changes.' };
  const result = await decideNativeIntake({ ...read, routeEvidence, allowAct: false, continuations: [], conditions: [condition] });
  expect(result.autonomous.decision).toMatchObject({ outcome: 'defer', until: condition.ref });
  expect(() => result.autonomous.recordClaim()).toThrow('only an act');
});

test.each(['recover', 'revoke', 'abort'] as const)('shared transport failover retains native lifetime: %s', async (behavior) => {
  using log = new SqliteDecisionLog(':memory:');
  const controller = new AbortController();
  let attempts = 0,
    progress = 0,
    current = true;
  const transport = createSystemOnePort({
    endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' },
    model: DEFAULT_MODEL,
    fallbacks: [{ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:2', apiKey: 'synthetic-backup' }, model: DEFAULT_MODEL }],
    retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 },
    timeoutMs: 1_000,
    fetch: async (_url, init) => {
      if (++attempts === 1) return new Response('', { status: 503 });
      const wire = JSON.parse(String(init?.body)) as JudgmentRequest<Questions>;
      return Response.json({
        model: DEFAULT_MODEL,
        answers: { route: choiceAnswer(wire.questions.route!, 'answer', 0.99) },
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const read = {
    ...input(withDecisionLog(transport, log), log),
    signal: controller.signal,
    assertCurrent() {
      if (!current) throw new JudgmentError('aborted', 'revoked');
    },
    onRetry() {
      progress++;
      if (behavior === 'revoke') current = false;
      if (behavior === 'abort') controller.abort();
    },
  };
  if (behavior === 'recover') {
    const result = await readNativeIntakeRoute(read);
    expect(result.settled).toBe(true);
    expect(attempts).toBe(2);
    expect(log.get(result.decisionId)?.lineage?.attempts).toHaveLength(2);
  } else {
    await expect(readNativeIntakeRoute(read)).rejects.toMatchObject({ kind: 'aborted' });
    expect(attempts).toBe(1);
    expect(log.query()).toMatchObject([{ status: 'failed' }]);
  }
  expect(progress).toBe(1);
});


test('native intake keeps its exact composite proposal revision without screening its checksum as source text', async () => {
  const revision = 'publish-work:g2:p1:' + '4111111111111111' + 'a'.repeat(48);
  using log = new SqliteDecisionLog(':memory:');
  const fake = answers(), read = input(withDecisionLog(fake.port, log), log);
  const routeEvidence = await readNativeIntakeRoute(read);
  const result = await decideNativeIntake({ ...read, binding: { ...binding, actionRevision: revision },
    routeEvidence, requirements: requirements(), allowAct: true, continuations: [repair], conditions: [] });
  expect(result.autonomous.decision.outcome).toBe('act');
  expect(result.autonomous.decision.binding.actionRevision).toBe(revision);
  expect(result.autonomous.decision.evidence).toContainEqual({ id: 'native-intake-requirements', revision });
  expect(fake.requests).toHaveLength(4);
  result.autonomous.recordClaim();
  for (const id of result.decisionIds) expect(log.get(id)?.status).toBe('answered');
  // The identical bytes are still rejected when supplied as semantic source.
  using rawLog = new SqliteDecisionLog(':memory:');
  const raw = answers();
  await expect(readNativeIntakeRoute({ ...input(withDecisionLog(raw.port, rawLog), rawLog), text: revision })).rejects.toMatchObject({ problem: 'card-material' });
  expect(raw.requests).toHaveLength(0); expect(rawLog.query()).toHaveLength(0);
});
