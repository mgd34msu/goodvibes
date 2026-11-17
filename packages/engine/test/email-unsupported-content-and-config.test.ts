/**
 * A mail configuration the resolver cannot honour must be refused when it is
 * read, not when the mailbox fails to connect; charsets and SEARCH answers the
 * strict reader must take.
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
