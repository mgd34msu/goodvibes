import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hydrateServiceShellEnvironment,
  mergeHydratedEnv,
  parseMarkedShellEnv,
  resolveUserLoginShell,
  shellEnvArgs,
  shouldHydrateServiceShellEnv,
} from '../../cli/shell-env.js';

describe('daemon service login-shell environment hydration', () => {
  test('shouldHydrateServiceShellEnv triggers only for serve under systemd/launchd', () => {
    expect(shouldHydrateServiceShellEnv([], { INVOCATION_ID: 'abc123' }, 'linux')).toBe(true);
    expect(shouldHydrateServiceShellEnv(['serve'], { JOURNAL_STREAM: '8:1234' }, 'linux')).toBe(true);
    expect(shouldHydrateServiceShellEnv(['--port', '3421'], { XPC_SERVICE_NAME: 'sh.goodvibes.daemon' }, 'darwin')).toBe(true);
    expect(shouldHydrateServiceShellEnv(['version'], { INVOCATION_ID: 'abc123' }, 'linux')).toBe(false);
    expect(shouldHydrateServiceShellEnv(['serve'], { INVOCATION_ID: 'abc123', GOODVIBES_NO_SHELL_ENV: '1' }, 'linux')).toBe(false);
    expect(shouldHydrateServiceShellEnv(['serve'], { XPC_SERVICE_NAME: '0' }, 'darwin')).toBe(false);
    expect(shouldHydrateServiceShellEnv(['serve'], {}, 'linux')).toBe(false);
    expect(shouldHydrateServiceShellEnv(['serve'], { INVOCATION_ID: 'abc123' }, 'win32')).toBe(false);
  });

  test('resolveUserLoginShell and shellEnvArgs pick the right shell and flags', () => {
    expect(resolveUserLoginShell({}, 'linux', '/bin/zsh')).toBe('/bin/zsh');
    expect(resolveUserLoginShell({ SHELL: '/usr/bin/fish' }, 'linux', null)).toBe('/usr/bin/fish');
    expect(resolveUserLoginShell({}, 'darwin', null)).toBe('/bin/zsh');
    expect(shellEnvArgs('/bin/bash', 'm1').slice(0, 3)).toEqual(['-i', '-l', '-c']);
    expect(shellEnvArgs('/bin/zsh', 'm1').slice(0, 3)).toEqual(['-i', '-l', '-c']);
    expect(shellEnvArgs('/usr/bin/fish', 'm1').slice(0, 2)).toEqual(['-l', '-c']);
    expect(shellEnvArgs('/bin/sh', 'm1').slice(0, 2)).toEqual(['-l', '-c']);
  });

  test('parseMarkedShellEnv handles noisy banner output, NUL-delimited values, and newline fallback', () => {
    const nulOut = 'Welcome banner\n__GV_ENV_START_xyz__TYPESAFE_API_KEY=ts_live_1\0MULTI=line1\nline2\0__GV_ENV_END_xyz__\ngoodbye';
    expect(parseMarkedShellEnv(nulOut, 'xyz')).toEqual({
      TYPESAFE_API_KEY: 'ts_live_1',
      MULTI: 'line1\nline2',
    });

    const lineOut = 'banner\n__GV_ENV_START_abc__OPENROUTER_API_KEY=or_123\nFOO=bar=baz\n__GV_ENV_END_abc__';
    expect(parseMarkedShellEnv(lineOut, 'abc')).toEqual({
      OPENROUTER_API_KEY: 'or_123',
      FOO: 'bar=baz',
    });
  });

  test('mergeHydratedEnv preserves existing vars, merges PATH, and excludes volatile or home-routing keys', () => {
    const target: Record<string, string | undefined> = {
      EXISTING_KEY: 'from-unit',
      PATH: '/usr/bin:/bin',
    };
    const count = mergeHydratedEnv(target, {
      EXISTING_KEY: 'from-shell',
      TYPESAFE_API_KEY: 'from-bashrc',
      PATH: '/usr/bin:/home/dev/.local/bin:/opt/tools',
      SHLVL: '2',
      PWD: '/tmp',
      GOODVIBES_HOME: '/wrong/home',
      GOODVIBES_DAEMON_HOME: '/wrong/daemon',
    });
    expect(count).toBe(2);
    expect(target['EXISTING_KEY']).toBe('from-unit');
    expect(target['TYPESAFE_API_KEY']).toBe('from-bashrc');
    expect(target['PATH']).toBe('/usr/bin:/bin:/home/dev/.local/bin:/opt/tools');
    expect(target['SHLVL']).toBeUndefined();
    expect(target['GOODVIBES_HOME']).toBeUndefined();
    expect(target['GOODVIBES_DAEMON_HOME']).toBeUndefined();
  });

  test('hydrateServiceShellEnvironment loads exports from ~/.bashrc even with interactive guard', () => {
    if (process.platform === 'win32') return;
    const home = mkdtempSync(join(tmpdir(), 'gv-shell-env-'));
    try {
      writeFileSync(join(home, '.bashrc'), [
        '[[ $- != *i* ]] && return',
        'echo "noisy motd banner"',
        'export TYPESAFE_API_KEY="hydrated-typesafe-key"',
        'export OPENROUTER_API_KEY="hydrated-openrouter-key"',
        'export ALREADY_SET="should-not-overwrite"',
      ].join('\n') + '\n');
      writeFileSync(join(home, '.bash_profile'), 'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n');

      const env: Record<string, string | undefined> = {
        HOME: home,
        USER: process.env['USER'] ?? 'dev',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        INVOCATION_ID: 'systemd-test-invocation',
        ALREADY_SET: 'keep-me',
      };
      const added = hydrateServiceShellEnvironment(['serve'], {
        env,
        platform: 'linux',
        passwdShell: '/bin/bash',
        timeoutMs: 3_000,
      });
      expect(added).toBeGreaterThanOrEqual(2);
      expect(env['TYPESAFE_API_KEY']).toBe('hydrated-typesafe-key');
      expect(env['OPENROUTER_API_KEY']).toBe('hydrated-openrouter-key');
      expect(env['ALREADY_SET']).toBe('keep-me');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
