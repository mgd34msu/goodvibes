/**
 * What the contracts operator service refuses or leaves out: where a contract may work,
 * a hosted session that is gone, the private conversation of the session that started a
 * contract, the file manifest in a list, and a contract this runner holds but does not run.
 */
import { describe, expect, test } from 'bun:test';
import {
  ContractOperatorError,
  createContractOperatorService,
  type ContractOperatorService,
  type HostedContractRunners,
} from '../../platform/src/platform/contract/index.js';
import { OwnerReplyRefusedError } from '../../platform/src/platform/contract/escalation.js';
import type { Contract } from '../../platform/src/platform/contract/index.js';
import { makeContract } from './fixtures.js';
import { fakeRunner, nextContractId } from './operator-support.js';

const WORKDIR = '/srv/daemon-work';

async function refusal(run: () => unknown): Promise<[string, number, string | undefined] | 'accepted'> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ContractOperatorError) return [error.code, error.status, error.field];
    throw error;
  }
  return 'accepted';
}

describe('where a contract started without a hosted session may work', () => {
  test('the daemon workspace and folders inside it are accepted; anything outside is refused before a runner starts it', async () => {
    const daemon = fakeRunner();
    const service = createContractOperatorService({ runner: daemon, workingDirectory: WORKDIR });
    expect(await refusal(() => service.start({ ask: 'Do it.', workspaceRoot: WORKDIR }))).toBe('accepted');
    expect(await refusal(() => service.start({ ask: 'Do it.', workspaceRoot: `${WORKDIR}/packages/app` }))).toBe('accepted');
    const started = daemon.started.length;
    expect(await refusal(() => service.start({ ask: 'Do it.', workspaceRoot: '/home/user/other' }))).toEqual(['INVALID_ARGUMENT', 400, 'workspaceRoot']);
    expect(await refusal(() => service.start({ ask: 'Do it.', workspaceRoot: `${WORKDIR}/../other` }))).toEqual(['INVALID_ARGUMENT', 400, 'workspaceRoot']);
    expect(await refusal(() => service.start({ ask: 'Do it.', workspaceRoot: `${WORKDIR}-sibling` }))).toEqual(['INVALID_ARGUMENT', 400, 'workspaceRoot']);
    expect(daemon.started).toHaveLength(started);
  });
});

describe('a session id that names a hosted session which is gone', () => {
  function surface(known: (sessionId: string) => boolean) {
    const daemon = fakeRunner();
    const service = createContractOperatorService({ runner: daemon, workingDirectory: WORKDIR });
    const hosted: HostedContractRunners = { runners: () => [], forSession: async () => null, knows: known };
    service.attachHosted(hosted);
    return { service, daemon };
  }

  test('is refused, naming the session, instead of running in the daemon workspace', async () => {
    const { service, daemon } = surface((id) => id === 'hosted-gone');
    expect(await refusal(() => service.start({ ask: 'Do it.', sessionId: 'hosted-gone' }))).toEqual(['SESSION_NOT_LIVE', 409, 'sessionId']);
    expect(daemon.started).toEqual([]);
  });

  test('an id the engine never hosted is an external session and still starts on the daemon runner', async () => {
    const { service, daemon } = surface((id) => id === 'hosted-gone');
    await service.start({ ask: 'Do it.', sessionId: 'tui-session-4' });
    expect(daemon.started[0]).toMatchObject({ sessionId: 'tui-session-4', origin: 'external' });
  });
});

describe('a hosted session owned by another caller', () => {
  function surface() {
    const daemon = fakeRunner();
    const service = createContractOperatorService({ runner: daemon, workingDirectory: WORKDIR });
    const hostedRunner = fakeRunner();
    const hosted: HostedContractRunners = {
      runners: () => [hostedRunner],
      knows: (id) => id === 'mine' || id === 'unclaimed',
      ownedByOthers: (id, principal) => id === 'mine' && principal !== 'alice',
      forSession: async (id) => (id === 'mine' || id === 'unclaimed' ? { runner: hostedRunner, workspaceRoot: WORKDIR } : null),
    };
    service.attachHosted(hosted);
    return { service, hostedRunner };
  }

  test('is refused with SESSION_NOT_OWNED and nothing starts; the owner and a session nobody claimed still start', async () => {
    const { service, hostedRunner } = surface();
    expect(await refusal(() => service.start({ ask: 'Do it.', sessionId: 'mine', principalId: 'mallory' }))).toEqual(['SESSION_NOT_OWNED', 403, 'sessionId']);
    expect(await refusal(() => service.start({ ask: 'Do it.', sessionId: 'mine' }))).toEqual(['SESSION_NOT_OWNED', 403, 'sessionId']);
    expect(hostedRunner.started).toEqual([]);
    expect(await refusal(() => service.start({ ask: 'Do it.', sessionId: 'mine', principalId: 'alice' }))).toBe('accepted');
    expect(await refusal(() => service.start({ ask: 'Do it.', sessionId: 'unclaimed', principalId: 'mallory' }))).toBe('accepted');
    expect(hostedRunner.started).toHaveLength(2);
  });
});

describe('what an operator reads of a contract', () => {
  function held(overrides: Partial<Contract>) {
    const daemon = fakeRunner();
    const service = createContractOperatorService({ runner: daemon, workingDirectory: WORKDIR });
    const contract = makeContract({ id: nextContractId(), ...overrides });
    daemon.contracts.set(contract.id, contract);
    return { service, daemon, contract };
  }

  test('the earlier conversation and selected diff of the starting session are not served; the goal and criteria are', () => {
    const { service, contract } = held({ originalSource: {
      goal: 'Rename the key.',
      criteria: ['The key is renamed everywhere.'],
      conversationContext: [{ role: 'user', content: 'private earlier message' }],
      selectedDiffContext: { diff: 'private diff' },
    } as unknown as Contract['originalSource'] });
    for (const view of [service.get(contract.id), service.list()[0]]) {
      expect(view?.originalSource).toEqual({ goal: 'Rename the key.', criteria: ['The key is renamed everywhere.'] });
      expect(JSON.stringify(view)).not.toContain('private');
    }
  });

  test('a list leaves out the captured file manifest that a get returns', () => {
    const files = Array.from({ length: 10_000 }, (_, index) => ({ path: `src/file-${index}.ts`, kind: 'file' }));
    const { service, contract } = held({ inputSnapshot: { id: 'snap', files } as unknown as Contract['inputSnapshot'] });
    expect(service.list()[0]!.inputSnapshot).toBeUndefined();
    expect((service.get(contract.id)!.inputSnapshot as unknown as { files: unknown[] }).files).toHaveLength(10_000);
  });
});

describe('cancelling or answering a contract this runner does not run', () => {
  /** A runner that stores a running contract but has no live run for it, as after a resume that skipped it. */
  function heldForInspection(): { service: ContractOperatorService; id: string } {
    const base = fakeRunner();
    const contract = makeContract({ id: nextContractId(), status: 'running' });
    base.contracts.set(contract.id, contract);
    const runner = { ...base,
      cancel: () => false,
      reply: async () => { throw new OwnerReplyRefusedError(`contract ${contract.id} is not running`, 'ended'); } };
    return { service: createContractOperatorService({ runner, workingDirectory: WORKDIR }), id: contract.id };
  }

  test('cancel says it is not running rather than that it already ended', async () => {
    const { service, id } = heldForInspection();
    expect(await refusal(() => service.cancel(id, 'stop'))).toEqual(['CONTRACT_NOT_RUNNING', 409, undefined]);
  });

  test('reply says it is not running instead of failing with a server error', async () => {
    const { service, id } = heldForInspection();
    expect(await refusal(() => service.reply(id, `${id}.e1`, 'approve'))).toEqual(['CONTRACT_NOT_RUNNING', 409, undefined]);
  });

  test('reply twice to one escalation; the second is 409, not 500', async () => {
    const base = fakeRunner();
    const contract = makeContract({ id: nextContractId(), status: 'running' });
    base.contracts.set(contract.id, contract);
    const refusals = { 'not-open': 'ESCALATION_NOT_OPEN', 'already-reading': 'ESCALATION_NOT_OPEN' } as const;
    for (const [reason, code] of Object.entries(refusals)) {
      const runner = { ...base, reply: async () => { throw new OwnerReplyRefusedError('refused', reason as 'not-open' | 'already-reading'); } };
      const service = createContractOperatorService({ runner, workingDirectory: WORKDIR });
      expect(await refusal(() => service.reply(contract.id, `${contract.id}.e1`, 'approve'))).toEqual([code, 409, undefined]);
    }
  });

  test('a reply the question does not accept is a 400 on the text field', async () => {
    const base = fakeRunner();
    const contract = makeContract({ id: nextContractId(), status: 'running' });
    base.contracts.set(contract.id, contract);
    const runner = { ...base, reply: async () => { throw new OwnerReplyRefusedError('not an answer', 'not-an-answer'); } };
    const service = createContractOperatorService({ runner, workingDirectory: WORKDIR });
    expect(await refusal(() => service.reply(contract.id, `${contract.id}.e1`, 'maybe'))).toEqual(['INVALID_ARGUMENT', 400, 'text']);
  });

  test('a failure that is not a refusal still propagates', async () => {
    const base = fakeRunner();
    const contract = makeContract({ id: nextContractId(), status: 'running' });
    base.contracts.set(contract.id, contract);
    const runner = { ...base, reply: async () => { throw new Error('disk failed'); } };
    const service = createContractOperatorService({ runner, workingDirectory: WORKDIR });
    await expect(service.reply(contract.id, `${contract.id}.e1`, 'approve')).rejects.toThrow('disk failed');
  });

  test('a contract that really ended still answers cancel with false', () => {
    const base = fakeRunner();
    const ended = makeContract({ id: nextContractId(), status: 'passed' });
    base.contracts.set(ended.id, ended);
    const service = createContractOperatorService({ runner: { ...base, cancel: () => false }, workingDirectory: WORKDIR });
    expect(service.cancel(ended.id, 'stop')).toBe(false);
  });

  test('native work is refused with its own code and a conflict status', () => {
    const service = createContractOperatorService({ runner: fakeRunner(), workingDirectory: WORKDIR });
    const native = fakeRunner();
    const contract = makeContract({ id: nextContractId(), status: 'running' });
    native.contracts.set(contract.id, contract);
    service.attachNative(native);
    try {
      service.cancel(contract.id, 'stop');
      throw new Error('cancel was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractOperatorError);
      expect(error).toMatchObject({ code: 'CONTRACT_NATIVE', status: 409 });
    }
  });
});
