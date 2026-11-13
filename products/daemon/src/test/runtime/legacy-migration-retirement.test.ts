import { expect, test } from 'bun:test';
import type { PlatformServiceManager } from '@goodvibes-jev/engine/platform/platform/daemon';
import { runLegacyDaemonMigration, type ManagedServiceActionRunner } from '../../runtime/legacy-daemon-migration.js';

function fixture(failAction: string, status: number | null | undefined) {
  const calls: string[] = [];
  const removed: string[] = [];
  const healthy = { platform: 'systemd', path: '/fixture/goodvibes.service', serviceName: 'goodvibes', installed: true, running: true };
  let installed = false;
  let running = false;
  const snapshot = () => ({ ...healthy, installed, running });
  const manager = {
    status: snapshot,
    install: () => { installed = true; return snapshot(); },
    start: () => { running = true; return snapshot(); },
  } as unknown as PlatformServiceManager;
  const input = {
    host: '127.0.0.1', port: 3421, trackedServiceName: 'goodvibes', confirmMigration: true,
    actionRunner: (_command: string, args: readonly string[]) => {
      const action = args[1]!;
      calls.push(action);
      // Undefined deliberately models a malformed JavaScript runner reply.
      return { status: action === failAction ? status : 0 } as ReturnType<ManagedServiceActionRunner>;
    },
    legacyUnitFileRemove(path: string) { removed.push(path); },
  };
  const legacy = { present: true, active: true, path: '/fixture/goodvibes-daemon.service' };
  return { input, manager, legacy, calls, removed };
}

for (const action of ['stop', 'disable']) {
  test.each([1, null, undefined])(`unconfirmed ${action} result %s preserves the legacy definition`, async (status) => {
    const f = fixture(action, status);
    const result = await runLegacyDaemonMigration(f.input, f.manager, f.legacy);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(f.removed).toEqual([]);
    expect(f.calls).toEqual(action === 'stop' ? ['stop'] : ['stop', 'disable']);
    expect(result.lines.join('\n')).toContain('state is unconfirmed');
    expect(result.lines.join('\n')).not.toContain('has been stopped, disabled, and removed');
  });
}

test.each([new Error('fixture removal failure'), new Error(''), undefined])('removal exceptions remain incomplete regardless of their message', async (error) => {
  const f = fixture('', 0);
  const result = await runLegacyDaemonMigration({ ...f.input, legacyUnitFileRemove() { throw error; } }, f.manager, f.legacy);
  expect(result.ok).toBe(false);
  expect(result.exitCode).toBe(1);
  expect(f.calls).toEqual(['stop', 'disable']);
  expect(result.lines.join('\n')).toContain('could not be confirmed');
  expect(result.lines.join('\n')).not.toContain('has been stopped, disabled, and removed');
});

test.each([1, null, undefined])('failed daemon-reload result %s reports the completed removal and remaining step', async (status) => {
  const f = fixture('daemon-reload', status);
  const result = await runLegacyDaemonMigration(f.input, f.manager, f.legacy);
  expect(result.ok).toBe(false);
  expect(result.exitCode).toBe(1);
  expect(f.removed).toEqual([f.legacy.path]);
  expect(f.calls).toEqual(['stop', 'disable', 'daemon-reload']);
  expect(result.lines.join('\n')).toContain('migration incomplete');
  expect(result.lines.join('\n')).toContain('has been stopped, disabled, and removed');
});

for (const action of ['stop', 'disable', 'daemon-reload']) {
  test.each([new Error('dummy runner failure'), undefined])(`a thrown ${action} reports an incomplete receipt`, async (error) => {
    const f = fixture('', 0);
    const result = await runLegacyDaemonMigration({ ...f.input,
      actionRunner(command, args) {
        if (args[1] === action) { f.calls.push(action); throw error; }
        return f.input.actionRunner(command, args);
      },
    }, f.manager, f.legacy);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(f.removed).toEqual(action === 'daemon-reload' ? [f.legacy.path] : []);
    expect(result.lines.join('\n')).toContain('migration incomplete');
    expect(result.lines.join('\n')).not.toContain('dummy runner failure');
    if (action === 'daemon-reload') expect(result.lines.join('\n')).toContain('has been stopped, disabled, and removed');
    else expect(result.lines.join('\n')).toContain('was not removed');
  });
}

// A26: resume after a failed legacy retirement.
function resumeFixture(opts: { matches: boolean; failStopOnce?: boolean }) {
  const calls: string[] = [];
  const removed: string[] = [];
  let installs = 0, starts = 0, failStop = opts.failStopOnce ?? false;
  const managed = { platform: 'systemd', path: '/fixture/goodvibes.service', serviceName: 'goodvibes', installed: false, running: false };
  const manager = {
    status: () => ({ ...managed }),
    install: () => { installs++; managed.installed = true; return { ...managed }; },
    start: () => { starts++; managed.running = true; return { ...managed }; },
    installedDefinitionMatches: () => managed.installed && opts.matches,
  } as unknown as PlatformServiceManager;
  const input = {
    host: '127.0.0.1', port: 3421, trackedServiceName: 'goodvibes', confirmMigration: true,
    actionRunner: (_c: string, args: readonly string[]) => {
      const action = args[1]!; calls.push(action);
      if (action === 'stop' && failStop) { failStop = false; return { status: 1 } as ReturnType<ManagedServiceActionRunner>; }
      return { status: 0 } as ReturnType<ManagedServiceActionRunner>;
    },
    legacyUnitFileRemove(path: string) { removed.push(path); },
  };
  const legacy = { present: true, active: true, path: '/fixture/goodvibes-daemon.service' };
  return { input, manager, legacy, calls, removed, counts: () => ({ installs, starts }) };
}

test('A26: a failed legacy stop is resumable; the retry skips install/start and completes', async () => {
  const f = resumeFixture({ matches: true, failStopOnce: true });
  const first = await runLegacyDaemonMigration(f.input, f.manager, f.legacy);
  expect(first.ok).toBe(false);
  expect(first.lines.join('\n')).toContain('goodvibes-daemon migrate-service -y');
  expect(f.counts()).toEqual({ installs: 1, starts: 1 });
  const second = await runLegacyDaemonMigration(f.input, f.manager, f.legacy);
  expect(second.ok).toBe(true);
  expect(second.exitCode).toBe(0);
  expect(second.lines.join('\n')).toContain('migrated');
  expect(f.counts()).toEqual({ installs: 1, starts: 1 });
  expect(f.removed).toEqual([f.legacy.path]);
});

test('A26: a managed unit that differs from what this tool renders is still refused', async () => {
  const f = resumeFixture({ matches: false, failStopOnce: true });
  await runLegacyDaemonMigration(f.input, f.manager, f.legacy);
  const second = await runLegacyDaemonMigration(f.input, f.manager, f.legacy);
  expect(second.ok).toBe(false);
  expect(second.lines.join('\n')).toContain('migrate-service refused');
  expect(f.removed).toEqual([]);
  expect(f.counts()).toEqual({ installs: 1, starts: 1 });
});

test('A26: the dry run of a resume says it would skip install', async () => {
  const f = resumeFixture({ matches: true, failStopOnce: true });
  await runLegacyDaemonMigration(f.input, f.manager, f.legacy);
  const dry = await runLegacyDaemonMigration({ ...f.input, confirmMigration: false }, f.manager, f.legacy);
  expect(dry.ok).toBe(true);
  expect(dry.lines.join('\n')).toContain('skip install');
  expect(f.removed).toEqual([]);
});
