/**
 * Mail the strict reader cannot prove complete must not hold every later
 * message back, and a mail configuration the resolver cannot honour must be
 * refused when it is read, not when the mailbox fails to connect.
 */
import { describe, expect, test } from 'bun:test';
import {
  EmailCredentialUnavailableError,
  readEmailConfig,
  resolveEmailPassword,
  validateEmailConfig,
  validateEmailInboxConfig,
} from '../platform/src/platform/email/email-config.ts';
import { completeSearchUids } from '../platform/src/platform/email/imap-fetch-complete.ts';
import { decodeCompleteTextPart, parseCompleteBodyStructure } from '../platform/src/platform/email/imap-bodystructure-complete.ts';
import { decodeTextPart, parseBodyStructure } from '../platform/src/platform/email/imap-bodystructure.ts';
import type { ImapUidCheckpoint } from '../platform/src/platform/intake/provider-adapter.ts';
import type { EmailInboxPageRead } from '../platform/src/platform/email/email-inbox-page.ts';
import { SnapshotSocket, snapshotFixture } from './_helpers/mail-inbox-snapshot.ts';

const baseConfig = (overrides: Record<string, unknown> = {}) => readEmailConfig((key) => ({
  'email.enabled': true, 'email.imapHost': 'imap.example.test', 'email.smtpHost': 'smtp.example.test',
  'email.username': 'me@example.test', 'email.fromAddress': 'me@example.test',
  'email.passwordRef': 'goodvibes://secrets/goodvibes/MAIL_PASSWORD', ...overrides,
})[key]);

describe('email credential references', () => {
  test('a reference form the resolver cannot read is refused at validation, naming the form it accepts', () => {
    const errors = validateEmailInboxConfig(baseConfig({ 'email.passwordRef': 'goodvibes://secrets/env/MAIL_PASSWORD' }));
    expect(errors.join(' ')).toContain('goodvibes://secrets/goodvibes/<key>');
  });

  test('a malformed % escape is a validation error and a terminal credential failure, not a bare URIError', async () => {
    const ref = 'goodvibes://secrets/goodvibes/a%zz';
    expect(validateEmailInboxConfig(baseConfig({ 'email.passwordRef': ref })).join(' ')).toContain('malformed % escape');
    const failure = await resolveEmailPassword(ref, { get: async () => 'x' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EmailCredentialUnavailableError);
    expect((failure as EmailCredentialUnavailableError).notice.terminal).toBe(true);
  });

  test('a reference of another form is refused by the resolver instead of being looked up as a key', async () => {
    const asked: string[] = [];
    const failure = await resolveEmailPassword('goodvibes://secrets/env/MAIL_PASSWORD', { get: async (key) => { asked.push(key); return 'x'; } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EmailCredentialUnavailableError);
    expect(asked).toEqual([]);
  });

  test('a reference to a key that is not about mail is refused, so an unrelated secret is never sent to a mail host', async () => {
    const ref = 'goodvibes://secrets/goodvibes/ANTHROPIC_API_KEY';
    const asked: string[] = [];
    expect(validateEmailInboxConfig(baseConfig({ 'email.passwordRef': ref })).join(' ')).toContain('not a mail credential');
    expect(validateEmailConfig(baseConfig({ 'email.smtpPasswordRef': ref })).join(' ')).toContain('not a mail credential');
    const failure = await resolveEmailPassword(ref, { get: async (key) => { asked.push(key); return 'provider-secret'; } }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EmailCredentialUnavailableError);
    expect(asked).toEqual([]);
    // 'MAILGUN' is a different word from 'MAIL', so a lookalike provider key stays refused.
    expect(validateEmailInboxConfig(baseConfig({ 'email.passwordRef': 'goodvibes://secrets/goodvibes/MAILGUN_API_KEY' })).join(' ')).toContain('not a mail credential');
    expect(validateEmailInboxConfig(baseConfig({ 'email.passwordRef': 'goodvibes://secrets/goodvibes/GOODVIBES_EMAIL_PASSWORD' }))).toEqual([]);
  });

  test('a key reference still resolves', async () => {
    expect(await resolveEmailPassword('goodvibes://secrets/goodvibes/MAIL_PASS%20WORD', { get: async (key) => (key === 'MAIL_PASS WORD' ? 'pw' : null) })).toBe('pw');
  });

  test('plaintext IMAP is refused for a remote host and allowed on loopback', () => {
    expect(validateEmailConfig(baseConfig({ 'email.imapSecurity': 'plaintext' })).join(' ')).toContain('loopback');
    expect(validateEmailConfig(baseConfig({ 'email.imapSecurity': 'plaintext', 'email.imapHost': '127.0.0.1' }))).toEqual([]);
    expect(validateEmailConfig(baseConfig({ 'email.imapSecurity': 'plaintext', 'email.imapHost': 'localhost' }))).toEqual([]);
    expect(validateEmailConfig(baseConfig({ 'email.imapSecurity': 'tls' }))).toEqual([]);
  });
  test('a hostname that merely starts with 127. is not loopback', () => {
    for (const host of ['127.attacker.example', '127.0.0.1.evil.test', '127.1']) {
      expect(validateEmailConfig(baseConfig({ 'email.imapSecurity': 'plaintext', 'email.imapHost': host })).join(' ')).toContain('loopback');
    }
  });
});

describe('UID SEARCH answers', () => {
  const frame = (syntax: string) => ({ syntax });
  test('unsolicited untagged status lines around the answer do not make it unreadable', () => {
    expect(completeSearchUids([frame('* 5 EXISTS'), frame('* SEARCH 1 2'), frame('A1 OK done')])).toEqual([1, 2]);
  });
  test('other legal unsolicited lines (FETCH from another client, VANISHED, CAPABILITY) are ignored', () => {
    expect(completeSearchUids([frame('* 3 FETCH (FLAGS (\\Seen))'), frame('* SEARCH 1'), frame('A1 OK done')])).toEqual([1]);
    expect(completeSearchUids([frame('* VANISHED 4'), frame('* CAPABILITY IMAP4rev1'), frame('* SEARCH 2'), frame('A1 OK done')])).toEqual([2]);
  });
  test('no SEARCH line, or two of them, is still refused', () => {
    expect(() => completeSearchUids([frame('* 5 EXISTS'), frame('A1 OK done')])).toThrow();
    expect(() => completeSearchUids([frame('* SEARCH 1'), frame('* SEARCH 2'), frame('A1 OK done')])).toThrow();
  });
});

describe('charsets beyond the built-in ones', () => {
  const shiftJisBase64 = Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]).toString('base64');
  const structure = (encoding: string, charset: string) =>
    `("TEXT" "PLAIN" ("CHARSET" "${charset}") NIL NIL "${encoding}" ${shiftJisBase64.length} 1)`;

  test('the compatibility reader decodes a base64 shift_jis section instead of showing replacement characters', () => {
    expect(decodeTextPart(shiftJisBase64, 'base64', 'shift_jis')).toBe('こんにちは');
  });

  test('the strict reader decodes the same section from base64 and refuses an 8-bit body in that charset', () => {
    const part = parseBodyStructure(structure('BASE64', 'shift_jis'))[0]!;
    expect(decodeCompleteTextPart(shiftJisBase64, part)).toBe('こんにちは');
    const eightBit = parseBodyStructure(structure('8BIT', 'shift_jis'))[0]!;
    expect(decodeCompleteTextPart(shiftJisBase64, eightBit)).toBeNull();
    expect(parseCompleteBodyStructure(structure('8BIT', 'shift_jis'))).toBeNull();
    expect(parseCompleteBodyStructure(structure('BASE64', 'shift_jis'))).not.toBeNull();
  });
});

describe('one unsupported message does not block the inbox', () => {
  const checkpoint = (lastTerminalUid: number | null = null): ImapUidCheckpoint => ({ kind: 'imap-uid',
    uidValidity: 7, lastTerminalUid, history: { kind: 'complete', lowerBoundUid: 1, skippedOlderMessages: 0 } });
  // A body in a charset this runtime has no decoder for: the message's own bytes cannot be shown here.
  const SIGNED = '("TEXT" "PLAIN" ("CHARSET" "X-UNKNOWN-CHARSET") NIL NIL "BASE64" 8 1)';

  class SignedFirstSocket extends SnapshotSocket {
    override async answer(command: string): Promise<void> {
      const uid = Number(/UID FETCH (\d+)/.exec(command)?.[1]);
      if (uid === 1 && command.includes('BODYSTRUCTURE')) {
        this.feed(`* 1 FETCH (UID 1 BODYSTRUCTURE ${SIGNED})\r\n${command.split(' ')[0]} OK complete\r\n`);
        return;
      }
      await super.answer(command);
    }
  }
  const complete = (result: EmailInboxPageRead) => {
    expect(result.outcome).toBe('complete');
    if (result.outcome !== 'complete') throw new Error('Expected a complete page.');
    return result;
  };

  test('a message this reader cannot show is stepped over and reported; the next message is delivered and the checkpoint moves past both', async () => {
    const sockets = [new SignedFirstSocket({ uids: [1, 2] }), new SignedFirstSocket({ uids: [1, 2] })];
    const f = snapshotFixture({ sockets });
    const page = complete(await f.service.readInboxPage({ checkpoint: checkpoint(), limit: 2 }));
    expect(page.messages.map((message) => message.source.detail.uid)).toEqual([2]);
    expect(page.coveredUids).toEqual([2]);
    expect(page.unsupported).toMatchObject([{ uid: 1, reason: 'bodystructure-incomplete-or-unsupported' }]);
    expect(page.pending).toBe(1);
    // The next poll starts after the delivered UID and finds nothing stuck.
    const next = complete(await f.service.readInboxPage({ checkpoint: checkpoint(2), limit: 2 }));
    expect(next.messages).toEqual([]);
    expect(next.pending).toBe(0);
  });

  class AllSignedSocket extends SnapshotSocket {
    override async answer(command: string): Promise<void> {
      const uid = /UID FETCH (\d+)/.exec(command)?.[1];
      if (uid !== undefined && command.includes('BODYSTRUCTURE')) {
        this.feed(`* 1 FETCH (UID ${uid} BODYSTRUCTURE ${SIGNED})\r\n${command.split(' ')[0]} OK complete\r\n`);
        return;
      }
      await super.answer(command);
    }
  }

  test('a run of unsupported messages longer than one page examines at most 50 and leaves the rest pending', async () => {
    const uids = Array.from({ length: 60 }, (_, index) => index + 1);
    const f = snapshotFixture({ sockets: [new AllSignedSocket({ uids })] });
    const page = complete(await f.service.readInboxPage({ checkpoint: checkpoint(), limit: 2 }));
    expect(page.coveredUids).toEqual([]);
    expect(page.unsupported?.map((entry) => entry.uid)).toEqual(uids.slice(0, 50));
    expect(page.selectedUids).toEqual(uids.slice(0, 50));
    expect(page.hasMore).toBe(true);
  });

  test('an unsupported message after the last readable one stays pending rather than being passed', async () => {
    const f = snapshotFixture({ sockets: [new SignedFirstSocket({ uids: [1] })] });
    const page = complete(await f.service.readInboxPage({ checkpoint: checkpoint(), limit: 2 }));
    expect(page.coveredUids).toEqual([]);
    expect(page.unsupported?.map((entry) => entry.uid)).toEqual([1]);
    expect(page.pending).toBe(1);
  });
});
