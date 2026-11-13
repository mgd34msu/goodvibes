import { describe, expect, setSystemTime, test } from 'bun:test';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentResearchRunRegistry, researchRunReportLine, researchRunStorePath } from '../../agent/research-run-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeRegistry(): { readonly root: string; readonly registry: AgentResearchRunRegistry; readonly cleanup: () => void } {
  const root = makeProjectTempDir('goodvibes-agent-research-runs');
  const shellPaths = {
    resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
  };
  return {
    root,
    registry: AgentResearchRunRegistry.fromShellPaths(shellPaths),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('AgentResearchRunRegistry', () => {
  test('native checkpoint IDs remain admissible and distinct at a card-shaped clock instant', () => {
    const fixture = makeRegistry();
    setSystemTime(new Date('2026-10-13T15:00:01.000Z'));
    try {
      expect(() => snapshotJudgmentInput('cp-20261013150001-1')).toThrow();
      const run = fixture.registry.create({ title: 'Clock regression', question: 'Review the published source.' });
      fixture.registry.start(run.id);
      fixture.registry.checkpoint(run.id, { phase: 'reading', note: 'Read the first source.' });
      const next = fixture.registry.checkpoint(run.id, { phase: 'reading', note: 'Read the second source.' });
      const ids = next.checkpoints.map(checkpoint => checkpoint.id);
      expect(new Set(ids).size).toBe(2);
      for (const checkpoint of next.checkpoints) {
        expect(checkpoint.id).toMatch(/^cp-[a-j]{14}-[0-9a-z]+$/);
        expect(snapshotJudgmentInput(checkpoint)).toEqual(checkpoint);
        expect(checkpoint.at).toBe('2026-10-13T15:00:01.000Z');
      }
      expect(fixture.registry.get(run.id)?.checkpoints.map(checkpoint => checkpoint.id)).toEqual(ids);
    } finally { setSystemTime(); fixture.cleanup(); }
  });

  test('stores project-local checkpointable research runs', () => {
    const fixture = makeRegistry();
    try {
      const run = fixture.registry.create({
        title: 'Local model research',
        question: 'Which local model setup should we recommend first?',
        goal: 'Produce a sourced recommendation.',
        plan: ['Survey local model options', 'Score setup friction'],
        nextSteps: ['Find official docs'],
      });

      expect(run.id).toBe('local-model-research');
      expect(run.status).toBe('planned');
      expect(run.phase).toBe('planning');
      expect(run.progress).toBe(0);
      expect(researchRunReportLine(run)).toContain('Local model research');
      expect(researchRunStorePath({
        resolveProjectPath: (...parts: string[]) => join(fixture.root, '.goodvibes', ...parts),
      })).toContain(join('.goodvibes', 'agent', 'research', 'runs.json'));
    } finally {
      fixture.cleanup();
    }
  });

  test('starts, checkpoints, pauses, resumes, completes, searches, and deletes runs', () => {
    const fixture = makeRegistry();
    try {
      const run = fixture.registry.create({
        title: 'Deep research',
        question: 'What competitors support?',
        plan: ['Inventory competitors'],
      });
      const started = fixture.registry.start(run.id, 'Beginning source collection.');
      expect(started.status).toBe('running');
      expect(started.progress).toBe(1);

      const checkpointed = fixture.registry.checkpoint(run.id, {
        phase: 'reading',
        progress: 45,
        note: 'Reviewed primary docs.',
        nextSteps: ['Summarize evidence'],
        sourceIds: ['official-docs'],
      });
      expect(checkpointed.status).toBe('running');
      expect(checkpointed.phase).toBe('reading');
      expect(checkpointed.sourceIds).toContain('official-docs');
      expect(checkpointed.checkpoints).toHaveLength(1);
      expect(fixture.registry.search('primary docs')).toHaveLength(1);

      const paused = fixture.registry.pause(run.id, 'Waiting on source review.');
      expect(paused.status).toBe('paused');
      const resumed = fixture.registry.resume(run.id, 'Continuing.');
      expect(resumed.status).toBe('running');
      const completed = fixture.registry.complete(run.id, { reportArtifactId: 'artifact-1', note: 'Report saved.' });
      expect(completed.status).toBe('completed');
      expect(completed.progress).toBe(100);
      expect(completed.reportArtifactId).toBe('artifact-1');
      expect(() => fixture.registry.cancel(run.id, 'Too late.')).toThrow('Cannot cancel completed research run');

      const deleted = fixture.registry.delete(run.id);
      expect(deleted.id).toBe(run.id);
      expect(fixture.registry.list()).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  test('records cancellation and failure as terminal states', () => {
    const fixture = makeRegistry();
    try {
      const cancelledRun = fixture.registry.create({
        title: 'Cancel me',
        question: 'Should this continue?',
      });
      const cancelled = fixture.registry.cancel(cancelledRun.id, 'User stopped this run.');
      expect(cancelled.status).toBe('cancelled');
      expect(() => fixture.registry.resume(cancelledRun.id)).toThrow('Cannot resume cancelled research run');

      const failedRun = fixture.registry.create({
        title: 'Fail me',
        question: 'Will this fail?',
      });
      const failed = fixture.registry.fail(failedRun.id, 'Source route unavailable.');
      expect(failed.status).toBe('failed');
      expect(fixture.registry.snapshot().failed).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });
  test('refuses illegal status moves and names the legal ones', () => {
    const fixture = makeRegistry();
    try {
      const run = fixture.registry.create({ title: 'Lifecycle', question: 'Which moves are legal?' });
      // planned: not pausable, not resumable; start is the way in.
      expect(() => fixture.registry.pause(run.id)).toThrow(/planned and cannot become paused; from planned it can become running/);
      expect(() => fixture.registry.resume(run.id)).toThrow(/planned.*start/i);
      fixture.registry.start(run.id);
      // running never returns to planned, by checkpoint or otherwise.
      expect(() => fixture.registry.checkpoint(run.id, { status: 'planned', note: 'reset' })).toThrow(/running and cannot become planned/);
      expect(fixture.registry.get(run.id)?.status).toBe('running');
      // start is for planned runs; paused/blocked runs use resume.
      fixture.registry.pause(run.id);
      expect(() => fixture.registry.start(run.id)).toThrow(/paused.*resume/i);
      expect(fixture.registry.resume(run.id).status).toBe('running');
      // blocked is left by resume, not parked by pause.
      fixture.registry.checkpoint(run.id, { status: 'blocked', note: 'search down' });
      expect(() => fixture.registry.pause(run.id)).toThrow(/blocked and cannot become paused/);
      expect(fixture.registry.resume(run.id).status).toBe('running');
      // a same-status checkpoint still works, and phase may move backwards.
      fixture.registry.checkpoint(run.id, { phase: 'reviewing', note: 'review' });
      expect(fixture.registry.checkpoint(run.id, { phase: 'searching', note: 're-search' }).phase).toBe('searching');
    } finally {
      fixture.cleanup();
    }
  });
});
