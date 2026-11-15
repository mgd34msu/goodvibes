import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.ts';
import { getPlaybook, getPlaybookRegistry } from '../platform/src/platform/runtime/ops/index.ts';
import { withOpsRuntimeContext } from '../platform/src/platform/runtime/ops/runtime-context.ts';

describe('ops playbook checks', () => {
  test('a check that cannot see live state says it was not evaluated instead of failing', async () => {
    for (const { playbook } of getPlaybookRegistry().values()) {
      for (const check of playbook.checks) {
        const result = await check.run();
        if (!result.passed) {
          expect(result.evaluated, `${playbook.id}/${check.id}`).toBe(false);
          expect(result.severity, `${playbook.id}/${check.id}`).toBe('info');
        }
      }
    }
  });

  test('a step is only marked automatable when it names a command', () => {
    for (const { playbook } of getPlaybookRegistry().values()) {
      for (const step of playbook.steps) {
        if (step.automatable) expect(step.command, `${playbook.id}/${step.step}`).toBeTruthy();
      }
    }
  });

  test('the registered stuck-turn playbook reads the enclosing ops runtime context', async () => {
    const store = createRuntimeStore();
    const now = 1_700_000_100_000;
    store.setState((state) => ({
      ...state,
      conversation: { ...state.conversation, currentTurnId: 'turn-live', turnState: 'streaming', turnStartedAt: now - 45_000 },
    }));
    const check = getPlaybook('stuck-turn')!.checks.find((c) => c.id === 'turn.timeout-elapsed')!;

    const outside = await check.run();
    expect(outside.evaluated).toBe(false);

    const inside = await withOpsRuntimeContext(
      { runtimeBus: new RuntimeEventBus(), store, recoveryFilePath: '/nonexistent/recovery', lastSessionPointerPath: '/nonexistent/pointer', now: () => now },
      () => check.run(),
    );
    expect(inside.evaluated).toBeUndefined();
    expect(inside.passed).toBe(false);
    expect(inside.summary).toContain('exceeded');
  });
});
