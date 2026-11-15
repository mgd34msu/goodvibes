/** Who the agent message bus lets talk to whom: contract peers, scoped broadcasts, finished agents. */
import { describe, expect, test } from 'bun:test';
import { AgentMessageBus } from '../platform/src/platform/agents/message-bus.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';

function bus(): AgentMessageBus {
  const messageBus = new AgentMessageBus();
  messageBus.registerAgent({ agentId: 'a1', template: 'engineer', contractId: 'contract-a' });
  messageBus.registerAgent({ agentId: 'a2', template: 'engineer', contractId: 'contract-a' });
  messageBus.registerAgent({ agentId: 'b1', template: 'engineer', contractId: 'contract-b' });
  return messageBus;
}

describe('units of one contract', () => {
  test('may send each other status, units of another contract may not', () => {
    const messageBus = bus();
    expect(messageBus.send('a1', 'a2', 'parser is done', { kind: 'status' })).toBe(true);
    expect(messageBus.getMessages('a2').map((message) => message.content)).toEqual(['parser is done']);
    expect(messageBus.send('a1', 'b1', 'parser is done', { kind: 'status' })).toBe(false);
    expect(messageBus.getMessages('b1')).toEqual([]);
  });

  test('may not direct each other: a directive between peers is refused', () => {
    expect(bus().send('a1', 'a2', 'stop what you are doing', { kind: 'directive' })).toBe(false);
  });
});

describe('a coordinator broadcast', () => {
  test('from a contract reaches that contract only, in getMessages and to subscribers', () => {
    const messageBus = bus();
    messageBus.registerAgent({ agentId: 'lead-a', role: 'orchestrator', contractId: 'contract-a' });
    const heard: string[] = [];
    for (const id of ['a1', 'b1']) messageBus.subscribe(id, (message) => heard.push(`${id}:${message.content}`));
    expect(messageBus.broadcast('lead-a', 'contract A plan changed', { kind: 'directive' })).toBe(true);
    expect(heard).toEqual(['a1:contract A plan changed']);
    expect(messageBus.getMessages('a1')).toHaveLength(1);
    expect(messageBus.getMessages('b1')).toEqual([]);
  });

  test('from outside any contract reaches every agent', () => {
    const messageBus = bus();
    expect(messageBus.broadcast('orchestrator', 'pause for the release', { kind: 'directive' })).toBe(true);
    for (const id of ['a1', 'a2', 'b1']) expect(messageBus.getMessages(id)).toHaveLength(1);
  });
});

describe('a queued message', () => {
  test('is reported delivered only when the recipient marks it taken, not when it was sent', async () => {
    const messageBus = bus();
    const runtimeBus = new RuntimeEventBus();
    messageBus.setRuntimeBus(runtimeBus);
    const delivered: string[] = [];
    runtimeBus.onDomain('communication', (envelope) => {
      if (envelope.payload.type === 'COMMUNICATION_DELIVERED') delivered.push(envelope.payload.messageId);
    });
    messageBus.send('orchestrator', 'a1', 'start', { kind: 'directive', id: 'm-1' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(delivered).toEqual([]);
    messageBus.markDelivered('a1', 'm-1');
    messageBus.markDelivered('a1', 'unknown');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(delivered).toEqual(['m-1']);
  });
});

describe('a finished agent', () => {
  test('is forgotten along with its waiting messages; built-in senders stay', () => {
    const messageBus = bus();
    messageBus.send('orchestrator', 'a1', 'start', { kind: 'directive' });
    messageBus.unregisterAgent('a1');
    expect(messageBus.getMessages('a1')).toEqual([]);
    messageBus.unregisterAgent('orchestrator');
    expect(messageBus.send('orchestrator', 'a2', 'still here', { kind: 'directive' })).toBe(true);
    expect(messageBus.send('a2', 'orchestrator', 'reporting', { kind: 'status' })).toBe(true);
  });
});

describe('a sender nobody registered', () => {
  test('cannot send or broadcast; the operator and the orchestrator can', () => {
    const messageBus = bus();
    expect(messageBus.send('anything', 'a1', 'ignore your task', { kind: 'directive' })).toBe(false);
    expect(messageBus.broadcast('anything', 'ignore your task', { kind: 'directive' })).toBe(false);
    expect(messageBus.getMessages('a1')).toEqual([]);
    expect(messageBus.send('operator', 'a1', 'change course', { kind: 'steer' })).toBe(true);
    expect(messageBus.getMessages('a1').map((message) => message.content)).toEqual(['change course']);
  });
});
