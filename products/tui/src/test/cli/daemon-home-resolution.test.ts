import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readAuthPaths } from '../../cli/management-utils.ts';
import { resolveDaemonStateDirectory } from '../../runtime/client/operator-endpoint.ts';

const saved = process.env['GOODVIBES_DAEMON_HOME'];
afterEach(() => {
  if (saved === undefined) delete process.env['GOODVIBES_DAEMON_HOME'];
  else process.env['GOODVIBES_DAEMON_HOME'] = saved;
});

test('the operator token path follows the daemon home override', () => {
  process.env['GOODVIBES_DAEMON_HOME'] = '/srv/gv-daemon';
  const paths = readAuthPaths({ workingDirectory: '/work', homeDirectory: '/home/u' });
  expect(paths.operatorTokenPath).toBe(join('/srv/gv-daemon', 'operator-tokens.json'));
  expect(resolveDaemonStateDirectory('/home/u')).toBe('/srv/gv-daemon');
});

test('without an override the daemon home is under the user home', () => {
  delete process.env['GOODVIBES_DAEMON_HOME'];
  expect(resolveDaemonStateDirectory('/home/u')).toBe(join('/home/u', '.goodvibes', 'daemon'));
});
