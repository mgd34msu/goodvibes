import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config';
import { readDaemonOperatorToken } from '../../runtime/daemon-operator-token.ts';

describe('readDaemonOperatorToken', () => {
  let home: string;
  let saved: string | undefined;
  let savedDaemonHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tui-daemon-token-'));
    saved = process.env.GOODVIBES_DAEMON_TOKEN;
    delete process.env.GOODVIBES_DAEMON_TOKEN;
    // The runner may point the daemon home elsewhere; the record under test lives in this temp home.
    savedDaemonHome = process.env.GOODVIBES_DAEMON_HOME;
    delete process.env.GOODVIBES_DAEMON_HOME;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GOODVIBES_DAEMON_TOKEN;
    else process.env.GOODVIBES_DAEMON_TOKEN = saved;
    if (savedDaemonHome === undefined) delete process.env.GOODVIBES_DAEMON_HOME;
    else process.env.GOODVIBES_DAEMON_HOME = savedDaemonHome;
    rmSync(home, { recursive: true, force: true });
  });

  const record = (body: string): void => {
    const dir = resolveGoodVibesDaemonHome(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'operator-tokens.json'), body);
  };

  test('reads the stored token', () => {
    record(JSON.stringify({ token: 'stored-token', peerId: 'p', createdAt: 1 }));
    expect(readDaemonOperatorToken(home)).toBe('stored-token');
  });

  test('the environment override wins over the stored record', () => {
    record(JSON.stringify({ token: 'stored-token' }));
    process.env.GOODVIBES_DAEMON_TOKEN = ' env-token ';
    expect(readDaemonOperatorToken(home)).toBe('env-token');
  });

  test('a missing or damaged record is no token and creates nothing', () => {
    expect(readDaemonOperatorToken(home)).toBeNull();
    expect(existsSync(join(resolveGoodVibesDaemonHome(home), 'operator-tokens.json'))).toBe(false);
    record('{not json');
    expect(readDaemonOperatorToken(home)).toBeNull();
  });
});
