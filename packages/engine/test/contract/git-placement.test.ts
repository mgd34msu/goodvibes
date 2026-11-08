import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveContractGitPlacement } from '../../sdk/src/platform/contract/git-placement.js';
import { DurableContractAdmissions, type DurableContractRequest } from '../../sdk/src/platform/contract/durable-admission.js';
import { makeHarness, makeRepo, type Harness } from './runner-support.js';

const roots: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    const ids = h.runner.list({ includeTerminal: true }).map(c => c.id);
    h.dispose();
    await Promise.all(ids.map(id => h.runner.join(id)));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repo() { const root = makeRepo(); roots.push(root); return root; }
function request(root: string): DurableContractRequest {
  return { key: { workId: 'placement-work', criteriaId: 'criteria', criteriaRevision: '1', attemptId: 'attempt' },
    binding: { sourceId: 'source', inputRevision: '1', actionId: 'start', actionRevision: '1',
      authorityId: 'owner', authorityRevision: '1', scopeId: 'project', scopeRevision: '1' },
    input: { ask: 'Preserve the originally selected repository', sessionId: 'placement', origin: 'cli', projectRoot: root, isolation: 'auto' } };
}
function harness(root: string) {
  const h = makeHarness({ root, contract: { maxActiveContracts: 0 }, scripts: {},
    durableAdmission: { withCurrent: (_admission, launch) => launch(() => undefined) } });
  harnesses.push(h);
  return h;
}

test('asynchronous placement resolves the actual project branch and detached HEAD', async () => {
  const root = repo();
  const signal = new AbortController().signal;
  expect(await resolveContractGitPlacement('auto', root, 'ctr-placement', signal)).toEqual({
    isolation: 'worktree', branch: 'contract/placement', worktreePath: join(root, '.goodvibes', '.worktrees', 'contract', 'placement'), baseBranch: 'main',
  });
  const head = childProcess.spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  expect(head.status).toBe(0);
  expect(childProcess.spawnSync('git', ['-C', root, 'checkout', '--detach', '--quiet', 'HEAD']).status).toBe(0);
  expect((await resolveContractGitPlacement('worktree', root, 'ctr-detached', signal)).baseBranch).toBe(head.stdout.trim());
  const plain = mkdtempSync(join(tmpdir(), 'contract-plain-placement-')); roots.push(plain);
  expect(await resolveContractGitPlacement('auto', plain, 'ctr-plain', signal)).toEqual({ isolation: 'shared' });
  await expect(resolveContractGitPlacement('worktree', plain, 'ctr-plain', signal)).rejects.toThrow('HEAD is unavailable');
});

test('explicit shared placement and a pre-aborted owner start no Git process', async () => {
  const tapped = spyOn(childProcess, 'spawn');
  try {
    const owner = new AbortController();
    expect(await resolveContractGitPlacement('shared', '/unused', 'ctr-shared', owner.signal)).toEqual({ isolation: 'shared' });
    owner.abort(new Error('closed placement owner'));
    await expect(resolveContractGitPlacement('worktree', '/unused', 'ctr-aborted', owner.signal)).rejects.toThrow('closed placement owner');
    expect(tapped).not.toHaveBeenCalled();
  } finally { tapped.mockRestore(); }
});

/** Hold one real child with native stdio. Its parent event loop remains free;
 * SIGTERM completes the metadata read, while disposal must kill and drain it. */
function holdFirstMetadata() {
  const spawn = childProcess.spawn;
  let child: ReturnType<typeof childProcess.spawn> | undefined;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const tap = spyOn(childProcess, 'spawn').mockImplementation(((...args: Parameters<typeof childProcess.spawn>) => {
    const [command, argv] = args;
    if (child !== undefined || command !== 'git' || !Array.isArray(argv) || !argv.includes('rev-parse')) return spawn(...args);
    child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000); process.stdout.write('1111111111111111111111111111111111111111\\n');"], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.once('data', () => entered());
    child.once('error', () => entered());
    return child;
  }) as typeof childProcess.spawn);
  return { ready, resume: () => child?.kill('SIGTERM'),
    active: () => child !== undefined && child.exitCode === null && child.signalCode === null,
    async close() {
      tap.mockRestore();
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>(resolve => child!.once('close', () => resolve()));
        child.kill('SIGKILL'); await closed;
      }
    } };
}

test('durable admission prepares Git asynchronously before creating an owner and retains its original request', async () => {
  const root = repo();
  const h = harness(root);
  const metadata = holdFirstMetadata();
  const sync = spyOn(childProcess, 'spawnSync').mockImplementation(() => { throw new Error('Synchronous Git is forbidden during durable admission'); });
  try {
    const submitted = request(root);
    const original = structuredClone(submitted);
    const pending = h.runner.startDurable(submitted);
    void pending.catch(() => {});
    await metadata.ready;
    expect(h.manager.list()).toHaveLength(0);
    expect(new DurableContractAdmissions(root).read(original.key)).toBeNull();
    (submitted.input as { projectRoot: string; ask: string; isolation: string }).projectRoot = '/replacement-root';
    (submitted.input as { ask: string }).ask = 'Replacement request';
    (submitted.input as { isolation: string }).isolation = 'shared';
    // A synchronous metadata read would prevent this task from running until
    // the child returned; the child is deliberately still waiting here.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    metadata.resume();
    const started = await pending;
    expect(started.contract.projectRoot).toBe(root);
    expect(started.contract.ask).toBe(original.input.ask);
    expect(started.admission.execution).toMatchObject({ isolation: 'worktree', baseBranch: 'main' });
    expect(h.manager.list()).toHaveLength(1);
    expect((await h.runner.startDurable(original)).admission.contractId).toBe(started.admission.contractId);
    expect(sync).not.toHaveBeenCalled();
  } finally { sync.mockRestore(); await metadata.close(); }
});

test('disposal cancels and drains pre-admission Git before releasing the durable lease', async () => {
  const root = repo();
  const h = harness(root);
  const submitted = request(root);
  const metadata = holdFirstMetadata();
  try {
    const pending = h.runner.startDurable(submitted);
    void pending.catch(() => {});
    await metadata.ready;
    h.runner.dispose();
    await expect(pending).rejects.toThrow('disposed');
    expect(h.manager.list()).toHaveLength(0);
    const admissions = new DurableContractAdmissions(root);
    expect(admissions.read(submitted.key)).toBeNull();
    const release = await admissions.lease(submitted.key);
    release();
    await metadata.close();
  } finally { await metadata.close(); }
});

for (const mode of ['ask', 'draft'] as const) {
  test(`compatibility ${mode} startup prepares asynchronously before owner publication and keeps the original input`, async () => {
    const root = repo(), h = harness(root), metadata = holdFirstMetadata();
    const sync = spyOn(childProcess, 'spawnSync').mockImplementation(() => { throw new Error('Synchronous startup Git is forbidden'); });
    try {
      const input = { ask: 'Original approved work', sessionId: 'compatibility', origin: 'cli' as const, projectRoot: root,
        isolation: 'auto' as const, budget: { maxTokens: 1000 }, proposedUnits: [{ task: 'Original unit' }] };
      const draft = { goal: input.ask, units: [{ id: 'one', title: 'Original', brief: 'Original task', dependsOn: [], files: ['original.ts'] }] };
      const pending = mode === 'ask' ? h.runner.start(input) : h.runner.startFromPlan({ ...input, draft });
      void pending.catch(() => {});
      await metadata.ready;
      expect(h.manager.list()).toHaveLength(0); expect(h.runner.list()).toHaveLength(0);
      input.ask = 'Replacement'; input.projectRoot = '/different-project'; input.budget.maxTokens = 1;
      input.proposedUnits[0]!.task = 'Replacement unit'; draft.units[0]!.brief = 'Replacement task'; draft.units[0]!.files[0] = 'replacement.ts';
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      metadata.resume();
      const started = await pending;
      expect(started.contract).toMatchObject({ ask: 'Original approved work', projectRoot: root,
        budget: { maxTokens: 1000 }, isolation: 'worktree', baseBranch: 'main' });
      if (mode === 'ask') expect(started.contract.proposedUnits).toEqual([{ task: 'Original unit' }]);
      else expect(started.contract.draftPlan?.units[0]).toMatchObject({ brief: 'Original task', files: ['original.ts'] });
      expect(sync).not.toHaveBeenCalled();
    } finally { sync.mockRestore(); await metadata.close(); }
  });
}

test('the original start signal and assertion cannot be replaced during preparation', async () => {
  const root = repo(), h = harness(root), metadata = holdFirstMetadata();
  const original = new AbortController(); let current = true;
  const options = { signal: original.signal, assertCurrent: () => { if (!current) throw new Error('Original start retired'); } };
  try {
    const pending = h.runner.start(request(root).input, options); void pending.catch(() => {});
    await metadata.ready;
    options.signal = new AbortController().signal; options.assertCurrent = () => {};
    current = false; metadata.resume();
    await expect(pending).rejects.toThrow('Original start retired');
    expect(h.manager.list()).toHaveLength(0); expect(h.runner.list()).toHaveLength(0);
    const aborted = h.runner.start(request(root).input, { signal: original.signal }); void aborted.catch(() => {});
    original.abort(new Error('Original start aborted'));
    await expect(aborted).rejects.toThrow('Original start aborted');
    expect(h.manager.list()).toHaveLength(0);
  } finally { await metadata.close(); }
});

test('owned AgentManager startup keeps the preparing child owned until cancellation drains it', async () => {
  const root = repo(), h = harness(root); h.manager.setContractRunner(h.runner);
  const metadata = holdFirstMetadata();
  try {
    const execution = h.manager.spawnOwned({ mode: 'spawn', task: 'Prepare the original owner contract' });
    await metadata.ready;
    expect(execution.record.contractId).toBeUndefined(); expect(h.runner.list()).toHaveLength(0);
    let settled = false; const done = execution.settled.then(record => { settled = true; return record; });
    expect(settled).toBe(false); execution.cancel();
    expect((await done).status).toBe('cancelled');
    await h.manager.join(execution.record.id);
    expect(metadata.active()).toBe(false); expect(h.runner.list()).toHaveLength(0);
  } finally { await metadata.close(); }
});

test('a changed pending agent record cannot retarget the contract prepared for it', async () => {
  const root = repo(), h = harness(root); h.manager.setContractRunner(h.runner);
  const metadata = holdFirstMetadata();
  try {
    const execution = h.manager.spawnOwned({ mode: 'spawn', task: 'Original owner task' });
    await metadata.ready;
    execution.record.task = 'Replacement owner task'; metadata.resume();
    expect((await execution.settled).status).toBe('failed');
    expect(h.runner.list()).toHaveLength(0); expect(execution.record.contractId).toBeUndefined();
  } finally { await metadata.close(); }
});

test('disposal and invalid asynchronous guards admit no compatibility owner', async () => {
  const root = repo(), h = harness(root), metadata = holdFirstMetadata();
  try {
    await expect(h.runner.start({ ...request(root).input, isolation: 'shared' }, {
      assertCurrent: () => Promise.reject(new Error('Private rejected guard')),
    })).rejects.toThrow('synchronous current owner');
    const pending = h.runner.start(request(root).input); void pending.catch(() => {});
    await metadata.ready; h.runner.dispose();
    await expect(pending).rejects.toThrow('disposed');
    expect(metadata.active()).toBe(false); expect(h.manager.list()).toHaveLength(0);
  } finally { await metadata.close(); }
});
