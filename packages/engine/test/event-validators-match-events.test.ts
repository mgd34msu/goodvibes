import { describe, expect, test } from 'bun:test';
import type { AgentEvent } from '../platform/src/events/agents.ts';
import type { ContractEvent } from '../platform/src/events/contract.ts';
import { isKnownEventType, validateKnownEvent } from '../platform/src/events/contracts.ts';
import type { PluginEvent } from '../platform/src/events/plugins.ts';

describe('validateKnownEvent accepts the events the platform emits', () => {
  test('AGENT_SPAWNING, with and without a contract role', () => {
    const plain: Extract<AgentEvent, { type: 'AGENT_SPAWNING' }> = { type: 'AGENT_SPAWNING', agentId: 'a1', task: 'fix it' };
    const owned: Extract<AgentEvent, { type: 'AGENT_SPAWNING' }> = { ...plain, contractId: 'c1', contractRole: 'owner' };
    expect(validateKnownEvent(plain)).toEqual({ valid: true, violations: [] });
    expect(validateKnownEvent(owned)).toEqual({ valid: true, violations: [] });
    expect(validateKnownEvent({ ...plain, contractRole: 'janitor' }).valid).toBe(false);
  });

  test('PLUGIN_LOADED carries the plugin id and its capabilities', () => {
    const loaded: Extract<PluginEvent, { type: 'PLUGIN_LOADED' }> = { type: 'PLUGIN_LOADED', pluginId: 'p1', version: '1.0.0', capabilities: ['tools'] };
    expect(validateKnownEvent(loaded)).toEqual({ valid: true, violations: [] });
    expect(validateKnownEvent({ type: 'PLUGIN_LOADED', pluginId: 'p1', version: '1.0.0' }).valid).toBe(false);
  });

  test('CONTRACT_OWNER_REPLIED takes only the actions the runner can report', () => {
    const replied: Extract<ContractEvent, { type: 'CONTRACT_OWNER_REPLIED' }> = {
      type: 'CONTRACT_OWNER_REPLIED', contractId: 'c', escalationId: 'e', reading: 'approve', outcome: 'act', action: 'approved',
    };
    expect(validateKnownEvent(replied).valid).toBe(true);
    const unknownAction = validateKnownEvent({ ...replied, action: 'anything' });
    expect(unknownAction.valid).toBe(false);
    expect(unknownAction.violations.join(' ')).toContain('action must be one of');
  });
});

describe('TURN_ERROR optional failure facts', () => {
  test('a numeric status and a string code are accepted, other types are refused', () => {
    const base = { type: 'TURN_ERROR', turnId: 't', error: 'boom', stopReason: 'provider_error' };
    expect(validateKnownEvent({ ...base, status: 401, code: 'ECONNREFUSED' }).valid).toBe(true);
    expect(validateKnownEvent(base).valid).toBe(true);
    expect(validateKnownEvent({ ...base, status: '401' }).valid).toBe(false);
    expect(validateKnownEvent({ ...base, code: 5 }).valid).toBe(false);
  });
});

describe('the registry answers only for registered event types', () => {
  test('names inherited from Object.prototype are not event types', () => {
    for (const type of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(isKnownEventType(type)).toBe(false);
      const result = validateKnownEvent({ type });
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual([`unknown event type: '${type}'`]);
    }
  });

  test('a registered type is known', () => {
    expect(isKnownEventType('AGENT_SPAWNING')).toBe(true);
  });
});
