import { describe, expect, test } from 'bun:test';
import { writeAllToFd } from '../../utils/fatal-boot-write.ts';

function eagain(): Error {
  return Object.assign(new Error('resource temporarily unavailable'), { code: 'EAGAIN' });
}

/** A fake descriptor that accepts at most `chunk` bytes per call and throws EAGAIN for the scripted calls. */
function fakeFd(chunk: number, failures: Set<number>) {
  const received: Buffer[] = [];
  let calls = 0;
  const pauses: number[] = [];
  return {
    received, pauses,
    write(_fd: number, buffer: Buffer, offset: number, length: number): number {
      calls += 1;
      if (failures.has(calls)) throw eagain();
      const n = Math.min(chunk, length);
      received.push(buffer.subarray(offset, offset + n));
      return n;
    },
    pause(ms: number) { pauses.push(ms); },
  };
}

describe('writeAllToFd', () => {
  test('keeps writing after a full pipe says EAGAIN, so a long render is not cut off', () => {
    const fd = fakeFd(4, new Set([2, 3, 6]));
    const payload = Buffer.from('0123456789abcdefghij');
    writeAllToFd(1, payload, fd.write, fd.pause);
    expect(Buffer.concat(fd.received).toString()).toBe('0123456789abcdefghij');
    expect(fd.pauses.length).toBe(3);
  });

  test('gives up on a pipe that stays full, keeping what got through', () => {
    const received: Buffer[] = [];
    let writes = 0;
    const write = (_fd: number, buffer: Buffer, offset: number, length: number): number => {
      writes += 1;
      if (writes > 1) throw eagain();
      received.push(buffer.subarray(offset, offset + 2)); return Math.min(2, length);
    };
    writeAllToFd(1, Buffer.from('abcdefgh'), write, () => {});
    expect(Buffer.concat(received).toString()).toBe('ab');
    expect(writes).toBeLessThan(100);
  });

  test('stops at once on an error that is not EAGAIN', () => {
    let writes = 0;
    writeAllToFd(1, Buffer.from('abc'), () => { writes += 1; throw Object.assign(new Error('closed'), { code: 'EPIPE' }); }, () => {});
    expect(writes).toBe(1);
  });
});
