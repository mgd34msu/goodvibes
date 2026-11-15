import { describe, expect, test } from 'bun:test';
import { fleetKindOf, fleetKindPhrase, workSummary, type WorkItem } from './work-items';

describe('fleet kind words', () => {
  test('the contract kinds get words and are processes, not agents', () => {
    expect(fleetKindPhrase('contract')).toBe('Contract');
    expect(fleetKindPhrase('contract-group')).toBe('Contract group');
    expect(fleetKindPhrase('contract-unit')).toBe('Contract unit');
    expect(fleetKindOf({ kind: 'contract-unit' })).toBe('processes');
    expect(fleetKindOf({ kind: 'acp-agent' })).toBe('agents');
  });

  test('a kind this client does not know renders verbatim', () => {
    expect(fleetKindPhrase('quantum-process')).toBe('quantum-process');
    expect(fleetKindPhrase('  ')).toBe('Unknown kind');
    expect(fleetKindPhrase('constructor')).toBe('constructor');
  });
});

describe('the one-line summary', () => {
  const item = (key: string): WorkItem => ({ key, type: 'fleet', id: key, kind: 'processes', group: 'finished', title: key, meta: '', tone: 'idle', status: 'Done', depth: 0, sortAt: 0 });

  test('the archive counts what is archived', () => {
    expect(workSummary([item('a'), item('b')], true)).toBe('2 archived');
    expect(workSummary([], true)).toBe('nothing archived');
  });
});
