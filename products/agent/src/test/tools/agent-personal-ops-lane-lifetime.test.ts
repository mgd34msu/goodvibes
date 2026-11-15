import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { getOperatorContract } from '@goodvibes-jev/engine/platform/contracts';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.ts';
import { buildLanes } from '../../tools/agent-harness-personal-ops-lanes.ts';
import { CONTRACT_DISCOVERY_BATCH_SIZE, CONTRACT_DISCOVERY_LANES } from '../../tools/agent-harness-personal-ops-discovery.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';
import { expectHeld } from '../helpers/expect-held.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function laneContext() {
  // This native read-model fixture intentionally has no installed interactive
  // session, provider, or filesystem workspace services.
  const context = { platform: {}, clients: {} } as unknown as CommandContext;
  return { context };
}

function laneFixture(beforeAnswer?: (name: string) => void) {
  return fakePort((name, question) => {
    beforeAnswer?.(name);
    if (name === 'match' && question.type === 'noul') return noulAnswer(0.001);
    if (name === 'kind' && question.type === 'choice' && Object.hasOwn(question.criteria, 'owner_profile')) return choiceAnswer(question, 'other', 0.999);
    if (question.type === 'noul' && ['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name)) return noulAnswer(0.001);
    throw new Error(`Unscripted native lane lifetime question ${name}`);
  });
}

describe('Personal Ops lane source phases', () => {
  test('all native predicates finish before parent retention, whose pure guard survives cleanup', async () => {
    const { context } = laneContext();
    const parent = new Map<string | (() => void), () => void>();
    let matches = 0, firstRetentionMatches = -1;
    const fake = laneFixture(name => {
      if (name === 'match') {
        matches++;
        if (matches % getOperatorContract().operator.methods.length === 0) process.stderr.write(`Native lane source phase: ${matches} complete predicates\n`);
      }
    });
    installJudgmentPort(fake.port);
    const lanes = await buildLanes(context, { sourceOwner: ordinaryResearchOwner(),
      assertCurrent() { for (const guard of parent.values()) guard(); },
      retainCurrent(guard, key) {
        if (firstRetentionMatches < 0) firstRetentionMatches = matches;
        if (!parent.has(key ?? guard)) parent.set(key ?? guard, guard);
      },
    });
    expect(matches).toBe(CONTRACT_DISCOVERY_LANES.length * getOperatorContract().operator.methods.length);
    expect(firstRetentionMatches).toBe(matches);
    expect(lanes.map(lane => lane.id)).toContain('inbox');
    for (const guard of parent.values()) guard();
  }, 60_000);

  test('a notes-only read never asks about the email or calendar connectors', async () => {
    const server = { name: 'synthetic-server', connected: true, trustMode: 'sandbox', role: 'default', schemaFreshness: 'fresh', allowedHosts: ['synthetic.invalid'] };
    const context = { platform: {}, clients: { mcpApi: { listServerSecurity() { return [server]; } } } } as unknown as CommandContext;
    const asked = (exactLane?: 'notes') => {
      let connectorQuestions = 0;
      const fake = fakePort((name, question, state) => {
        const candidate = state && typeof state === 'object' && 'candidate' in state ? state.candidate : undefined;
        if (name === 'match' && candidate && typeof candidate === 'object' && 'name' in candidate && candidate.name === server.name) connectorQuestions++;
        if (question.type === 'noul') return noulAnswer(0.001);
        if (name === 'kind' && Object.hasOwn(question.criteria, 'owner_profile')) return choiceAnswer(question, 'other', 0.999);
        throw new Error(`Unscripted question ${name}`);
      });
      installJudgmentPort(fake.port);
      return buildLanes(context, { sourceOwner: ordinaryResearchOwner() }, exactLane).then(() => connectorQuestions);
    };
    expect(await asked('notes')).toBe(0);
    expect(await asked()).toBeGreaterThan(0);
  }, 120_000);

  test('an original currentness callback cannot replace its binding before source acquisition', async () => {
    const { context } = laneContext();
    const fake = laneFixture(); installJudgmentPort(fake.port);
    const options = { sourceOwner: ordinaryResearchOwner(), assertCurrent: () => {} };
    options.assertCurrent = () => { options.assertCurrent = () => {}; };
    await expectHeld(buildLanes(context, options)); expect(fake.requests).toHaveLength(0);
  });

  test('an asynchronous currentness callback cannot authorize source acquisition', async () => {
    const { context } = laneContext();
    const fake = laneFixture(); installJudgmentPort(fake.port);
    await expectHeld(buildLanes(context, { sourceOwner: ordinaryResearchOwner(), assertCurrent: async () => {} }));
    expect(fake.requests).toHaveLength(0);
  });

  test('owner methods replaced inside the original currentness callback cannot acquire source authority', async () => {
    const { context } = laneContext();
    const fake = laneFixture(); installJudgmentPort(fake.port);
    const owner = ordinaryResearchOwner();
    await expectHeld(buildLanes(context, { sourceOwner: owner, assertCurrent() {
      Object.defineProperty(owner, 'project', { value: () => [], configurable: true });
    } }));
    expect(fake.requests).toHaveLength(0);
  });
});
