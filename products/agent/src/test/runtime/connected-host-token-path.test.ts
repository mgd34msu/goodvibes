import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { connectedHostOperatorTokenPath } from '../../runtime/connected-host-auth.ts';

const savedDaemonHome = process.env['GOODVIBES_DAEMON_HOME'];
afterEach(() => {
  if (savedDaemonHome === undefined) delete process.env['GOODVIBES_DAEMON_HOME'];
  else process.env['GOODVIBES_DAEMON_HOME'] = savedDaemonHome;
});

test('the connected-host token path follows the caller home when no daemon home is set', () => {
  delete process.env['GOODVIBES_DAEMON_HOME'];
  expect(connectedHostOperatorTokenPath('/fixture/home')).toBe(join('/fixture/home', '.goodvibes', 'daemon', 'operator-tokens.json'));
});

test('the connected-host token path is read where the daemon home override points, as the status reader does', () => {
  process.env['GOODVIBES_DAEMON_HOME'] = '/fixture/elsewhere/daemon';
  expect(connectedHostOperatorTokenPath('/fixture/home')).toBe('/fixture/elsewhere/daemon/operator-tokens.json');
});
