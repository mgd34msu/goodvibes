/**
 * The IMAP wire and the IDLE round, where a response that arrives in an
 * unlucky shape used to be lost or to desynchronise the stream.
 *
 * An in-memory socket stands in for the server, so what is asserted is the
 * order in which bytes arrive and which waiter exists when they do. No
 * network, and nothing waits on real time: the IDLE re-issue timer is a fake
 * clock that is never advanced.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ImapSession } from '../platform/src/platform/email/imap-session.ts';
import { wireLines } from '../platform/src/platform/email/imap-wire-frames.ts';
import { classifyReadFailure } from '../platform/src/platform/email/inbound/capability.ts';
import { runIdleRound } from '../platform/src/platform/email/inbound/idle-watcher.ts';
import { resolveWatcherSettings } from '../platform/src/platform/email/inbound/ports.ts';
import { FakeClock, flush } from './_helpers/inbound-watcher-harness.ts';
import { imapFixturePort } from './_helpers/imap-semantic-port.ts';

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousPort = installJudgmentPort(imapFixturePort().port); });
afterEach(() => { installJudgmentPort(previousPort); });

/** A server-less socket: what the client writes is handed to `onWrite`, and `push` plays the server. */
class ScriptedSocket extends EventEmitter {
  readonly writes: string[] = [];
  destroyed = false;
  onWrite: (data: string) => void = () => {};
  write(data: string, _encoding: string, done: (error?: Error) => void): boolean {
    this.writes.push(data);
    this.onWrite(data);
    done();
    return true;
  }
  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit('close');
    return this;
  }
  push(bytes: string): void { this.emit('data', Buffer.from(bytes, 'utf8')); }
  asSocket(): Socket { return this as unknown as Socket; }
}

/** Play the server's answer once the current write has returned, as a real network would. */
function later(action: () => void): void { setImmediate(action); }

describe('an IDLE wake that shares a network chunk with the continuation', () => {
  test('ends the round at once instead of waiting for the re-issue timer', async () => {
    const socket = new ScriptedSocket();
    socket.onWrite = (data) => {
      if (/^A0001 IDLE\r\n$/.test(data)) later(() => { socket.push('+ idling\r\n* 7 EXISTS\r\n'); });
      if (data === 'DONE\r\n') later(() => { socket.push('A0001 OK IDLE terminated\r\n'); });
    };
    const session = new ImapSession(socket.asSocket(), 1_000, 1_000_000);
    const clock = new FakeClock();
    const abort = new AbortController();

    let result: Awaited<ReturnType<typeof runIdleRound>> | undefined;
    void runIdleRound({
      wire: session,
      clock,
      settings: resolveWatcherSettings({ account: 'primary', mailbox: 'INBOX' }),
      signal: abort.signal,
      roundIndex: 0,
    }).then((value) => { result = value; });
    // The fake clock is never advanced, so only the wake line can end this round.
    await flush(5);
    abort.abort();

    expect(result?.outcome).toBe('continue');
    expect(result?.wake.endedBy).toBe('untagged');
    expect(result?.wake.refetch).toBe(true);
    expect(clock.pending).toBe(0);
    session.destroy();
  });
});

describe('text that happens to end in a brace count', () => {
  test('a tagged refusal is a line, not a literal announcement', () => {
    const frames = [...wireLines('A0004 NO could not parse {3}\r\nabc\r\n', true)];
    expect(frames.map((frame) => frame.syntax)).toEqual(['A0004 NO could not parse {3}', 'abc']);
    expect(frames.every((frame) => frame.literal === undefined)).toBe(true);
  });

  test('a real FETCH literal is still read as one', () => {
    const frames = [...wireLines('* 1 FETCH (BODY[] {3}\r\nabc)\r\n', true)];
    expect(frames[0]?.literal).toBe('abc');
  });

  test('the command fails with the server wording instead of swallowing the next response', async () => {
    const socket = new ScriptedSocket();
    socket.onWrite = () => { later(() => { socket.push('A0001 NO could not parse {12}\r\n'); }); };
    const session = new ImapSession(socket.asSocket(), 1_000, 1_000_000);
    await expect(session.command('SELECT INBOX')).rejects.toThrow('IMAP command failed: A0001 NO could not parse {12}');
    session.destroy();
  });
});

describe('a literal command that is abandoned after the server said to go ahead', () => {
  test('fails the session so the next command is not written into the literal', async () => {
    const socket = new ScriptedSocket();
    let stale = false;
    socket.onWrite = (data) => {
      if (data.includes(' APPEND ')) later(() => { stale = true; socket.push('+ Ready for literal data\r\n'); });
    };
    const session = new ImapSession(socket.asSocket(), 1_000, 1_000_000);

    await expect(session.commandWithLiteral('APPEND Drafts', 'hello', {
      assertCurrent: () => { if (stale) throw new Error('stale'); },
    })).rejects.toThrow();

    const writesBefore = socket.writes.length;
    await expect(session.command('NOOP')).rejects.toThrow();
    expect(socket.writes.length).toBe(writesBefore);
    expect(socket.destroyed).toBe(true);
  });

  test('a refusal in place of the continuation leaves the session usable', async () => {
    const socket = new ScriptedSocket();
    socket.onWrite = (data) => {
      if (data.includes(' APPEND ')) later(() => { socket.push('A0001 NO [OVERQUOTA] mailbox full\r\n'); });
      if (data.includes(' NOOP')) later(() => { socket.push('A0002 OK done\r\n'); });
    };
    const session = new ImapSession(socket.asSocket(), 1_000, 1_000_000);
    await expect(session.commandWithLiteral('APPEND Drafts', 'hello')).rejects.toThrow('OVERQUOTA');
    await expect(session.command('NOOP')).resolves.toEqual(['A0002 OK done']);
    session.destroy();
  });
});

describe('a command that finished just before the socket closed', () => {
  test('still returns its result to the caller that had not collected it yet', async () => {
    const socket = new ScriptedSocket();
    socket.onWrite = () => { socket.push('* 3 EXISTS\r\nA0001 OK done\r\n'); };
    const session = new ImapSession(socket.asSocket(), 1_000, 1_000_000);
    const tag = await session.sendCommand('NOOP');
    socket.destroy();
    await expect(session.awaitTag(tag)).resolves.toEqual(['* 3 EXISTS', 'A0001 OK done']);
  });
});

describe('an uncoded refusal of a FETCH', () => {
  const refusal = new Error('IMAP command failed: A0007 NO Request failed');

  test('is a wait while the caller is still counting, and terminal once it has repeated', async () => {
    const first = await classifyReadFailure(refusal, 'fetch', {}, { consecutive: 0, giveUpAfter: 3 });
    expect(first.terminal).toBe(false);
    expect(first.verdict.reason).toBe('reconnecting');

    const third = await classifyReadFailure(refusal, 'fetch', {}, { consecutive: 2, giveUpAfter: 3 });
    expect(third.terminal).toBe(true);
    expect(third.verdict.reason).toBe('fetch-refused');
  });

  test('a refusal that names its cause is not softened by the count', async () => {
    const coded = await classifyReadFailure(
      new Error('IMAP command failed: A0007 NO [NONEXISTENT] no such mailbox'),
      'fetch',
      {},
      { consecutive: 0, giveUpAfter: 3 },
    );
    expect(coded.terminal).toBe(true);
    expect(coded.verdict.reason).toBe('mailbox-unreadable');
  });
});
