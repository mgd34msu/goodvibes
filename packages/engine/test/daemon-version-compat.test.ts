/**
 * daemon-version-compat.test.ts
 *
 * The adopt version rule: a program adopts a daemon on the configured port
 * only when the daemon is of the same major and at least as new on
 * major.minor. These are pure-function tests of the policy, independent of the live
 * build VERSION (fixed version literals, no comparison against the platform version).
 */

import { describe, expect, test } from 'bun:test';
import {
  isDaemonVersionCompatible,
  describeVersionIncompatibility,
} from '../platform/src/platform/runtime/daemon-version-compat.ts';

describe('isDaemonVersionCompatible: a daemon serves this program when it is as new on major.minor', () => {
  test('same major and an equal or newer daemon minor is compatible, whatever the patch', () => {
    expect(isDaemonVersionCompatible('3.3.0', '3.3.9')).toBe(true);
    expect(isDaemonVersionCompatible('3.3.9', '3.3.0')).toBe(true);
    expect(isDaemonVersionCompatible('3.0.0', '3.4.1')).toBe(true);
  });

  test('an older daemon minor of the same major is incompatible', () => {
    expect(isDaemonVersionCompatible('3.3.0', '3.0.0')).toBe(false);
    expect(isDaemonVersionCompatible('3.3.0', '3.2.9')).toBe(false);
  });

  test('a different major is incompatible in either direction', () => {
    expect(isDaemonVersionCompatible('3.0.0', '4.0.0')).toBe(false);
    expect(isDaemonVersionCompatible('4.0.0', '3.9.9')).toBe(false);
  });

  test('prerelease, build metadata and a leading v do not matter', () => {
    expect(isDaemonVersionCompatible('3.3.0', '3.3.1-rc.2')).toBe(true);
    expect(isDaemonVersionCompatible('3.2.0+build.5', '3.9.0')).toBe(true);
    expect(isDaemonVersionCompatible('v3.3.0', '3.3.0')).toBe(true);
  });

  test('unparseable or absent versions are never compatible', () => {
    expect(isDaemonVersionCompatible('3.3.0', undefined)).toBe(false);
    expect(isDaemonVersionCompatible('3.3.0', '')).toBe(false);
    expect(isDaemonVersionCompatible('3.3.0', 'not-a-version')).toBe(false);
    expect(isDaemonVersionCompatible(undefined, '3.3.0')).toBe(false);
    expect(isDaemonVersionCompatible('3.3.0', '.')).toBe(false);
    expect(isDaemonVersionCompatible('3.3.0', '1e1.2.0')).toBe(false);
  });
});

describe('describeVersionIncompatibility', () => {
  test('names the endpoint, the found version, and this surface version', () => {
    const reason = describeVersionIncompatibility('127.0.0.1', 3421, '3.3.0', '3.0.0');
    expect(reason).toContain('127.0.0.1:3421');
    expect(reason).toContain('3.0.0');
    expect(reason).toContain('3.3.0');
    expect(reason).toContain('goodvibes-daemon restart-service');
  });

  test('degrades to "unknown" when a version is missing rather than printing undefined', () => {
    const reason = describeVersionIncompatibility('127.0.0.1', 3421, '3.3.0', undefined);
    expect(reason).toContain('unknown');
    expect(reason).not.toContain('undefined');
  });
});
