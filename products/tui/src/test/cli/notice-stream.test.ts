import { expect, test } from 'bun:test';
import { startupNoticeWriter } from '@goodvibes-jev/engine/terminal-shell/cli-entrypoint';

function route(cli: Parameters<typeof startupNoticeWriter>[0]): string {
  const sent: string[] = [];
  startupNoticeWriter(cli, { out: () => sent.push('out'), err: () => sent.push('err') })('notice');
  return sent[0]!;
}

test('a notice goes to stdout for plain text output', () => {
  expect(route({ command: 'status', flags: { outputFormat: 'text' } })).toBe('out');
  expect(route({ command: 'status', flags: {} })).toBe('out');
});

test('a notice goes to stderr for json output, so it cannot precede the JSON', () => {
  expect(route({ command: 'status', flags: { outputFormat: 'json' } })).toBe('err');
});

test('a notice goes to stderr for run', () => {
  expect(route({ command: 'run', flags: { outputFormat: 'text' } })).toBe('err');
});
