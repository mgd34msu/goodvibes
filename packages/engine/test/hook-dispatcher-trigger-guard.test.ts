import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { HookDispatcher } from '../platform/src/platform/hooks/dispatcher.ts';
import { logger } from '../platform/src/platform/utils/logger.ts';
import type { HookEvent } from '../platform/src/platform/hooks/types.ts';
import type { TriggerDefinition } from '../platform/src/platform/tools/workflow/index.ts';
import { killTriggerActions } from '../platform/src/platform/workflow/trigger-executor.ts';
import { waitFor } from './_helpers/test-timeout.ts';

const event: HookEvent = {
  path: 'Post:tool:exec', phase: 'Post', category: 'tool', specific: 'exec',
  sessionId: 'synthetic', timestamp: 0, payload: {},
};
// A command with no runnable segment: the exec command guard refuses it when AST checking is on.
const trigger = { id: 't1', enabled: true, event: 'Post:tool:exec', action: ';' } as TriggerDefinition;
const flags = { isEnabled: (id: string) => id === 'shell-ast-normalization' };

afterEach(() => { killTriggerActions(); });

describe('trigger actions fired by the hook dispatcher', () => {
  test('go through the exec command guard', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const dispatcher = new HookDispatcher();
      dispatcher.setTriggerManager({ list: () => [trigger] }, flags);
      await dispatcher.fire(event);
      await waitFor(() => warn.mock.calls.some(([message]) => String(message).includes('action refused by command guard')));
    } finally {
      warn.mockRestore();
    }
  });

  test('the disposer detaches the manager so later events fire nothing', async () => {
    const list = spyOn({ list: () => [trigger] }, 'list');
    const dispatcher = new HookDispatcher();
    const dispose = dispatcher.setTriggerManager({ list }, flags);
    dispose();
    await dispatcher.fire(event);
    expect(list).not.toHaveBeenCalled();
  });
});
