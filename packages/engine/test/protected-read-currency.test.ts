import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { captureJudgmentPort, installJudgmentPort, JudgmentAuthorityRetiredError } from '@goodvibes-jev/engine/errors';
import { retainOwnedJson } from '@goodvibes-jev/engine/platform/platform/gate';
import { JudgmentInputError } from '../platform/src/platform/gate/judgment-input.js';
import { TASK_ROUTES, planTaskRoute } from '../platform/src/platform/routing/task-routes/index.js';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { noul } from '@goodvibes-jev/judgment';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { taskRouteSourceFixture } from './_helpers/task-route-source.js';

/**
 * A protected read proves frozen data unchanged once. Data that can still change,
 * and every change made while a read is under way, keeps being refused at the next
 * boundary.
 */
describe('retained owned JSON', () => {
  const walks = (target: object) => {
    const counter = { keys: 0 };
    const proxy = new Proxy(target, { ownKeys(subject) { counter.keys++; return Reflect.ownKeys(subject); } });
    return { counter, proxy };
  };

  test('a fully frozen tree is not walked again at later boundaries', () => {
    const { counter, proxy } = walks(Object.freeze({ name: 'fixed', child: Object.freeze({ value: 1 }) }));
    const retained = retainOwnedJson(proxy);
    const afterProof = counter.keys;
    for (let boundary = 0; boundary < 100; boundary++) retained.assertCurrent();
    expect(counter.keys).toBe(afterProof);
  });

  test('a mutable tree is walked at every boundary', () => {
    const { counter, proxy } = walks({ name: 'open' });
    const retained = retainOwnedJson(proxy);
    const afterCapture = counter.keys;
    for (let boundary = 0; boundary < 5; boundary++) retained.assertCurrent();
    expect(counter.keys).toBe(afterCapture + 5);
  });

  test('a frozen root holding a mutable child is not treated as frozen', () => {
    const child = { value: 1 };
    const retained = retainOwnedJson(Object.freeze({ child }));
    retained.assertCurrent();
    child.value = 2;
    expect(retained.assertCurrent).toThrow(JudgmentInputError);
  });

  test('a frozen tree holding an accessor is not treated as frozen', () => {
    const value = Object.freeze({ get leaked() { return 1; } });
    expect(() => retainOwnedJson(value)).toThrow(JudgmentInputError);
  });
});

describe('an installed judgment port', () => {
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => { previous = installJudgmentPort(undefined); });
  afterEach(() => { installJudgmentPort(previous); });
  const request = { state: {}, questions: { yes: noul('Synthetic question') } };

  test('keeps answering while its data slots are unchanged', async () => {
    const fake = fakePort(() => noulAnswer(0.99));
    installJudgmentPort(fake.port);
    const owner = captureJudgmentPort('test.pure-slots');
    for (let ask = 0; ask < 3; ask++) await owner.port.ask(request);
    expect(fake.requests).toHaveLength(3);
  });

  test('refuses once a data slot becomes an accessor, even one that answers the same function', async () => {
    const fake = fakePort(() => noulAnswer(0.99));
    const port = { ...fake.port };
    installJudgmentPort(port);
    const owner = captureJudgmentPort('test.slot-to-accessor');
    await owner.port.ask(request);
    const original = port.ask;
    Object.defineProperty(port, 'ask', { get: () => original, configurable: true });
    await expect(owner.port.ask(request)).rejects.toBeInstanceOf(JudgmentAuthorityRetiredError);
  });

  test('refuses once a data slot holds a different function', async () => {
    const fake = fakePort(() => noulAnswer(0.99));
    const port = { ...fake.port };
    installJudgmentPort(port);
    const owner = captureJudgmentPort('test.slot-replaced');
    await owner.port.ask(request);
    port.ask = async () => { throw new Error('replacement called'); };
    await expect(owner.port.ask(request)).rejects.toBeInstanceOf(JudgmentAuthorityRetiredError);
  });
});

describe('route planning', () => {
  let previous: ReturnType<typeof installJudgmentPort>;
  let source: ReturnType<typeof taskRouteSourceFixture>;
  beforeEach(() => { previous = installJudgmentPort(undefined); source = taskRouteSourceFixture(); });
  afterEach(async () => { installJudgmentPort(previous); await source.close(); });

  /** Picks no route; every slot reads no. Calls `onRequest` before each answer. */
  const port = (onRequest: () => void) => fakePort((name: string, question: Question, state: EntryType) => {
    onRequest();
    const selection = state as unknown as { readonly candidates?: readonly unknown[] };
    if (selection.candidates !== undefined) return name === 'pick' ? choiceAnswer(question, 'none', 0.9) : noulAnswer(0.05);
    if (question.type === 'choice') return choiceAnswer(question, name === 'channelTask' ? 'status' : 'none');
    return noulAnswer(0.05);
  });

  test('the route catalog is frozen, so it is proven once', () => {
    expect(Object.isFrozen(TASK_ROUTES)).toBe(true);
    for (const route of TASK_ROUTES) expect(Object.isFrozen(route)).toBe(true);
  });

  test('a plan over unchanged arguments completes', async () => {
    installJudgmentPort(port(() => {}).port);
    const plan = await planTaskRoute({ query: 'check daemon health' }, {}, { sourceOwner: source.owner });
    expect(['ready', 'uncertain']).toContain(plan.status);
  });

  test('arguments changed while a reading is under way refuse the plan', async () => {
    const args = { query: 'check daemon health' };
    let requests = 0;
    installJudgmentPort(port(() => { if (++requests === 2) args.query = 'send the invoice to everyone'; }).port);
    await expect(planTaskRoute(args, {}, { sourceOwner: source.owner })).rejects.toThrow();
  });

  test('frozen arguments cannot be changed to begin with', () => {
    const args = Object.freeze({ query: 'check daemon health' });
    expect(() => { (args as { query: string }).query = 'other'; }).toThrow(TypeError);
  });

  test('a caller that revokes its authority while a reading is under way refuses the plan', async () => {
    let requests = 0, revoked = false;
    installJudgmentPort(port(() => { if (++requests === 2) revoked = true; }).port);
    await expect(planTaskRoute({ query: 'check daemon health' }, {}, { sourceOwner: source.owner,
      assertCurrent: () => { if (revoked) throw new Error('authority revoked'); } })).rejects.toThrow();
  });

  test('an abort while a reading is under way refuses the plan', async () => {
    const controller = new AbortController();
    let requests = 0;
    installJudgmentPort(port(() => { if (++requests === 2) controller.abort(); }).port);
    await expect(planTaskRoute({ query: 'check daemon health' }, {}, { sourceOwner: source.owner, signal: controller.signal })).rejects.toThrow();
  });

  test('a named-id listing changed while a reading is under way refuses the plan', async () => {
    let providers = [{ id: 'openrouter', names: ['OpenRouter'] }];
    let requests = 0;
    installJudgmentPort(port(() => { if (++requests === 2) providers = [{ id: 'ollama', names: ['Ollama'] }]; }).port);
    await expect(planTaskRoute({ query: 'check daemon health' }, { namedIds: { modelProvider: () => providers } }, { sourceOwner: source.owner })).rejects.toThrow();
  });
});
