// Proves: Archiving or deleting a mail on a server without MOVE expunges the owner's message while no copy of it is in the target folder, or copies it there twice.
// Red when: A message already marked deleted is expunged without its copy being found in the target, or a retry after an interrupted archive copies it again.
/**
 * Without MOVE, an archive or delete is three commands: COPY to the target,
 * mark the original \Deleted, expunge that UID. A connection lost after the
 * mark leaves a marked original and a copy; the retry must finish that one
 * without a second copy. A \Deleted mark another mail program set proves no
 * copy exists, so that message is never expunged unless its copy is found.
 *
 * Real mail service, its settings and secret stores and the real IMAP client;
 * the mail server is a loopback stand-in with three folders that keeps every
 * message, flag and expunge, and drops the connection when told to.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { daemonSecretKeyFor } from '../platform/src/platform/config/daemon-secret-keys.ts';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';
import { EmailService } from '../platform/src/platform/email/email-service.ts';
import { nodeEmailTransport } from '../platform/src/platform/email/node.ts';
import { describeSenderClaimNeutrally } from '../platform/src/platform/email/sender-claim.ts';
import { withSurfaceEmailConfig } from '../platform/src/platform/email/surface-config.ts';
import { connectSocket, makeFakeImapServer, serverWrite } from './_helpers/fake-imap-server.ts';
import { writeFetchSectionResponse } from './_helpers/imap-fetch-framing.ts';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface StoredMessage { readonly uid: number; readonly messageId: string; readonly flags: Set<string> }
interface Folder { readonly uidValidity: number; nextUid: number; messages: StoredMessage[]; readonly attribute: string }

/** An IMAP server with IMAP4rev1 and UIDPLUS but no MOVE: INBOX, Archive (\Archive) and Trash (\Trash). */
async function mailServer() {
  const folders = new Map<string, Folder>([
    ['INBOX', { uidValidity: 42, nextUid: 101, messages: [], attribute: '' }],
    ['Archive', { uidValidity: 7, nextUid: 1, messages: [], attribute: ' \\Archive' }],
    ['Trash', { uidValidity: 9, nextUid: 1, messages: [], attribute: ' \\Trash' }],
  ]);
  const script = { dropOnExpunge: 0 };
  const folder = (name: string): Folder => folders.get(name.replace(/^"|"$/g, ''))!;
  const server = await makeFakeImapServer((socket: Socket) => {
    let selected: Folder | null = null;
    socket.on('error', () => undefined);
    serverWrite(socket, '* OK [CAPABILITY IMAP4rev1 UIDPLUS] ready');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const tag = line.split(' ')[0]!;
        const rest = line.slice(tag.length + 1);
        const found = (uid: number) => selected?.messages.findIndex((message) => message.uid === uid) ?? -1;
        let match: RegExpExecArray | null;
        if (/^LOGIN /i.test(rest)) serverWrite(socket, `${tag} OK [CAPABILITY IMAP4rev1 UIDPLUS] Logged in`);
        else if ((match = /^(EXAMINE|SELECT) (.+)$/i.exec(rest)) !== null) {
          selected = folder(match[2]!);
          serverWrite(socket, `* ${String(selected.messages.length)} EXISTS`);
          serverWrite(socket, `* OK [UIDVALIDITY ${String(selected.uidValidity)}] UIDs valid`);
          serverWrite(socket, `* OK [UIDNEXT ${String(selected.nextUid)}] Predicted next UID`);
          serverWrite(socket, `${tag} OK [${match[1]!.toUpperCase() === 'SELECT' ? 'READ-WRITE' : 'READ-ONLY'}] done`);
        } else if (/^LIST /i.test(rest)) {
          for (const [name, entry] of folders) serverWrite(socket, `* LIST (\\HasNoChildren${entry.attribute}) "/" "${name}"`);
          serverWrite(socket, `${tag} OK LIST completed`);
        } else if ((match = /^UID SEARCH UID (\d+)$/i.exec(rest)) !== null) {
          serverWrite(socket, found(Number(match[1])) >= 0 ? `* SEARCH ${match[1]!}` : '* SEARCH');
          serverWrite(socket, `${tag} OK SEARCH completed`);
        } else if ((match = /^UID SEARCH HEADER Message-ID "([^"]+)"$/i.exec(rest)) !== null) {
          const wanted = match[1]!;
          serverWrite(socket, `* SEARCH ${(selected?.messages ?? []).filter((message) => message.messageId === wanted).map((message) => message.uid).join(' ')}`.trimEnd());
          serverWrite(socket, `${tag} OK SEARCH completed`);
        } else if ((match = /^UID FETCH (\d+) FLAGS$/i.exec(rest)) !== null) {
          const at = found(Number(match[1]));
          if (at >= 0) serverWrite(socket, `* ${String(at + 1)} FETCH (UID ${match[1]!} FLAGS (${[...selected!.messages[at]!.flags].join(' ')}))`);
          serverWrite(socket, `${tag} OK FETCH completed`);
        } else if ((match = /^UID FETCH (\d+) BODY\.PEEK\[HEADER\.FIELDS \(MESSAGE-ID\)\]$/i.exec(rest)) !== null) {
          const at = found(Number(match[1]));
          if (at >= 0) {
            const message = selected!.messages[at]!;
            writeFetchSectionResponse(socket, { seq: at + 1, uid: message.uid, section: 'BODY[HEADER.FIELDS (MESSAGE-ID)]', payload: `Message-ID: ${message.messageId}\r\n\r\n` });
          }
          serverWrite(socket, `${tag} OK FETCH completed`);
        } else if ((match = /^UID COPY (\d+) (.+)$/i.exec(rest)) !== null) {
          const at = found(Number(match[1]));
          const target = folder(match[2]!);
          if (at >= 0) target.messages.push({ uid: target.nextUid++, messageId: selected!.messages[at]!.messageId, flags: new Set() });
          serverWrite(socket, `${tag} OK COPY completed`);
        } else if ((match = /^UID STORE (\d+) \+FLAGS\.SILENT \(\\Deleted\)$/i.exec(rest)) !== null) {
          const at = found(Number(match[1]));
          if (at >= 0) selected!.messages[at]!.flags.add('\\Deleted');
          serverWrite(socket, `${tag} OK STORE completed`);
        } else if ((match = /^UID EXPUNGE (\d+)$/i.exec(rest)) !== null) {
          if (script.dropOnExpunge > 0) { script.dropOnExpunge -= 1; socket.destroy(); return; }
          const at = found(Number(match[1]));
          if (at >= 0 && selected!.messages[at]!.flags.has('\\Deleted')) {
            selected!.messages.splice(at, 1);
            serverWrite(socket, `* ${String(at + 1)} EXPUNGE`);
          }
          serverWrite(socket, `${tag} OK EXPUNGE completed`);
        } else if (/^LOGOUT$/i.test(rest)) {
          serverWrite(socket, '* BYE Logging out');
          serverWrite(socket, `${tag} OK LOGOUT completed`);
        } else serverWrite(socket, `${tag} BAD Unrecognised command`);
      }
    });
  });
  cleanups.push(() => server.close());
  const deliver = (messageId: string, flags: readonly string[] = []): number => {
    const inbox = folders.get('INBOX')!;
    const uid = inbox.nextUid++;
    inbox.messages.push({ uid, messageId, flags: new Set(flags) });
    return uid;
  };
  /** The Message-IDs a folder holds, one entry per message. */
  const holds = (name: string): string[] => folders.get(name)!.messages.map((message) => message.messageId);
  return { port: server.address.port, script, deliver, holds };
}

/** The mail service over a home whose mail settings and password point at the server. */
async function mailService(port: number): Promise<EmailService> {
  const root = mkdtempSync(join(tmpdir(), 'gv-mail-archive-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configManager = new ConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(root, 'daemon', 'settings.json'), ownsDaemonTier: true });
  expect(configManager.setMany([
    { key: 'surfaces.email.host' as ConfigKey, value: 'imap.test' },
    { key: 'surfaces.email.user' as ConfigKey, value: 'owner@example.test' },
  ], localOwnerActor()).ok).toBe(true);
  const secretsManager = new SecretsManager({ surfaceRoot: 'goodvibes', globalHome: join(root, 'home'), projectRoot: root, policy: 'plaintext_allowed' });
  await secretsManager.set(daemonSecretKeyFor('surfaces.email.password'), 'mail-app-password', { scope: 'user' });
  return new EmailService(withSurfaceEmailConfig({
    getConfig: (key) => configManager.get(key as ConfigKey),
    secretsManager,
    transport: nodeEmailTransport,
    describeSenderClaim: describeSenderClaimNeutrally,
    imapSocketFactory: async () => connectSocket(port),
  }));
}

test('a message marked deleted is expunged only once its copy is in the target folder, and a retried archive never copies it twice', async () => {
  const server = await mailServer();
  const mail = await mailService(server.port);

  // An archive whose connection is lost on the expunge: the copy landed, the original is marked; the retry finishes it.
  const interrupted = server.deliver('<interrupted@example.test>');
  server.script.dropOnExpunge = 1;
  expect(await mail.updateMessage(interrupted, 'archive', 42).then(() => 'archived', () => 'failed')).toBe('failed');
  expect(await mail.updateMessage(interrupted, 'archive', 42)).toMatchObject({ uid: interrupted, movedTo: 'Archive' });
  expect(server.holds('Archive').filter((id) => id === '<interrupted@example.test>')).toHaveLength(1);
  expect(server.holds('INBOX')).not.toContain('<interrupted@example.test>');

  // Marked deleted by another mail program, never copied: archiving or deleting it here changes nothing.
  const markedElsewhere = server.deliver('<marked-elsewhere@example.test>', ['\\Deleted']);
  for (const action of ['archive', 'delete'] as const) {
    expect(await mail.updateMessage(markedElsewhere, action, 42).then(() => 'moved', () => 'refused')).toBe('refused');
  }
  expect(server.holds('INBOX')).toContain('<marked-elsewhere@example.test>');
  expect([...server.holds('Archive'), ...server.holds('Trash')]).not.toContain('<marked-elsewhere@example.test>');
});
