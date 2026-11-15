import { describe, expect, test } from 'bun:test';
import { attachHostedSessionCloseSync } from '../platform/src/platform/daemon/hosted-sessions-composition.js';

function fixture(brokerStatus: Record<string, 'active' | 'closed'>, live: string[]) {
  const killed: string[] = [];
  let listener: () => void = () => {};
  const manager = {
    list: () => live.map((id) => ({ id })),
    kill: async (id: string) => { killed.push(id); return {}; },
  };
  const broker = {
    getSession: (id: string) => (id in brokerStatus ? { status: brokerStatus[id] } : null),
    subscribe: (fn: () => void) => { listener = fn; return () => undefined; },
  };
  attachHostedSessionCloseSync(manager as never, broker as never);
  return { killed, change: () => listener() };
}

describe('closing a hosted session in the broker', () => {
  test('ends the hosted session whose record was closed, and only that one', () => {
    const { killed, change } = fixture({ a: 'closed', b: 'active' }, ['a', 'b']);
    change();
    expect(killed).toEqual(['a']);
  });

  test('a session not yet registered with the broker is left running', () => {
    const { killed, change } = fixture({}, ['fresh']);
    change();
    expect(killed).toEqual([]);
  });
});
