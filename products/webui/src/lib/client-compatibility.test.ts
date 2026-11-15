import { describe, expect, test } from 'bun:test';
import { invalidateClientLifetime } from './client-lifetime';
import {
  CLIENT_COMPATIBILITY_FLOOR_HEADER,
  compareBuildVersions,
  evaluateClientCompatibility,
  getObservedClientCompatibilityFloor,
  readClientCompatibilityFloor,
  recordObservedClientCompatibilityFloor,
} from './client-compatibility';

describe('compareBuildVersions', () => {
  test('orders by numeric segment, not lexicographically', () => {
    expect(compareBuildVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(compareBuildVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareBuildVersions('1.14.0', '1.14.0')).toBe(0);
  });

  test('a release candidate of an earlier release still compares as earlier', () => {
    expect(compareBuildVersions('1.13.9-rc.1', '1.14.0')).toBeLessThan(0);
  });

  test('a missing trailing segment reads as 0', () => {
    expect(compareBuildVersions('1.14', '1.14.0')).toBe(0);
  });
});

describe('evaluateClientCompatibility', () => {
  test('no floor published is ok. The daemon is not asking for anything', () => {
    const verdict = evaluateClientCompatibility({ clientVersion: '1.0.0', floor: undefined });
    expect(verdict.status).toBe('ok');
    expect(verdict.floor).toBeUndefined();
  });

  test('a client version below the floor is restart-required, naming both builds', () => {
    const verdict = evaluateClientCompatibility({ clientVersion: '1.12.1', floor: '1.14.0' });
    expect(verdict.status).toBe('restart-required');
    expect(verdict.message).toContain('1.12.1');
    expect(verdict.message).toContain('1.14.0');
  });

  test('a client version at or above the floor is ok', () => {
    expect(evaluateClientCompatibility({ clientVersion: '1.14.0', floor: '1.14.0' }).status).toBe('ok');
    expect(evaluateClientCompatibility({ clientVersion: '1.20.0', floor: '1.14.0' }).status).toBe('ok');
  });

  test('an absent or unparseable client version is unknown, never a false ok', () => {
    expect(evaluateClientCompatibility({ clientVersion: undefined, floor: '1.14.0' }).status).toBe('unknown');
    expect(evaluateClientCompatibility({ clientVersion: 'dev', floor: '1.14.0' }).status).toBe('unknown');
  });
});

describe('readClientCompatibilityFloor', () => {
  test('reads the header from a Headers object', () => {
    const upper = new Headers({ [CLIENT_COMPATIBILITY_FLOOR_HEADER]: '1.14.0' });
    expect(readClientCompatibilityFloor(upper)).toBe('1.14.0');
  });

  // A header source whose lookup is case-sensitive, as a plain map of headers is.
  const caseSensitive = (entries: Record<string, string>) => ({ get: (name: string) => entries[name] ?? null });

  test('reads the exact-case key from a case-sensitive source', () => {
    expect(readClientCompatibilityFloor(caseSensitive({ [CLIENT_COMPATIBILITY_FLOOR_HEADER]: '1.14.0' }))).toBe('1.14.0');
  });

  test('falls back to the lowercased key when the exact-case key is absent', () => {
    const lower = caseSensitive({ [CLIENT_COMPATIBILITY_FLOOR_HEADER.toLowerCase()]: '1.15.0' });
    expect(readClientCompatibilityFloor(lower)).toBe('1.15.0');
  });

  test('prefers the exact-case key over the lowercased one', () => {
    const both = caseSensitive({
      [CLIENT_COMPATIBILITY_FLOOR_HEADER]: '1.14.0',
      [CLIENT_COMPATIBILITY_FLOOR_HEADER.toLowerCase()]: '1.15.0',
    });
    expect(readClientCompatibilityFloor(both)).toBe('1.14.0');
  });

  test('undefined when the header is absent or blank', () => {
    expect(readClientCompatibilityFloor(new Headers())).toBeUndefined();
    expect(readClientCompatibilityFloor(new Headers({ [CLIENT_COMPATIBILITY_FLOOR_HEADER]: '   ' }))).toBeUndefined();
    expect(readClientCompatibilityFloor(undefined)).toBeUndefined();
  });
});

describe('observed floor store', () => {
  test('a response without the header keeps the floor already seen; a client lifetime change clears it', () => {
    recordObservedClientCompatibilityFloor('3.0.0');
    recordObservedClientCompatibilityFloor(undefined);
    expect(getObservedClientCompatibilityFloor()).toBe('3.0.0');
    invalidateClientLifetime();
    expect(getObservedClientCompatibilityFloor()).toBeUndefined();
  });
});
