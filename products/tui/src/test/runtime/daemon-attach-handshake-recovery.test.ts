/**
 * What a refused daemon costs the owner, and how it is let back in.
 *
 * The `/status?receipts=consume` read deletes the daemon's undelivered receipts
 * as it answers, so a refusal that returned before rendering them lost them for
 * good. And a refusal that rewrote the status to `incompatible` must not stop the
 * next attach from reading the daemon again: a daemon that updated and came back
 * is exactly the case the handshake exists for.
 */
import { describe, expect, test } from 'bun:test';
import { createDaemonAttachHandshake } from '../../runtime/client/daemon-attach-handshake.ts';
import { ClientBuildGuard } from '../../runtime/client/build-floors.ts';
import type { ExternalDaemonAttachRead } from '../../runtime/daemon-attach-notices.ts';
import type { HostServiceStatus } from '@/runtime/index.ts';

const ADOPTED: HostServiceStatus = { mode: 'external', host: '127.0.0.1', port: 3421, baseUrl: 'http://127.0.0.1:3421' };

function answered(version: string, notices: string[] = []): ExternalDaemonAttachRead {
  return { answered: true, notices, clientFloor: undefined, statusPayload: { status: 'running', version } };
}

function harness(reads: ExternalDaemonAttachRead[], schedule?: (run: () => void, delayMs: number) => () => void) {
  let status: HostServiceStatus = ADOPTED;
  const adopted: HostServiceStatus[] = [];
  const notices: string[] = [];
  let readIndex = 0;
  const handshake = createDaemonAttachHandshake({
    clientBuildGuard: new ClientBuildGuard({ clientVersion: '1.28.0' }),
    readDaemonStatus: () => status,
    recordRefusal: (next) => { status = next; },
    adopt: (next) => { adopted.push(next); },
    notify: (text) => { notices.push(text); },
    daemonFloor: '1.28.0',
    read: async () => reads[Math.min(readIndex++, reads.length - 1)]!,
    schedule,
  });
  return { handshake, adopted, notices, status: () => status };
}

describe('receipts read from a daemon that is then refused', () => {
  test('are still shown, because the read that refused it is the one that consumed them', async () => {
    const h = harness([answered('1.27.1', ['updated to 1.27.1', 'restarted after a crash at 14:32'])]);

    await h.handshake.attach('bearer');

    expect(h.status().mode).toBe('incompatible');
    expect(h.notices).toContain('updated to 1.27.1');
    expect(h.notices).toContain('restarted after a crash at 14:32');
  });
});

describe('a refused daemon that comes back newer', () => {
  test('is read again on the next attach and adopted, and the refusal is cleared from the status', async () => {
    const h = harness([answered('1.27.1'), answered('1.28.2')]);

    await h.handshake.attach('bearer');
    expect(h.status().mode).toBe('incompatible');
    expect(h.adopted.at(-1)?.mode).toBe('incompatible');

    // What the liveness flip a daemon update causes runs.
    await h.handshake.attach('bearer');

    expect(h.adopted.at(-1)).toEqual(ADOPTED);
    expect(h.status()).toEqual(ADOPTED);
  });

  test('stays refused while it is still old, and when the re-read gets no answer', async () => {
    const unanswered: ExternalDaemonAttachRead = { answered: false, notices: [], clientFloor: undefined, statusPayload: null };
    const h = harness([answered('1.27.1'), unanswered, answered('1.27.1')]);

    await h.handshake.attach('bearer');
    await h.handshake.attach('bearer');
    expect(h.adopted.at(-1)?.mode).toBe('incompatible');
    await h.handshake.attach('bearer');
    expect(h.adopted.at(-1)?.mode).toBe('incompatible');
    expect(h.status().mode).toBe('incompatible');
  });
});

describe('a refused daemon with nothing else to report its update', () => {
  test('is re-read by the handshake itself, and the re-probe stops once the daemon is adopted', async () => {
    const pending: Array<() => void> = [];
    const h = harness([answered('1.27.1'), answered('1.28.2')], (run) => {
      pending.push(run);
      return () => { pending.length = 0; };
    });

    await h.handshake.attach('bearer');
    expect(h.status().mode).toBe('incompatible');
    expect(pending).toHaveLength(1);

    // The timer fires with no liveness flip and no restart verb.
    pending.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.status()).toEqual(ADOPTED);
    expect(h.adopted.at(-1)).toEqual(ADOPTED);
    expect(pending).toHaveLength(0);
  });
});
