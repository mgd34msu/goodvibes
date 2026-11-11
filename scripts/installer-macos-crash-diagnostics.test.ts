import { afterEach, expect, test } from 'bun:test';
import { lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectMacosCrashes, summarizeMacosCrash } from './collect-macos-native-crash.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const nowMs = Date.now(), startedAtMs = nowMs - 10_000;
const daemonPath = '/Users/original-account/.local/bin/goodvibes-daemon';
const window = { startedAtMs, nowMs, daemonPath };
const secret = 'private-token-home-path-runtime-value';
function report(changes: Record<string, unknown> = {}) {
  return { procName: 'goodvibes-daemon', captureTime: new Date(nowMs - 1_000).toISOString(), procLaunch: new Date(nowMs - 5_000).toISOString(),
    procPath: daemonPath, env: { TOKEN: secret }, asi: { message: secret },
    exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGKILL', subtype: secret, codes: secret },
    termination: { namespace: 'CODESIGNING', code: 2, indicator: 'Invalid Page', details: secret },
    faultingThread: 0, threads: [{ triggered: true, name: secret, frames: [{ imageIndex: 0, symbol: 'sqlite3_initialize', imageOffset: 123456, symbolLocation: 98765 }] }],
    usedImages: [{ name: 'libsqlite3.dylib', path: '/Users/' + secret, uuid: secret, base: 123456 }], ...changes };
}
function ips(value: object) { return JSON.stringify({ bug_type: '309', app_name: 'goodvibes-daemon', privateHeader: secret }) + '\n' + JSON.stringify(value); }
function directory() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'safe-macos-crash-'))); roots.push(root); return root; }
function put(root: string, name: string, raw: string, modified = nowMs - 100) {
  const path = join(root, name); writeFileSync(path, raw); utimesSync(path, modified / 1000, modified / 1000); return path;
}

test('actual IPS parsing retains only fixed native fault fields and symbolic frames', () => {
  const summary = summarizeMacosCrash(ips(report()), window);
  expect(summary).toEqual({ exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGKILL' }, termination: { namespace: 'CODESIGNING', code: 2, indicator: 'Invalid Page' },
    frames: [{ image: 'libsqlite3.dylib', symbol: 'sqlite3_initialize' }] });
  expect(JSON.stringify(summary)).not.toContain(secret);
  expect(JSON.stringify(summary)).not.toMatch(/123456|98765|procPath|uuid|privateHeader|details|env/);
  const nativeDates = report({ captureTime: '2026-11-10 12:00:00.123456 -0600', procLaunch: '2026-11-10 11:59:59.123456 -0600' });
  expect(() => summarizeMacosCrash(ips(nativeDates), { startedAtMs: Date.parse('2026-11-10T17:59:58Z'), nowMs: Date.parse('2026-11-10T18:00:01Z'), daemonPath })).not.toThrow();
});

test('unknown runtime strings, ambiguous faulting threads and unknown image names stay private', () => {
  const value = report({ exception: { type: secret, signal: secret }, termination: { namespace: secret, code: 0x100000000, indicator: 'Invalid Page ' + secret },
    threads: [{ triggered: true, frames: [{ imageIndex: 0, symbol: secret }] }, { triggered: true, frames: [] }] });
  expect(summarizeMacosCrash(ips(value), window)).toEqual({ exception: {}, termination: {}, frames: [] });
  const unknown = report({ usedImages: [{ name: secret, path: '/libsqlite3.dylib' }] });
  expect(summarizeMacosCrash(ips(unknown), window).frames).toEqual([]);
  const symbol = report({ threads: [{ triggered: true, frames: [{ imageIndex: 0, symbol: secret }] }] });
  expect(summarizeMacosCrash(ips(symbol), window).frames).toEqual([{ image: 'libsqlite3.dylib' }]);
});

test('collector admits only fresh original daemon reports from owned ordinary files', () => {
  const root = directory();
  put(root, 'goodvibes-daemon-current.ips', ips(report()));
  put(root, 'other-process-current.ips', ips(report({ procPath: '/other-process' })));
  put(root, 'goodvibes-daemon-wrong-process.ips', ips(report({ procName: 'other-process', procPath: '/other-process' })));
  put(root, 'goodvibes-daemon-stale-body.ips', ips(report({ captureTime: new Date(startedAtMs - 1).toISOString() })));
  put(root, 'goodvibes-daemon-old-process.ips', ips(report({ procLaunch: new Date(startedAtMs - 1).toISOString() })));
  put(root, 'goodvibes-daemon-stale-file.ips', ips(report()), startedAtMs - 1_000);
  put(root, 'goodvibes-daemon-malformed.ips', secret);
  put(root, 'goodvibes-daemon-oversized.ips', ' '.repeat(2 * 1024 * 1024 + 1));
  const outside = join(directory(), 'outside.ips'); writeFileSync(outside, ips(report()));
  symlinkSync(outside, join(root, 'goodvibes-daemon-linked.ips'));
  mkdirSync(join(root, 'goodvibes-daemon-directory.ips'));
  const result = collectMacosCrashes({ directory: root, ...window });
  expect(result.status).toBe('reports-found'); expect(result.reports).toHaveLength(1);
  expect(result.reports[0]).toEqual(summarizeMacosCrash(ips(report()), window));
  expect(JSON.stringify(result)).not.toContain(secret);
});

test('Bun filenames and truncated process names qualify only through the exact original daemon path', () => {
  const root = directory();
  put(root, 'Bun-current.ips', ips(report({ procName: 'goodvibes-daemo' })));
  put(root, 'bun-another.ips', ips(report({ procName: 'Bun', procPath: '/private/other', usedImages: [{ name: 'goodvibes-daemon-macos-arm64', path: daemonPath }] })));
  put(root, 'Bun-unrelated.ips', ips(report({ procName: 'Bun', procPath: daemonPath + '-foreign' })));
  put(root, 'Bun-name-only.ips', ips(report({ procName: 'Bun', procPath: '/private/other', usedImages: [{ name: 'goodvibes-daemon-macos-arm64', path: '/private/other' }] })));
  const result = collectMacosCrashes({ directory: root, ...window });
  expect(result.status).toBe('reports-found'); expect(result.reports).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain(daemonPath);
});

test('linked and foreign report directories do not grant a crash read', () => {
  const parent = directory(), actual = directory(), linked = join(parent, 'DiagnosticReports');
  put(actual, 'goodvibes-daemon-current.ips', ips(report())); symlinkSync(actual, linked, 'dir');
  expect(collectMacosCrashes({ directory: linked, ...window })).toEqual({ schema: 1, status: 'unavailable', reports: [] });
  expect(collectMacosCrashes({ directory: actual, ...window, uid: lstatSync(actual).uid + 1 })).toEqual({ schema: 1, status: 'unavailable', reports: [] });
});

test('private input and symbolic frame work remain bounded and malformed headers are refused', () => {
  const root = directory();
  const value = report({ threads: [{ triggered: true, frames: Array.from({ length: 20 }, () => ({ imageIndex: 0, symbol: 'sqlite3_initialize' })) }] });
  for (let index = 0; index < 20; index++) put(root, `goodvibes-daemon-${index}.ips`, ips(value));
  const result = collectMacosCrashes({ directory: root, ...window });
  expect(result.reports).toHaveLength(16); expect(result.reports.every(item => item.frames.length === 8)).toBe(true);
  expect(() => summarizeMacosCrash(JSON.stringify({ bug_type: '288' }) + '\n' + JSON.stringify(report()), window)).toThrow();
});
