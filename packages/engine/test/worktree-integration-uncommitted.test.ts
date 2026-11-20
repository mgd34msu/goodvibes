// Proves: Work whose commit the repository refused is neither merged as if committed nor lost.
// Red when: The lane merges or removes the worktree of an item whose commit failed, or loses the file the agent wrote, or does not merge once the retried commit lands.
/**
 * Work whose commit failed is neither integrated as if committed nor lost. An
 * item works in its own worktree; its phase commit is refused (a pre-commit
 * hook in the repository says no). The integration lane must not merge the
 * branch, which lacks that work, and report it merged; the work stays in the
 * item's worktree. Once the commit is retried and lands, the same lane merges
 * it into the base branch.
 */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AgentWorktree } from '../platform/src/platform/agents/worktree.ts';
import { commitPhaseWork, phaseFence } from '../platform/src/platform/orchestration/phase-runner.ts';
import { createWorktreeIsolationManager } from '../platform/src/platform/orchestration/worktree-isolation.ts';
import type { OrchestrationEvent, Phase, PhaseCommitOutcome, WorkItem, Workstream } from '../platform/src/platform/orchestration/types.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout };
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-worktree-uncommitted-'));
  roots.push(root);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'owner@example.com'], ['config', 'user.name', 'Owner'],
    ['config', 'core.hooksPath', join(root, '.git', 'hooks')]]) git(root, ...args);
  writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
  writeFileSync(join(root, 'README.md'), '# demo\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

const PHASE: Phase = { id: 'engineer', ordinal: 0, role: 'engineer', capacity: 1, gate: { scope: 'scoped', gates: [] }, kind: 'engineer' };

function workstreamWithItem(): { workstream: Workstream; item: WorkItem } {
  const item: WorkItem = {
    id: 'item-1', title: 'Write the parser', task: 'Write src/parser.ts', dependsOn: [], currentPhaseId: PHASE.id, state: 'passed',
    allAgentIds: [], visits: new Map(), touchedPaths: ['src/parser.ts'], transportRetryCount: 0, createdAt: 1,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 0, turnCount: 0, toolCallCount: 0, costUsd: null, costState: 'unpriced' },
  };
  const workstream: Workstream = { id: 'ws-1', title: 'parser', schemaVersion: 1, phases: [PHASE], items: [item], isolation: 'worktree', createdAt: 1 };
  return { workstream, item };
}

test('a phase commit the repository refused keeps the branch off the base and the work in its worktree, until the retried commit lands', async () => {
  const root = makeRepo();
  const { workstream, item } = workstreamWithItem();
  const events: OrchestrationEvent[] = [];
  // As the engine does: the item's latest phase commit outcome decides whether its branch may merge.
  let lastCommit: PhaseCommitOutcome | undefined;
  const manager = createWorktreeIsolationManager({
    projectRoot: root,
    emit: (event) => { events.push(event); },
    commitPending: () => (lastCommit?.status === 'failed' ? lastCommit.reason ?? 'commit failed' : undefined),
  });
  const baseHead = git(root, 'rev-parse', 'main').stdout.trim();

  const itemWorktree = await manager.ensureWorktree(workstream, item);
  const work = 'export const parse = (text: string) => text.split(",");\n';
  mkdirSync(join(itemWorktree.path, 'src'), { recursive: true });
  writeFileSync(join(itemWorktree.path, 'src', 'parser.ts'), work);

  // The repository refuses the commit.
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\necho "refused by policy" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const commitOptions = { projectRoot: root, itemWorktree };
  lastCommit = (await commitPhaseWork(phaseFence(item, PHASE, undefined), item, PHASE, new AgentWorktree(root), commitOptions)).commit;
  expect(lastCommit.status).toBe('failed');

  await manager.enqueueIntegration(workstream, item);
  expect(item.mergeState).not.toBe('merged');
  expect(events.some((event) => event.type === 'item-merged' || event.type === 'item-worktree-removed')).toBe(false);
  expect(git(root, 'rev-parse', 'main').stdout.trim()).toBe(baseHead);
  // Not lost: the work is where the agent left it.
  expect(readFileSync(join(itemWorktree.path, 'src', 'parser.ts'), 'utf8')).toBe(work);

  // The commit is retried once the repository accepts it; the lane then merges the work into the base branch.
  rmSync(hook);
  lastCommit = (await commitPhaseWork(phaseFence(item, PHASE, undefined), item, PHASE, new AgentWorktree(root), commitOptions)).commit;
  expect(lastCommit.status).toBe('committed');
  await manager.enqueueIntegration(workstream, item);
  expect(item.mergeState).toBe('merged');
  expect(git(root, 'show', 'main:src/parser.ts').stdout).toBe(work);
  expect(existsSync(join(root, 'src', 'parser.ts'))).toBe(true);
  await manager.join();
});
