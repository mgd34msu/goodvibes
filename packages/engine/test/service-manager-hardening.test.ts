import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import {
  PlatformServiceManager,
  type ManagedServiceActionResult,
  type ManagedServiceDefinition,
  type ManagedServiceProcessControl,
} from '../platform/src/platform/daemon/service-manager.js';

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-service-hardening-'));
  directories.push(dir);
  return dir;
}

const flags = { isEnabled: (id: string) => id === 'service-management' };

function definitionFor(dir: string, overrides: Partial<ManagedServiceDefinition> = {}): ManagedServiceDefinition {
  return {
    name: 'goodvibes-hardening',
    description: 'GoodVibes daemon (test)',
    workingDirectory: dir,
    command: '/usr/local/bin/goodvibes-daemon',
    args: ['--port', '3421'],
    env: { GOODVIBES_DAEMON_TOKEN: 'secret-daemon-token', GOODVIBES_HTTP_TOKEN: '', NODE_ENV: 'production' },
    restartOnFailure: true,
    ...overrides,
  };
}

function build(
  platform: 'systemd' | 'launchd' | 'windows' | 'manual',
  dir: string,
  extra: {
    readonly definition?: Partial<ManagedServiceDefinition>;
    readonly runner?: (command: string, args: readonly string[]) => ManagedServiceActionResult;
    readonly processControl?: ManagedServiceProcessControl;
  } = {},
): PlatformServiceManager {
  const config = new ConfigManager({ configDir: join(dir, 'config') });
  config.set('service.platform', platform);
  config.set('service.serviceName', 'goodvibes-hardening');
  return new PlatformServiceManager(config, {
    workingDirectory: dir,
    homeDirectory: dir,
    definitionOverride: definitionFor(dir, extra.definition),
    featureFlags: flags,
    actionRunner: extra.runner ?? (() => ({ status: 0, stdout: 'active\n' })),
    ...(extra.processControl ? { processControl: extra.processControl } : {}),
  });
}

function recorder(): { calls: string[]; runner: (command: string, args: readonly string[]) => ManagedServiceActionResult } {
  const calls: string[] = [];
  return { calls, runner: (command, args) => { calls.push([command, ...args].join(' ')); return { status: 0, stdout: 'active\n' }; } };
}

describe('installed definitions hold the daemon token', () => {
  test('the file is owner-only and status output never carries the token value', () => {
    for (const platform of ['systemd', 'launchd'] as const) {
      const dir = scratch();
      const manager = build(platform, dir);
      const installed = manager.install();
      expect(statSync(installed.path).mode & 0o777).toBe(0o600);
      expect(readFileSync(installed.path, 'utf-8')).toContain('secret-daemon-token');
      expect(installed.contents).toBeDefined();
      expect(installed.contents).not.toContain('secret-daemon-token');
      expect(installed.contents).toContain('GOODVIBES_DAEMON_TOKEN');
      expect(manager.status().contents).not.toContain('secret-daemon-token');
    }
  });
});

describe('launchd plist escaping', () => {
  test('markup characters in paths, labels and values are escaped so the plist stays well-formed', () => {
    const dir = scratch();
    const manager = build('launchd', dir, {
      definition: {
        workingDirectory: '/Users/a&b/<proj>',
        description: 'a & b',
        env: { GOODVIBES_DAEMON_TOKEN: 'tok&en<1>', NODE_ENV: 'production' },
      },
    });
    const text = readFileSync(manager.install().path, 'utf-8');
    expect(text).toContain('<string>/Users/a&amp;b/&lt;proj&gt;</string>');
    expect(text).toContain('<string>tok&amp;en&lt;1&gt;</string>');
    expect(text).toContain('a &amp; b</string>');
    // Every ampersand must start an entity, and the only angle brackets are tags.
    expect(text.match(/&(?!(amp|lt|gt|quot|apos);)/g)).toBeNull();
    expect(manager.installedDefinitionMatches()).toBe(true);
  });
});

describe('platform registration commands', () => {
  test('systemd install reloads the unit manager so a rewritten unit takes effect', () => {
    const { calls, runner } = recorder();
    build('systemd', scratch(), { runner }).install();
    expect(calls).toContain('systemctl --user daemon-reload');
  });

  test('windows install creates the scheduled task and a failure is reported, not hidden', () => {
    const { calls, runner } = recorder();
    build('windows', scratch(), { runner }).install();
    expect(calls).toContain('schtasks /Create /SC ONLOGON /TN goodvibes-hardening /TR /usr/local/bin/goodvibes-daemon --port 3421 /F');

    const failing = build('windows', scratch(), { runner: () => ({ status: 1, stderr: 'ERROR: Access is denied.' }) }).install();
    expect(failing.actionError).toContain('Access is denied.');
  });

  test('windows restart ends the running task before running it again', () => {
    const { calls, runner } = recorder();
    build('windows', scratch(), { runner }).restart();
    const end = calls.indexOf('schtasks /End /TN goodvibes-hardening');
    const run = calls.indexOf('schtasks /Run /TN goodvibes-hardening');
    expect(end).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(end);
  });

  test('systemd uninstall stops and disables the unit before removing it, then reloads', () => {
    const { calls, runner } = recorder();
    const manager = build('systemd', scratch(), { runner });
    const path = manager.install().path;
    calls.length = 0;
    const result = manager.uninstall();
    expect(existsSync(path)).toBe(false);
    expect(result.actionError).toBeUndefined();
    const disable = calls.indexOf('systemctl --user disable --now goodvibes-hardening.service');
    const reload = calls.indexOf('systemctl --user daemon-reload');
    expect(disable).toBeGreaterThanOrEqual(0);
    expect(reload).toBeGreaterThan(disable);
  });

  test('uninstalling a stopped scheduled task or an unloaded launch agent reports no error', () => {
    const notRunning = (command: string, args: readonly string[]): ManagedServiceActionResult => (
      args.includes('/End') || args.includes('unload') ? { status: 1, stderr: 'not running' } : { status: 0, stdout: 'active\n' }
    );
    for (const platform of ['windows', 'launchd'] as const) {
      const manager = build(platform, scratch(), { runner: notRunning });
      manager.install();
      const result = manager.uninstall();
      expect(result.installed).toBe(false);
      expect(result.actionError).toBeUndefined();
    }
  });

  test('a failed disable is reported while the definition is still removed', () => {
    const manager = build('systemd', scratch(), {
      runner: (command, args) => (args.includes('disable') ? { status: 1, stderr: 'bus unreachable' } : { status: 0, stdout: 'active\n' }),
    });
    manager.install();
    const result = manager.uninstall();
    expect(result.installed).toBe(false);
    expect(result.actionError).toContain('may still be running');
  });

  test('an unanswered launchctl query is reported as unreachable, not as not running', () => {
    const manager = build('launchd', scratch(), { runner: () => ({ status: null }) });
    const status = manager.status();
    expect(status.running).toBe(false);
    expect(status.actionError).toContain('launchctl');
  });
});

describe('manual platform start, stop and restart', () => {
  function fakeChild(pid: number | undefined): ChildProcess {
    return Object.assign(new EventEmitter(), { pid, unref: () => {}, kill: () => true }) as unknown as ChildProcess;
  }

  test('a spawn that never produced a process returns an error instead of a silent start', () => {
    const dir = scratch();
    const manager = build('manual', dir, { processControl: { spawn: () => fakeChild(undefined) } });
    const result = manager.start();
    expect(result.running).toBe(false);
    expect(result.actionError).toContain('did not launch');
  });

  test('a spawn that throws is reported, and a later asynchronous error event is absorbed', () => {
    const dir = scratch();
    const throwing = build('manual', dir, { processControl: { spawn: () => { throw new Error('spawn EACCES'); } } });
    expect(throwing.start().actionError).toContain('spawn EACCES');

    const child = fakeChild(undefined);
    build('manual', scratch(), { processControl: { spawn: () => child } }).start();
    expect(() => child.emit('error', new Error('spawn ENOENT'))).not.toThrow();
  });

  test('an empty token is not passed to the child, so the daemon resolves its own', () => {
    const saved = process.env.GOODVIBES_DAEMON_TOKEN;
    delete process.env.GOODVIBES_DAEMON_TOKEN;
    try {
      let childEnv: NodeJS.ProcessEnv | undefined;
      const manager = build('manual', scratch(), {
        definition: { env: { GOODVIBES_DAEMON_TOKEN: '', NODE_ENV: 'production' } },
        processControl: {
          spawn: (_command, _args, options) => { childEnv = options.env; return fakeChild(4100); },
          isRunning: () => true,
          startTime: () => 'T1',
        },
      });
      manager.start();
      expect(childEnv).toBeDefined();
      expect('GOODVIBES_DAEMON_TOKEN' in childEnv!).toBe(false);
      expect(childEnv!.NODE_ENV).toBe('production');
    } finally {
      if (saved !== undefined) process.env.GOODVIBES_DAEMON_TOKEN = saved;
    }
  });

  function restartHarness(exitsAfterPauses: number | null) {
    const events: string[] = [];
    const alive = new Set<number>();
    let nextPid = 5000;
    let pausesLeft = exitsAfterPauses ?? 0;
    const processControl: ManagedServiceProcessControl = {
      spawn: () => {
        const pid = nextPid++;
        alive.add(pid);
        events.push(`spawn ${pid}`);
        return fakeChild(pid);
      },
      isRunning: (pid) => alive.has(pid),
      startTime: () => 'T1',
      signal: (pid) => { events.push(`signal ${pid}`); },
      pause: () => {
        events.push('pause');
        if (exitsAfterPauses !== null && --pausesLeft <= 0) alive.clear();
      },
    };
    return { events, processControl, manager: build('manual', scratch(), { processControl }) };
  }

  test('restart waits for the old process to exit before starting the new one', () => {
    const { events, manager } = restartHarness(3);
    manager.start();
    const result = manager.restart();
    expect(events).toEqual(['spawn 5000', 'signal 5000', 'pause', 'pause', 'pause', 'spawn 5001']);
    expect(result.running).toBe(true);
    expect(result.actionError).toBeUndefined();
  });

  test('restart refuses to start a second process when the old one never exits, and keeps tracking the old one', () => {
    const { events, manager } = restartHarness(null);
    manager.start();
    const result = manager.restart();
    expect(events.filter((event) => event.startsWith('spawn'))).toEqual(['spawn 5000']);
    expect(result.actionError).toContain('pid 5000');
    expect(result.running).toBe(true);
    expect(result.pid).toBe(5000);
  });

  test('restart from inside the daemon itself signals nothing and starts nothing', () => {
    const events: string[] = [];
    const manager = build('manual', scratch(), {
      processControl: {
        spawn: () => { events.push('spawn'); return fakeChild(process.pid); },
        isRunning: () => true,
        startTime: () => 'T1',
        signal: () => { events.push('signal'); },
        pause: () => { events.push('pause'); },
      },
    });
    manager.start();
    const result = manager.restart();
    expect(events).toEqual(['spawn']);
    expect(result.actionError).toContain('cannot restart itself');
    expect(result.running).toBe(true);
  });

  test('a recycled pid with a different start time is neither reported as running nor signalled', () => {
    const events: string[] = [];
    let startTime = 'T1';
    const manager = build('manual', scratch(), {
      processControl: {
        spawn: () => fakeChild(4242),
        isRunning: () => true,
        startTime: () => startTime,
        signal: (pid) => { events.push(`signal ${pid}`); },
      },
    });
    expect(manager.start().running).toBe(true);
    startTime = 'T2';
    expect(manager.status().running).toBe(false);
    manager.stop();
    expect(events).toEqual([]);
  });
});
