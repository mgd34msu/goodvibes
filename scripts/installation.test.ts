import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, parseOptions, preflight, wrapper, type InstallHooks, type Options } from './install.ts';
import { COMMANDS, assertOwnedFiles, atomicWrite, readInstallation, receiptPath, unitPath, uninstall, validateLayout, type Run } from './installation.ts';

let home: string;
let previousHome: string | undefined;
let options: Options;
let state: string;
let actions: string[][];
let execute: Run;
let hooks: InstallHooks;
const COMMIT = 'a'.repeat(40);

/** Reproduce the actual v1 writer, independently of the new receipt reader. */
function saveV1Receipt() {
  const receipt = readInstallation(options.prefix);
  if (!receipt || receipt.schema !== 2) throw new Error('Expected the new installation fixture');
  const originalDigest = (text: string) => createHash('sha256').update(text).digest('hex');
  const old = { ...receipt, schema: 1 as const, unit: originalDigest(receipt.unit),
    wrappers: Object.fromEntries(Object.entries(receipt.wrappers).map(([name, text]) => [name, originalDigest(text)])) };
  atomicWrite(receiptPath(options), JSON.stringify(old));
  return old;
}
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'jev-suite-test-'));
  previousHome = process.env.HOME; process.env.HOME = home;
  options = parseOptions(['--no-service'], home);
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  options.port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  state = 'inactive'; actions = [];
  execute = (command, args) => {
    actions.push([command, ...args]);
    if (command === 'systemctl') {
      if (args.includes('--property=FragmentPath')) return existsSync(unitPath(options)) ? unitPath(options) : '';
      if (args.includes('--property=ActiveState')) return state;
      if (args.includes('stop')) state = 'inactive';
      if (args.includes('start') || args.includes('restart')) state = 'active';
    } else if (command.endsWith('goodvibes-daemon')) {
      atomicWrite(join(options.dataDir, '.goodvibes/daemon/settings.json'), JSON.stringify({ installed: true }));
      atomicWrite(join(options.dataDir, '.goodvibes/tui/settings.json'), JSON.stringify({ judgment: 'jev-latest' }));
    }
    return '';
  };
  hooks = {
    execute, build: async () => COMMIT,
    stage: async (_root, release) => {
      mkdirSync(join(release, 'webui'), { recursive: true }); writeFileSync(join(release, 'webui/index.html'), '<html>test</html>');
      writeFileSync(join(release, 'payload'), 'binary');
    },
    renderUnit: async () => '[Service]\nExecStart=/owned/goodvibes-daemon serve\n',
    ready: async () => {},
  };
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('suite install and uninstall', () => {
  test('installs all command links and preserves credentials/data on removal', async () => {
    await install(options, hooks);
    const receipt = readInstallation(options.prefix)!;
    expect(receipt.schema).toBe(2);
    for (const name of COMMANDS) expect(receipt.wrappers[name]).toBe(wrapper(options, name));
    assertOwnedFiles(receipt);
    for (const name of COMMANDS) expect(readlinkSync(join(options.binDir, name))).toBe(join(options.prefix, 'commands', name));
    atomicWrite(join(options.dataDir, 'environment'), "TYPESAFE_API_KEY='synthetic-private-value'\n");
    writeFileSync(join(options.dataDir, 'user-notes'), 'keep me');
    await uninstall(options.prefix, false, execute);
    expect(existsSync(options.prefix)).toBe(false);
    expect(readFileSync(join(options.dataDir, 'user-notes'), 'utf8')).toBe('keep me');
    expect(readFileSync(join(options.dataDir, 'environment'), 'utf8')).toContain('synthetic-private-value');
    for (const name of COMMANDS) expect(existsSync(join(options.binDir, name))).toBe(false);
    await uninstall(options.prefix, false, execute);
  });
  test('explicit purge removes only the installation data tree', async () => {
    await install(options, hooks);
    writeFileSync(join(home, 'unrelated'), 'keep');
    await uninstall(options.prefix, true, execute);
    expect(existsSync(options.dataDir)).toBe(false);
    expect(readFileSync(join(home, 'unrelated'), 'utf8')).toBe('keep');
  });
  test('updates retain data and replace the release after success', async () => {
    await install(options, hooks);
    const before = readInstallation(options.prefix)!;
    writeFileSync(join(options.dataDir, 'user-notes'), 'keep');
    await install(options, { ...hooks, build: async () => 'b'.repeat(40) });
    const after = readInstallation(options.prefix)!;
    expect(after.id).toBe(before.id);
    expect(after.sourceCommit).not.toBe(before.sourceCommit);
    expect(existsSync(join(options.prefix, 'releases', before.release))).toBe(false);
    expect(readFileSync(join(options.dataDir, 'user-notes'), 'utf8')).toBe('keep');
  });
  test('a v1 checkout installation upgrades its receipt without changing its data owner', async () => {
    options.service = true;
    await install(options, hooks);
    const old = saveV1Receipt();
    assertOwnedFiles(old);
    writeFileSync(join(options.dataDir, 'saved-note'), 'Preserve this note');
    await install(options, { ...hooks, build: async () => 'b'.repeat(40) });
    const current = readInstallation(options.prefix);
    expect(current).toMatchObject({ schema: 2, id: old.id, unit: '[Service]\nExecStart=/owned/goodvibes-daemon serve\n' });
    if (!current) throw new Error('Missing upgraded receipt');
    assertOwnedFiles(current);
    expect(readFileSync(join(options.dataDir, 'saved-note'), 'utf8')).toBe('Preserve this note');
  });
  test('a failed service update restores release, settings and old service', async () => {
    options.service = true;
    await install(options, hooks);
    const before = readInstallation(options.prefix)!;
    const config = join(options.dataDir, '.goodvibes/daemon/settings.json');
    const surface = join(options.dataDir, '.goodvibes/tui/settings.json');
    atomicWrite(config, '{"original":true}'); atomicWrite(surface, '{"originalSurface":true}');
    await expect(install(options, { ...hooks, ready: async () => { throw new Error('readiness failure'); } })).rejects.toThrow('readiness failure');
    expect(readInstallation(options.prefix)).toEqual(before);
    expect(readlinkSync(join(options.prefix, 'current'))).toBe(`releases/${before.release}`);
    expect(readFileSync(config, 'utf8')).toBe('{"original":true}');
    expect(readFileSync(surface, 'utf8')).toBe('{"originalSurface":true}');
    expect(state).toBe('active');
    assertOwnedFiles(before);
  });
  test('does not remove a replacement command or unrelated installation', async () => {
    await install(options, hooks);
    const link = join(options.binDir, 'goodvibes'); rmSync(link); writeFileSync(link, 'user file');
    await expect(uninstall(options.prefix, true, execute)).rejects.toThrow('another installation');
    expect(readFileSync(link, 'utf8')).toBe('user file');
    expect(existsSync(options.dataDir)).toBe(true);
  });
  test('refuses foreign commands and data before building', () => {
    mkdirSync(options.binDir, { recursive: true }); writeFileSync(join(options.binDir, 'goodvibes'), 'existing');
    expect(() => preflight(options, undefined, execute)).toThrow('Command already exists');
    rmSync(join(options.binDir, 'goodvibes'));
    mkdirSync(options.dataDir, { recursive: true }); writeFileSync(join(options.dataDir, 'notes'), 'existing');
    expect(() => preflight(options, undefined, execute)).toThrow('Data directory is not empty');
  });
  test('refuses symlinked paths, overlap and paths outside the home', () => {
    mkdirSync(join(home, 'actual')); symlinkSync(join(home, 'actual'), join(home, 'link'));
    expect(() => validateLayout({ ...options, prefix: join(home, 'link/program') })).toThrow('symlink');
    expect(() => validateLayout({ ...options, dataDir: options.prefix })).toThrow('overlap');
    expect(() => validateLayout({ ...options, prefix: '/usr/local' })).toThrow('below your home');
  });
});
