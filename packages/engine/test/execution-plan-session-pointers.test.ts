/**
 * Two sessions in one project each keep their own active plan, and a plan
 * parse failure keeps its own identity.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionPlanManager, PlanStatusUnavailableError } from '../platform/src/platform/core/execution-plan.ts';
import { JudgmentInputError } from '../platform/src/platform/gate/judgment-input.ts';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';

const roots: string[] = [];
function root(): string { const dir = mkdtempSync(join(tmpdir(), 'plan-pointers-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('active plan per session', () => {
  test('each session keeps its own plan when another session creates one in the same project', () => {
    const dir = root();
    const sessionA = new ExecutionPlanManager(dir);
    const sessionB = new ExecutionPlanManager(dir);
    const planA = sessionA.create('Plan A', [], 'session-a');
    const planB = sessionB.create('Plan B', [], 'session-b');

    expect(sessionA.getActive('session-a')?.id).toBe(planA.id);
    expect(sessionB.getActive('session-b')?.id).toBe(planB.id);
    expect(sessionA.getActive('session-b')?.id).toBe(planB.id);
  });

  test('dismissing one session\'s plan leaves the other session\'s plan active', () => {
    const dir = root();
    const manager = new ExecutionPlanManager(dir);
    const planA = manager.create('Plan A', [], 'session-a');
    manager.create('Plan B', [], 'session-b');

    expect(manager.dismiss('session-b').outcome).toBe('dismissed');
    expect(manager.getActive('session-b')).toBeNull();
    expect(manager.getActive('session-a')?.id).toBe(planA.id);
    expect(manager.dismiss('session-a').outcome).toBe('dismissed');
  });

  test('the plans listing is not affected by the per-session pointers', () => {
    const dir = root();
    const manager = new ExecutionPlanManager(dir);
    manager.create('Plan A', [], 'session-a');
    manager.create('Plan B', [], 'session-b');

    expect(manager.list().map((plan) => plan.title).sort()).toEqual(['Plan A', 'Plan B']);
  });

  test('a pointer written before per-session pointers existed still resolves for its session', () => {
    const dir = root();
    const writer = new ExecutionPlanManager(dir);
    const plan = writer.create('Plan A', [], 'session-a');
    // Remove the per-session pointer to leave only the shared one.
    rmSync(join(dir, '.goodvibes', 'plans', 'active'), { recursive: true, force: true });
    expect(existsSync(join(dir, '.goodvibes', 'plans', 'active.json'))).toBe(true);

    const reader = new ExecutionPlanManager(dir);
    expect(reader.getActive('session-a')?.id).toBe(plan.id);
    expect(reader.getActive('session-b')).toBeNull();

    // A second session creating a plan does not orphan the first one's old pointer.
    reader.create('Plan B', [], 'session-b');
    expect(reader.getActive('session-a')?.id).toBe(plan.id);
  });

  test('a session id with path characters cannot write outside the plans directory', () => {
    const dir = root();
    const manager = new ExecutionPlanManager(dir);
    const plan = manager.create('Plan', [], '../../escape');

    expect(manager.getActive('../../escape')?.id).toBe(plan.id);
    expect(existsSync(join(dir, 'escape.json'))).toBe(false);
  });
});

describe('parseFromMarkdown failures', () => {
  test('a cancelled parse reports the cancellation, not an unavailable reader', async () => {
    const manager = new ExecutionPlanManager(root());
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled by the owner', 'AbortError'));

    const failure = await manager.parseFromMarkdown('# Plan\n## Phase 1\n- [ ] A', { signal: controller.signal }).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(PlanStatusUnavailableError);
    expect(failure).toMatchObject({ name: 'AbortError' });
  });

  test('markdown carrying credential material is refused as such, not as a reader outage', async () => {
    const manager = new ExecutionPlanManager(root());
    const failure = await withDecisionModelPolicy(() => 'Default - On', () => manager
      .parseFromMarkdown('# Plan\n## Phase 1\n- [ ] A -- DONE\npassword=private-value')).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JudgmentInputError);
    expect(failure).not.toBeInstanceOf(PlanStatusUnavailableError);
  });
});
