/**
 * What an SMTP failure tells the caller, and what stays open afterwards.
 * Everything runs against an in-process fake server on loopback.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { SmtpClient, SmtpDeliveryUnconfirmedError } from '../platform/src/platform/email/smtp-client.ts';

const tlsCalls: Array<Record<string, unknown>> = [];
mock.module('node:tls', () => ({
  connect: (options: Record<string, unknown>, onConnect?: () => void) => {
    tlsCalls.push(options);
    const { PassThrough } = require('node:stream') as typeof import('node:stream');
    const fake = new PassThrough();
    if (onConnect) queueMicrotask(onConnect);
    return fake;
  },
}));

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

function line(socket: Socket, text: string): void {
  socket.write(`${text}\r\n`);
}

async function listen(script: (socket: Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(script);
    server.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port));
  });
}

async function open(port: number): Promise<Socket> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port }, () => resolve(sock));
  });
}

function speak(socket: Socket, onData: (command: string, inData: boolean) => string | null): void {
  line(socket, '220 fake ESMTP');
  socket.setEncoding('utf8');
  let buffer = '';
  let inData = false;
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let pos: number;
    while ((pos = buffer.indexOf('\n')) !== -1) {
      const command = buffer.slice(0, pos).replace(/\r$/, '');
      buffer = buffer.slice(pos + 1);
      if (inData) {
        if (command === '.') {
          inData = false;
          const reply = onData(command, true);
          if (reply === null) socket.destroy();
          else line(socket, reply);
        }
        continue;
      }
      const upper = command.toUpperCase();
      if (upper.startsWith('EHLO')) { line(socket, '250-fake'); line(socket, '250 AUTH PLAIN'); }
      else if (upper.startsWith('AUTH')) {
        const reply = onData(command, false);
        line(socket, reply ?? '235 ok');
      }
      else if (upper.startsWith('MAIL') || upper.startsWith('RCPT')) line(socket, '250 OK');
      else if (upper === 'DATA') { inData = true; line(socket, '354 go'); }
    }
  });
}

const mail = { from: 'a@example.test', to: 'b@example.test', subject: 's', body: 'hello' };

describe('a send whose final reply never arrives', () => {
  test('is reported as unconfirmed, not as a plain failure', async () => {
    const port = await listen((s) => speak(s, () => null));
    const client = new SmtpClient({ socket: await open(port), hostname: 'client.test', username: 'u', password: 'p', timeoutMs: 5000 });
    const error = await client.sendMail(mail).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmtpDeliveryUnconfirmedError);
    expect((error as SmtpDeliveryUnconfirmedError).retryable).toBe(false);
    expect((error as Error).message).toContain('may already have been delivered');
  });

  test('a refusal before the message is written stays an ordinary failure', async () => {
    const port = await listen((s) => speak(s, (command) => (command.startsWith('AUTH') ? '535 bad' : '250 ok')));
    const client = new SmtpClient({ socket: await open(port), hostname: 'client.test', username: 'u', password: 'p', timeoutMs: 5000 });
    const error = await client.sendMail(mail).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SmtpDeliveryUnconfirmedError);
  });

  test('a final rejection is a definite failure, not an unconfirmed one', async () => {
    const port = await listen((s) => speak(s, (command, inData) => (inData ? '554 rejected' : null)));
    const client = new SmtpClient({ socket: await open(port), hostname: 'client.test', username: 'u', password: 'p', timeoutMs: 5000 });
    const error = await client.sendMail(mail).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SmtpDeliveryUnconfirmedError);
    expect((error as Error).message).toContain('rejected');
  });
});

describe('verifyAuth', () => {
  test('closes the socket when authentication is refused', async () => {
    const port = await listen((s) => speak(s, (command) => (command.startsWith('AUTH') ? '535 bad' : '250 ok')));
    const socket = await open(port);
    const client = new SmtpClient({ socket, hostname: 'client.test', username: 'u', password: 'p', timeoutMs: 5000 });
    await expect(client.verifyAuth()).rejects.toThrow();
    expect(socket.destroyed).toBe(true);
  });
});

describe('the SMTP TLS connections', () => {
  test('authenticate the server whatever the process-wide TLS defaults are', async () => {
    const { createSmtpTlsSocket } = await import('../platform/src/platform/email/node.ts');
    tlsCalls.length = 0;
    await createSmtpTlsSocket('smtp.example.test', 465);
    expect(tlsCalls).toHaveLength(1);
    expect(tlsCalls[0]?.['rejectUnauthorized']).toBe(true);
  });

  test('the STARTTLS upgrade does too', async () => {
    const { createSmtpStartTlsSocket } = await import('../platform/src/platform/email/node.ts');
    const port = await listen((s) => {
      line(s, '220 fake');
      s.setEncoding('utf8');
      s.on('data', (chunk: string) => {
        if (/EHLO/i.test(chunk)) line(s, '250 fake');
        else if (/STARTTLS/i.test(chunk)) line(s, '220 go');
      });
    });
    tlsCalls.length = 0;
    await createSmtpStartTlsSocket('127.0.0.1', port);
    expect(tlsCalls).toHaveLength(1);
    expect(tlsCalls[0]?.['rejectUnauthorized']).toBe(true);
  });
});
