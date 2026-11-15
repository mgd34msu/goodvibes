import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProjectTempDir } from './helpers/project-temp';

const configPath = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const result = { schema: 'goodvibes.daemon.webui-binding', schemaVersion: 1, source: 'configuration', endpoint: 'web' };
const catalog = JSON.stringify({ schema: 'goodvibes.daemon.cli-catalog', schemaVersion: 1,
  commands: [{ name: 'webui', subcommands: ['status'], machineQueries: [{ args: ['status', '--json'], result }] }] });
const binding = JSON.stringify({ ...result, host: '127.0.0.2', port: 44323 });
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** A daemon CLI that answers the web binding, plus a tree whose settings files the test fills in. */
function fixture() {
  const root = makeProjectTempDir('webui-engine-dev-');
  const bin = join(root, 'bin'); const home = join(root, 'home'); const daemon = join(root, 'daemon');
  mkdirSync(bin); mkdirSync(home);
  writeFileSync(join(bin, 'goodvibes-daemon'), `#!/bin/sh
if [ "$1" = "--help" ]; then printf '%s\\n' ${quote(catalog)}; exit 0; fi
if [ "$*" = "webui status --json" ]; then printf '%s\\n' ${quote(binding)}; exit 0; fi
exit 94
`, { mode: 0o755 });
  function proxyTarget(extraEnv: Record<string, string> = {}): string {
    const runner = join(root, 'run-config.ts');
    writeFileSync(runner, `import config from ${JSON.stringify(configPath)};\nconst result = typeof config === 'function' ? await config({ command: 'serve', mode: 'development', isPreview: false }) : config;\nconsole.log(JSON.stringify(result.server));\n`);
    const child = spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
      env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, HOME: home, GOODVIBES_HOME: home, GOODVIBES_WORKING_DIR: root,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, 'bun-transpiler-cache'), ...extraEnv } });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    return (JSON.parse(child.stdout) as { proxy: Record<string, { target: string }> }).proxy['/api']!.target;
  }
  return { root, home, daemon, proxyTarget };
}

describe('the dev proxy follows the installed control-plane port even when the web binding is discovered', () => {
  test('the daemon-owned settings file names the port', () => {
    const f = fixture(); mkdirSync(join(f.home, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(f.home, '.goodvibes', 'daemon', 'settings.json'), JSON.stringify({ controlPlane: { hostMode: 'local', port: 4000 } }));
    // HOME points elsewhere so only GOODVIBES_HOME can locate the file.
    const elsewhere = join(f.root, 'elsewhere'); mkdirSync(elsewhere);
    expect(f.proxyTarget({ HOME: elsewhere })).toBe('http://127.0.0.1:4000');
  });

  test('a relocated daemon directory is read from its own settings file', () => {
    const f = fixture(); mkdirSync(f.daemon);
    writeFileSync(join(f.daemon, 'settings.json'), JSON.stringify({ controlPlane: { port: 4200 } }));
    expect(f.proxyTarget({ GOODVIBES_DAEMON_HOME: f.daemon })).toBe('http://127.0.0.1:4200');
  });

  test('without a daemon settings file the deprecated terminal file under the relocated tree still answers', () => {
    const f = fixture(); mkdirSync(join(f.home, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(join(f.home, '.goodvibes', 'tui', 'settings.json'), JSON.stringify({ controlPlane: { port: 4100 } }));
    expect(f.proxyTarget()).toBe('http://127.0.0.1:4100');
  });

  test('no settings at all keeps the default port', () => {
    expect(fixture().proxyTarget()).toBe('http://127.0.0.1:3421');
  });
});
