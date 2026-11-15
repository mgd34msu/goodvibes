import { describe, expect, test } from 'bun:test';
import { createRuntimeStore } from '../../runtime/store/index.ts';

describe('automation/control-plane foundation', () => {
  test('initial runtime store includes automation, routes, control-plane, and watcher domains', () => {
    const store = createRuntimeStore();
    const state = store.getState();

    expect(state.automation.jobs.size).toBe(0);
    expect(state.routes.bindings.size).toBe(0);
    expect(state.controlPlane.clients.size).toBe(0);
    expect(state.deliveries.deliveryAttempts.size).toBe(0);
    expect(state.watchers.watchers.size).toBe(0);
    expect(state.surfaces.surfaces.size).toBe(0);
    expect(state.routes.bindingIds).toEqual([]);
    expect(state.controlPlane.connectionState).toBe('disabled');
  });
});
