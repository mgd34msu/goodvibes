import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketOutbox, sweepStaleWebSocketOutboxes } from '../platform/src/platform/daemon/websocket-outbox.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ws-sweep-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function spill(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'outbox'), 'private event body');
  return dir;
}

describe('sweepStaleWebSocketOutboxes', () => {
  test('removes the spill directory of a process that is gone and keeps one whose owner is alive', () => {
    const dead = spill('goodvibes-ws-4242-abcdef');
    const alive = spill('goodvibes-ws-4343-abcdef');
    const unrelated = spill('something-else');

    const removed = sweepStaleWebSocketOutboxes(root, { isAlive: (pid) => pid === 4343 });

    expect(removed).toBe(1);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(alive)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  test('an old directory goes even when its pid looks alive (pid reuse), and one without a pid goes only by age', () => {
    const now = Date.now();
    const reused = spill('goodvibes-ws-4343-old000');
    const legacyOld = spill('goodvibes-ws-legacyold');
    const legacyFresh = spill('goodvibes-ws-legacynew');
    const old = new Date(now - 25 * 60 * 60 * 1000);
    utimesSync(reused, old, old);
    utimesSync(legacyOld, old, old);

    sweepStaleWebSocketOutboxes(root, { now, isAlive: () => true });

    expect(existsSync(reused)).toBe(false);
    expect(existsSync(legacyOld)).toBe(false);
    expect(existsSync(legacyFresh)).toBe(true);
  });

  test('a live outbox in this process is not swept', () => {
    const own = spill(`goodvibes-ws-${process.pid}-live00`);
    sweepStaleWebSocketOutboxes(root, { isAlive: () => false });
    expect(existsSync(own)).toBe(true);
  });

  test('an unreadable directory is not an error', () => {
    expect(sweepStaleWebSocketOutboxes(join(root, 'missing'))).toBe(0);
  });
});

describe('WebSocketOutbox spill directory name', () => {
  test('names the owning process so a later start can tell it is stale', () => {
    const outbox = new WebSocketOutbox({ send: () => {}, getBufferedAmount: () => 10 * 1024 * 1024 });
    // Over the buffered-amount limit the message spills to disk.
    outbox.send('x');
    const spilled = readdirSync(tmpdir()).filter((n) => n.startsWith(`goodvibes-ws-${process.pid}-`));
    outbox.close();
    expect(spilled.length).toBeGreaterThan(0);
  });
});
