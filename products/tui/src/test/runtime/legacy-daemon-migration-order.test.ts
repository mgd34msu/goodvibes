/**
 * The consented migration retires the install-script unit only once the new
 * unit is really serving, and never reports a stop or disable that did not
 * happen.
 *
 * Both units want one port, so the legacy unit has to be stopped before the new
 * one can bind. The order is therefore: new unit alive, legacy stopped, new
 * unit seen listening, legacy disabled and removed. Any failure on the way
 * leaves the machine with a working daemon and says so.
 */
import { describe, expect, test } from 'bun:test';
import { runLegacyDaemonMigration, type ManagedServiceActionRunner } from '../../runtime/legacy-daemon-migration.ts';

const LEGACY = { present: true, active: true, path: '/home/u/.config/systemd/user/goodvibes-daemon.service' };
const NEW_PATH = '/home/u/.config/systemd/user/goodvibes.service';

function status(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'systemd', serviceName: 'goodvibes', path: NEW_PATH, installed: true, autostart: true,
    running: true, commandPreview: '', suggestedCommands: [], ...overrides,
  };
}

function setup(options: { stopStatus?: number | null; disableStatus?: number | null; listening?: boolean[]; startStatus?: number | null }) {
  const log: string[] = [];
  const removed: string[] = [];
  const probes = [...(options.listening ?? [true])];
  const manager = {
    status: () => status(),
    install: () => { log.push('manager:install'); return status(); },
    start: () => { log.push('manager:start'); return status(); },
    uninstall: () => { log.push('manager:uninstall'); return status({ installed: false, running: false }); },
  };
  const actionRunner: ManagedServiceActionRunner = (_command, args) => {
    const verb = args[1] ?? '';
    log.push(`systemctl:${verb}${args[2] ? `:${args[2]}` : ''}`);
    const failing = verb === 'stop' ? options.stopStatus : verb === 'disable' ? options.disableStatus : 0;
    const exit = failing === undefined ? 0 : failing;
    return { status: exit, stdout: '', stderr: exit === 0 ? '' : `${verb} failed` } as never;
  };
  const run = (confirm = true) => runLegacyDaemonMigration({
    host: '127.0.0.1', port: 3421, trackedServiceName: 'goodvibes', confirmMigration: confirm,
    actionRunner,
    legacyUnitFileRemove: (path) => { removed.push(path); log.push('file:remove'); },
    portProbe: async () => (probes.length > 1 ? probes.shift()! : probes[0] ?? false),
    sleep: async () => {},
  }, manager as never, LEGACY);
  return { run, log, removed };
}

describe('retiring the install-script unit', () => {
  test('a new unit that listens once the port is free replaces it, in that order', async () => {
    const h = setup({ listening: [false, false, true] });

    const result = await h.run();

    expect(result.ok).toBe(true);
    expect(h.removed).toEqual([LEGACY.path]);
    expect(h.log.indexOf('systemctl:stop:goodvibes-daemon.service')).toBeLessThan(h.log.indexOf('systemctl:disable:goodvibes-daemon.service'));
    expect(h.log.indexOf('systemctl:disable:goodvibes-daemon.service')).toBeLessThan(h.log.indexOf('file:remove'));
    expect(result.lines.join('\n')).toContain('has been stopped, disabled, and removed');
  });

  test('a stop that fails keeps the unit file and is a failure, not "stopped"', async () => {
    const h = setup({ stopStatus: 1 });

    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(h.removed).toEqual([]);
    expect(h.log).not.toContain('systemctl:disable:goodvibes-daemon.service');
    expect(result.lines.join('\n')).not.toContain('has been stopped');
    expect(result.lines.join('\n')).toContain('systemctl --user stop goodvibes-daemon.service');
  });

  test('a stop that times out (no exit status) counts as failed', async () => {
    const h = setup({ stopStatus: null });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(h.removed).toEqual([]);
  });

  test('a disable that fails keeps the unit file instead of leaving a dangling enablement', async () => {
    const h = setup({ disableStatus: 1 });

    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(h.removed).toEqual([]);
    expect(result.lines.join('\n')).toContain('systemctl --user disable goodvibes-daemon.service');
  });

  test('a new unit that never listens is rolled back and the install-script unit is started again', async () => {
    const h = setup({ listening: [false] });

    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(h.removed).toEqual([]);
    expect(h.log).toContain('manager:uninstall');
    expect(h.log.at(-1)).toBe('systemctl:start:goodvibes-daemon.service');
    expect(h.log).not.toContain('systemctl:disable:goodvibes-daemon.service');
    expect(result.lines.join('\n')).toContain('never began listening');
  });
});
