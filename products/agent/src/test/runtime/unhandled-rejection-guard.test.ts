import { describe, expect, test } from 'bun:test';
import { createUnhandledRejectionHandler } from '../../runtime/unhandled-rejection-guard.ts';

function setup() {
  let clock = 1_000_000;
  const notices: string[] = [];
  let renders = 0;
  const handler = createUnhandledRejectionHandler({
    notifyHigh: (message) => notices.push(message),
    render: () => { renders += 1; },
    now: () => clock,
  });
  return { handler, notices, renders: () => renders, advance: (ms: number) => { clock += ms; } };
}

describe('unhandled rejection guard', () => {
  test('isolated rejections are single error lines', () => {
    const { handler, notices } = setup();
    handler(new Error('one'));
    handler(new Error('two'));
    handler(new Error('three'));
    expect(notices).toEqual(['[Error] one', '[Error] two', '[Error] three']);
  });

  test('a fourth rejection inside the window escalates to a restart suggestion', () => {
    const { handler, notices, renders } = setup();
    for (const reason of ['a', 'b', 'c', 'd']) handler(new Error(reason));
    expect(notices.slice(0, 3).every((notice) => notice.startsWith('[Error]'))).toBe(true);
    expect(notices[3]).toContain('[Critical]');
    expect(notices[3]).toContain('4 in 10s');
    expect(notices[3]).toContain('Latest: d');
    expect(renders()).toBe(4);
  });

  test('rejections spread past the window never escalate', () => {
    const { handler, notices, advance } = setup();
    for (const reason of ['a', 'b', 'c', 'd', 'e', 'f']) {
      handler(new Error(reason));
      advance(10_001);
    }
    expect(notices.every((notice) => notice.startsWith('[Error]'))).toBe(true);
  });

  test('a non-Error reason is reported as its text', () => {
    const { handler, notices } = setup();
    handler('plain string');
    expect(notices).toEqual(['[Error] plain string']);
  });
});
