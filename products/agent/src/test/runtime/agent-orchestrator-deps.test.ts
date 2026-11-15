import { describe, expect, test } from 'bun:test';
import { installAgentOrchestratorDependencies } from '../../runtime/agent-orchestrator-deps.ts';

describe('installAgentOrchestratorDependencies', () => {
  test('installs the dependencies and the permission manager in one call', () => {
    const received: unknown[] = [];
    const manager = { id: 'manager' } as never;
    installAgentOrchestratorDependencies({ setDependencies: (deps) => { received.push(deps); } }, { surfaceRoot: 'agent' } as never, manager);
    expect(received).toEqual([{ surfaceRoot: 'agent', permissionManager: manager }]);
  });

  test('refuses to install without a manager, so no agent can run ungated', () => {
    const received: unknown[] = [];
    expect(() => installAgentOrchestratorDependencies({ setDependencies: (deps) => { received.push(deps); } }, { surfaceRoot: 'agent' } as never, undefined)).toThrow('permission manager');
    expect(received).toEqual([]);
  });
});
