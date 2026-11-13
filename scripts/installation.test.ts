import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { install, interruptInstall, parseOptions, preflight, wrapper, type InstallHooks, type Options, assertPortFree } from './install.ts';
import { COMMANDS, assertOwnedFiles, atomicWrite, dataOwner, isReleaseInUse, readInstallation, receiptPath, unitPath, uninstall, validateLayout, withLock, processStartTime, type Run } from './installation.ts';

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
  test('default installation locates Node separately when it is not beside Bun', () => {
    const bunDir = join(home, 'bun-runtime'), nodeDir = join(home, 'node-runtime');
    mkdirSync(bunDir); mkdirSync(nodeDir);
    writeFileSync(join(bunDir, 'bun'), 'Bun runtime');
    const nodePath = join(nodeDir, 'node'); writeFileSync(nodePath, 'Node runtime');
    const runtime = { bunPath: join(bunDir, 'bun'), findNode: () => nodePath };
    const defaults = parseOptions(['--no-service'], home, runtime);
    expect(defaults.runtimeDir).toBe(bunDir);
    expect(defaults.nodePath).toBe(nodePath);
    expect(existsSync(defaults.nodePath!)).toBe(true);
    const explicit = parseOptions(['--no-service', '--runtime-dir', bunDir], home, runtime);
    expect(explicit.nodePath).toBe(join(bunDir, 'node'));
  });

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
  test('reinstall reuses preserved data ownership and credentials', async () => {
    await install(options, hooks);
    const id = readInstallation(options.prefix)!.id;
    writeFileSync(join(options.dataDir, 'user-notes'), 'keep');
    await uninstall(options.prefix, false, execute);
    await install(options, hooks);
    expect(readInstallation(options.prefix)!.id).toBe(id);
    expect(readFileSync(join(options.dataDir, 'user-notes'), 'utf8')).toBe('keep');
  });
  test('two live prefixes cannot adopt or purge the same data, but preserved data can move', async () => {
    await install(options, hooks);
    const other = { ...options, prefix: join(home, 'other-program'), binDir: join(home, 'other-bin') };
    await expect(install(other, hooks)).rejects.toThrow('another installation');
    expect(existsSync(options.dataDir)).toBe(true);
    await uninstall(options.prefix, false, execute);
    await install(other, hooks);
    expect(readInstallation(other.prefix)?.dataDir).toBe(options.dataDir);
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
  test('a v1 receipt still refuses a changed launcher before update or uninstall', async () => {
    await install(options, hooks);
    saveV1Receipt();
    atomicWrite(join(options.prefix, 'commands', 'goodvibes'), '#!/bin/sh\necho user edit\n', 0o755);
    actions = [];
    await expect(install(options, hooks)).rejects.toThrow('Managed command has been modified');
    await expect(uninstall(options.prefix, true, execute)).rejects.toThrow('Managed command has been modified');
    expect(actions).toEqual([]);
    expect(existsSync(options.dataDir)).toBe(true);
  });
  test('uninstall can read a v1 receipt and preserve its saved data', async () => {
    options.service = true;
    await install(options, hooks);
    saveV1Receipt();
    writeFileSync(join(options.dataDir, 'saved-note'), 'keep');
    await uninstall(options.prefix, false, execute);
    expect(existsSync(options.prefix)).toBe(false);
    expect(readFileSync(join(options.dataDir, 'saved-note'), 'utf8')).toBe('keep');
  });
  test('a v1 receipt refuses a changed service before stopping it', async () => {
    options.service = true;
    await install(options, hooks);
    saveV1Receipt();
    atomicWrite(unitPath(options), '[Service]\nExecStart=/user/edited\n');
    actions = [];
    await expect(uninstall(options.prefix, true, execute)).rejects.toThrow('Service has been modified');
    expect(actions).toEqual([]);
    expect(state).toBe('active');
  });
  test('failed readiness restores the original v1 files without rewriting its receipt', async () => {
    options.service = true;
    await install(options, hooks);
    const old = saveV1Receipt();
    await expect(install(options, { ...hooks, ready: async () => { throw new Error('readiness failure'); } })).rejects.toThrow('readiness failure');
    expect(readInstallation(options.prefix)).toEqual(old);
    assertOwnedFiles(old);
    expect(state).toBe('active');
  });
  test('v2 compares exact launcher bytes even when invalid UTF-8 would decode to the expected text', async () => {
    await install(options, hooks);
    const receipt = readInstallation(options.prefix);
    if (!receipt) throw new Error('Missing installation fixture');
    const expected = '#!/bin/sh\n# generated \ufffd\n';
    receipt.wrappers.goodvibes = expected;
    atomicWrite(receiptPath(options), JSON.stringify(receipt));
    const path = join(options.prefix, 'commands', 'goodvibes');
    writeFileSync(path, Buffer.concat([Buffer.from('#!/bin/sh\n# generated '), Buffer.from([0xff]), Buffer.from('\n')]));
    expect(readFileSync(path, 'utf8')).toBe(expected);
    expect(() => assertOwnedFiles(receipt)).toThrow('Managed command has been modified');
    writeFileSync(path, expected);
    expect(() => assertOwnedFiles(receipt)).not.toThrow();
  });
  test('an update retains the previous runtime while a terminal still uses it', async () => {
    await install(options, hooks);
    const before = readInstallation(options.prefix)!;
    await install(options, { ...hooks, build: async () => 'b'.repeat(40), isReleaseInUse: () => true });
    expect(readInstallation(options.prefix)!.sourceCommit).toBe('b'.repeat(40));
    expect(existsSync(join(options.prefix, 'releases', before.release, 'payload'))).toBe(true);
  });
  test('release use checks executable paths and treats exited processes as absent', () => {
    const proc = join(home, 'proc'), release = join(home, 'release');
    mkdirSync(join(proc, '1234'), { recursive: true });
    expect(isReleaseInUse(release, proc)).toBe(false);
    symlinkSync(join(release, 'tui/goodvibes-linux-x64'), join(proc, '1234/exe'));
    expect(isReleaseInUse(release, proc)).toBe(true);
    rmSync(join(proc, '1234/exe'));
    symlinkSync('/usr/bin/sleep', join(proc, '1234/exe'));
    expect(isReleaseInUse(release, proc)).toBe(false);
  });
  test('creates, enables and starts the service; stops and disables it before removal', async () => {
    options.service = true;
    await install(options, hooks);
    expect(actions.some(args => args.includes('enable'))).toBe(true);
    expect(state).toBe('active');
    expect(existsSync(unitPath(options))).toBe(true);
    actions = [];
    await uninstall(options.prefix, false, execute);
    expect(actions.findIndex(args => args.includes('stop'))).toBeLessThan(actions.findIndex(args => args.includes('disable')));
    expect(state).toBe('inactive');
    expect(existsSync(unitPath(options))).toBe(false);
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
  test('failed first start removes published commands and preserves user data', async () => {
    options.service = true;
    await expect(install(options, { ...hooks, ready: async () => { throw new Error('readiness failure'); } })).rejects.toThrow('readiness failure');
    expect(existsSync(options.prefix)).toBe(false);
    expect(existsSync(dataOwner(options))).toBe(true);
    expect(existsSync(unitPath(options))).toBe(false);
    expect(state).toBe('inactive');
    for (const name of COMMANDS) expect(existsSync(join(options.binDir, name))).toBe(false);
    await install(options, hooks);
  });
  test('refuses uninstall if a service cannot stop; leaves payloads and data', async () => {
    options.service = true; await install(options, hooks);
    const failing: Run = (command, args, opts) => {
      if (args.includes('stop')) throw new Error('stop failed');
      return execute(command, args, opts);
    };
    await expect(uninstall(options.prefix, true, failing)).rejects.toThrow('stop failed');
    expect(existsSync(options.prefix)).toBe(true);
    expect(existsSync(options.dataDir)).toBe(true);
    expect(existsSync(unitPath(options))).toBe(true);
  });
  test('refuses a changed service before stopping anything', async () => {
    options.service = true; await install(options, hooks);
    atomicWrite(unitPath(options), 'another service'); actions = [];
    await expect(uninstall(options.prefix, true, execute)).rejects.toThrow('modified');
    expect(actions).toEqual([]);
    expect(existsSync(options.prefix)).toBe(true);
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
  test('rejects a replaced data directory before purge', async () => {
    await install(options, hooks);
    const unrelated = join(home, 'unrelated'); mkdirSync(unrelated); writeFileSync(join(unrelated, 'keep'), 'keep');
    rmSync(options.dataDir, { recursive: true }); symlinkSync(unrelated, options.dataDir);
    await expect(uninstall(options.prefix, true, execute)).rejects.toThrow('symlink');
    expect(readFileSync(join(unrelated, 'keep'), 'utf8')).toBe('keep');
  });
  test('serializes install and uninstall for the same prefix', async () => {
    await withLock(options.prefix, async () => {
      await expect(install(options, hooks)).rejects.toThrow('Another install/uninstall');
    });
    expect(existsSync(`${options.prefix}.lock`)).toBe(false);
  });
  test('rejects occupied ports without touching their listener', async () => {
    const listener = createServer();
    await new Promise<void>(yes => listener.listen(0, '127.0.0.1', yes));
    try {
      const address = listener.address(); if (!address || typeof address === 'string') throw new Error('missing port');
      await expect(assertPortFree(address.port)).rejects.toThrow('already in use');
      expect(listener.listening).toBe(true);
    } finally { await new Promise<void>(yes => listener.close(() => yes())); }
  });
  test('keeps custom paths and service choice on a repeat install', async () => {
    options = parseOptions(['--prefix', join(home, 'programs'), '--data-dir', join(home, 'state'), '--bin-dir', join(home, 'bin'), '--no-service', '--port', '43219'], home);
    await install(options, hooks);
    expect(parseOptions(['--prefix', options.prefix], home)).toMatchObject(options);
  });
  test('generated launchers quote paths and follow jev-latest', () => {
    options = { ...options, prefix: join(home, "programs '$; x"), dataDir: join(home, "state '$; x") };
    const script = wrapper(options, 'goodvibes-daemon');
    expect(script).toContain('export TYPESAFE_DEFAULT_MODEL=jev-latest');
    const result = Bun.spawnSync(['/bin/sh', '-n'], { stdin: new TextEncoder().encode(script) });
    expect(result.exitCode).toBe(0);
    expect(script).toContain("'\\''");
  });
  test('a running launcher keeps its Node runtime when current moves to a new release', async () => {
    options = { ...options, prefix: join(home, "programs '$; x") };
    const before = join(options.prefix, 'releases/before'), after = join(options.prefix, 'releases/after');
    for (const [release, label] of [[before, 'before'], [after, 'after']] as const) {
      mkdirSync(join(release, 'runtime'), { recursive: true });
      writeFileSync(join(release, 'runtime/node'), `#!/bin/sh\nprintf '%s\\n' '${label}'\n`, { mode: 0o755 });
    }
    mkdirSync(join(before, 'tui'));
    writeFileSync(join(before, `tui/goodvibes-linux-${process.arch}`),
      '#!/bin/sh\nprintf "ready\\n"\nread -r proceed\ncommand -v node\nnode\nprintf "%s\\n" "$1"\n', { mode: 0o755 });
    symlinkSync('releases/before', join(options.prefix, 'current'));
    const child = Bun.spawn(['/bin/sh', '-c', wrapper(options, 'goodvibes'), 'launcher', 'literal $; argument'],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('ready\n');
      rmSync(join(options.prefix, 'current'));
      symlinkSync('releases/after', join(options.prefix, 'current'));
      child.stdin.write('continue\n'); child.stdin.end();
      let output = '';
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      expect(await child.exited).toBe(0);
      expect(output).toBe(`${join(before, 'runtime/node')}\nbefore\nliteral $; argument\n`);
      expect(await new Response(child.stderr).text()).toBe('');
    } finally { reader.releaseLock(); child.kill(); await child.exited; }
  });
});


test('failed publication restores the owner of adopted data and removes a new environment', async () => {
  await install(options, hooks);
  await uninstall(options.prefix, false, execute);
  const originalOwner = readFileSync(dataOwner(options), 'utf8');
  rmSync(join(options.dataDir, 'environment'));
  options.prefix = join(home, 'replacement');
  await expect(install(options, { ...hooks, stage: async (...args) => {
    await hooks.stage!(...args);
    mkdirSync(join(options.prefix, 'current'));
  } })).rejects.toThrow();
  expect(readFileSync(dataOwner(options), 'utf8')).toBe(originalOwner);
  expect(existsSync(join(options.dataDir, 'environment'))).toBe(false);
});

test('a stop followed by a failed state query restarts the previous running service', async () => {
  options.service = true; await install(options, hooks);
  const receipt = readInstallation(options.prefix);
  let stopped = false;
  const failing: Run = (command, args, opts) => {
    const result = execute(command, args, opts);
    if (args.includes('stop')) stopped = true;
    if (stopped && args.includes('--property=ActiveState')) { stopped = false; throw new Error('state query failed'); }
    return result;
  };
  await expect(install(options, { ...hooks, execute: failing })).rejects.toThrow('state query failed');
  expect(state).toBe('active');
  expect(readInstallation(options.prefix)).toEqual(receipt);
});

describe('A44 installer lock ownership', () => {
  const lockOf = () => `${options.prefix}.lock`;
  const plant = (record?: unknown) => {
    mkdirSync(lockOf(), { recursive: true });
    if (record !== undefined) writeFileSync(join(lockOf(), 'owner.json'), JSON.stringify(record));
  };
  test('a lock whose owner is dead is reclaimed', async () => {
    const dead = spawnSync('true').pid!;
    plant({ pid: dead, startTime: '1' });
    await install(options, hooks);
    expect(existsSync(lockOf())).toBe(false);
    expect(readInstallation(options.prefix)).toBeDefined();
  });
  test('a lock whose pid was reused by another process is reclaimed', async () => {
    const start = processStartTime(process.pid);
    if (start === undefined) return;
    plant({ pid: process.pid, startTime: `${start}0` });
    await install(options, hooks);
    expect(existsSync(lockOf())).toBe(false);
  });
  test('a live owner is still refused and its lock kept', async () => {
    plant({ pid: process.pid, startTime: processStartTime(process.pid) });
    await expect(install(options, hooks)).rejects.toThrow('Another install/uninstall');
    expect(existsSync(join(lockOf(), 'owner.json'))).toBe(true);
  });
  test('a lock with no record is refused with the exact removal command', async () => {
    plant();
    await expect(install(options, hooks)).rejects.toThrow(`rmdir '${lockOf()}'`);
    expect(existsSync(lockOf())).toBe(true);
  });
});

describe('A30 interrupted install', () => {
  test('an interrupt after the service was stopped restores the old service and releases both locks', async () => {
    options.service = true;
    await install(options, hooks);
    const before = readInstallation(options.prefix)!;
    let code = -1;
    await expect(install(options, { ...hooks, ready: async () => {
      expect(state).toBe('active');
      code = interruptInstall('SIGTERM');
      throw new Error('interrupted');
    } })).rejects.toThrow('interrupted');
    expect(code).toBe(143);
    expect(readInstallation(options.prefix)).toEqual(before);
    expect(readlinkSync(join(options.prefix, 'current'))).toBe(`releases/${before.release}`);
    expect(state).toBe('active');
    expect(existsSync(`${options.prefix}.lock`)).toBe(false);
    expect(existsSync(`${options.dataDir}.lock`)).toBe(false);
  });
  test('the interrupt releases the locks even if the process then exits without unwinding', async () => {
    let code = -1;
    const pending = install(options, { ...hooks, ready: async () => {}, stage: async (...args) => {
      await hooks.stage!(...args);
      code = interruptInstall('SIGINT');
      throw new Error('stop here');
    } });
    await expect(pending).rejects.toThrow('stop here');
    expect(code).toBe(130);
    expect(existsSync(`${options.prefix}.lock`)).toBe(false);
    expect(existsSync(options.prefix)).toBe(false);
  });
});

describe('A33 uninstall re-run', () => {
  test('a retry completes after a failure that came after the unit was already removed', async () => {
    options.service = true; await install(options, hooks);
    let reloads = 0;
    const strict: Run = (command, args, opts) => {
      if (command === 'systemctl' && (args.includes('stop') || args.includes('disable')) && !existsSync(unitPath(options))) throw new Error('Unit goodvibes-jev.service not loaded.');
      if (args.includes('daemon-reload') && ++reloads === 1) throw new Error('reload failed');
      return execute(command, args, opts);
    };
    await expect(uninstall(options.prefix, false, strict)).rejects.toThrow('reload failed');
    expect(existsSync(unitPath(options))).toBe(false);
    expect(existsSync(options.prefix)).toBe(true);
    await uninstall(options.prefix, false, strict);
    expect(existsSync(options.prefix)).toBe(false);
    for (const name of COMMANDS) expect(existsSync(join(options.binDir, name))).toBe(false);
  });
});

describe('A40 deferred TUI pairing', () => {
  test('an unresolved recorded pairing attempt does not fail or roll back an otherwise complete install', async () => {
    options.service = true;
    const warnings: string[] = []; const warn = console.warn; console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      await install(options, { ...hooks, pairHost: () => { throw new Error('bun failed (75)'); } });
    } finally { console.warn = warn; }
    expect(state).toBe('active');
    expect(readInstallation(options.prefix)?.service).toBe(true);
    expect(existsSync(`${options.prefix}.lock`)).toBe(false);
    expect(warnings.join('\n')).toContain('pair-installed-host.ts');
    expect(warnings.join('\n')).toContain(join(options.prefix, 'current/runtime/bun'));
  });
  test('any other pairing failure still rolls the install back', async () => {
    options.service = true;
    await expect(install(options, { ...hooks, pairHost: () => { throw new Error('bun failed (1)'); } })).rejects.toThrow('bun failed (1)');
    expect(existsSync(options.prefix)).toBe(false);
    expect(state).toBe('inactive');
  });
});
