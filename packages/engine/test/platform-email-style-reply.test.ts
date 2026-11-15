/**
 * Tests for the writing-style-matched draft reply composer.
 *
 * Recorded semantic answers run against the real protected loopback source owner. No external mail or provider service is contacted.
 *
 * The judgment answers here come from a per-body fact table, so the tone, greeting and
 * frequency cases prove the wiring from corpus to profile, not the reading itself; the reading
 * contract is covered in platform-email-style-readings.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { taskRouteSourceFixture } from './_helpers/task-route-source.ts';
import {
  testContainsSecretLikeText,
  testDescribeSenderClaim,
} from './_helpers/platform-email-fixtures.ts';
import type { EmailSummary } from '../platform/src/platform/email/email-service.ts';
import {
  composeDraftReply as nativeComposeDraftReply,
  extractSenderName as nativeExtractSenderName,
  extractStyleProfile as nativeExtractStyleProfile,
  replySubject,
  StyleReplyReadingError,
  type StyleProfile,
} from '../platform/src/platform/email/style-reply.ts';
import { STYLE_GREETINGS, STYLE_SIGN_OFFS } from '../platform/src/platform/email/style-reply-readings.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<EmailSummary> = {}): EmailSummary {
  return {
    uid: 1,
    messageId: '<test-message-1@example.com>',
    from: 'sender@example.com',
    subject: 'Test subject',
    date: '2024-01-01T10:00:00Z',
    unread: true,
    bodyPreview: '',
    mailbox: 'INBOX',
    deliveredTo: [],
    unverifiedToHeaderClaim: '',
    senderClaim: testDescribeSenderClaim('sender@example.com'),
    ...overrides,
  };
}


let source: ReturnType<typeof taskRouteSourceFixture>;
let prior: ReturnType<typeof installJudgmentPort>;
let styles: ReturnType<typeof recordedStyles>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected style fixture shape');
  return Object.fromEntries(Object.entries(value));
}
interface MessageFact { readonly body: string; readonly phrases: readonly string[]; readonly greeting: string; readonly signOff: string; readonly sentences: readonly string[]; readonly tone: StyleProfile['tone']; }
const facts: readonly MessageFact[] = [
  { body: 'Hello there', phrases: [], greeting: 'Hello', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'no punctuation here', phrases: [], greeting: '', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'First sentence. Second sentence. Third sentence.', phrases: [], greeting: '', signOff: '', sentences: ['First sentence.', 'Second sentence.', 'Third sentence.'], tone: 'neutral' },
  { body: 'Great! Sounds good! Talk soon.', phrases: [], greeting: '', signOff: '', sentences: ['Great!', 'Sounds good!', 'Talk soon.'], tone: 'casual' },
  { body: 'How are you? Are you free? Let me know.', phrases: [], greeting: '', signOff: '', sentences: ['How are you?', 'Are you free?', 'Let me know.'], tone: 'neutral' },
  { body: 'Hi there, hope you are well', phrases: ['Hi'], greeting: 'Hi', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'Hi Alice,', phrases: ['Hi'], greeting: 'Hi', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'Hello Bob,', phrases: ['Hello'], greeting: 'Hello', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'Good morning team', phrases: [], greeting: 'Good morning', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'HELLO everyone', phrases: ['Hello'], greeting: 'Hello', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'hello again', phrases: ['Hello'], greeting: 'Hello', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'Please kindly review the attached document.', phrases: [], greeting: '', signOff: '', sentences: ['Please kindly review the attached document.'], tone: 'formal' },
  { body: 'I am writing pursuant to our previous discussion.', phrases: [], greeting: '', signOff: '', sentences: ['I am writing pursuant to our previous discussion.'], tone: 'formal' },
  { body: 'Regards, sincerely yours.', phrases: [], greeting: '', signOff: 'Regards', sentences: [], tone: 'formal' },
  { body: 'Hey, sounds good! No worries about the delay.', phrases: [], greeting: 'Hey', signOff: '', sentences: ['Hey, sounds good!', 'No worries about the delay.'], tone: 'casual' },
  { body: 'Yeah, cheers! Chat soon.', phrases: [], greeting: '', signOff: '', sentences: ['Yeah, cheers!', 'Chat soon.'], tone: 'casual' },
  { body: 'Thank you for your time', phrases: [], greeting: '', signOff: '', sentences: ['Thank you for your time'], tone: 'neutral' },
  { body: 'Hey Bob,\nJust checking in.\nCheers', phrases: [], greeting: 'Hey', signOff: 'Cheers', sentences: ['Just checking in.'], tone: 'casual' },
  { body: 'Hey Carol,\nSounds good!\nCheers', phrases: [], greeting: 'Hey', signOff: 'Cheers', sentences: ['Sounds good!'], tone: 'casual' },
  { body: 'Hey Dave,\nLet me know.\nCheers', phrases: [], greeting: 'Hey', signOff: 'Cheers', sentences: ['Let me know.'], tone: 'casual' },
  { body: 'Dear Alice,\nPlease see the attached.\nKind regards', phrases: [], greeting: 'Dear', signOff: 'Kind regards', sentences: ['Please see the attached.'], tone: 'formal' },
  { body: 'Dear Bob,\nKindly review the document.\nKind regards', phrases: [], greeting: 'Dear', signOff: 'Kind regards', sentences: ['Kindly review the document.'], tone: 'formal' },
  { body: 'Hi,\nOne sentence.\nThanks', phrases: [], greeting: 'Hi', signOff: 'Thanks', sentences: ['One sentence.'], tone: 'neutral' },
  { body: 'Dear Ms Smith,\nPlease kindly review the enclosed document pursuant to our agreement.\nSincerely', phrases: [], greeting: 'Dear', signOff: 'Sincerely', sentences: ['Please kindly review the enclosed document pursuant to our agreement.'], tone: 'formal' },
];
const names = new Map<string, string>([
  ['Alice Smith <alice@example.com>', 'Alice'], ['"Carol Jones" <carol@example.com>', 'Carol'],
  ['bob@example.com', ''], ['dave@example.com', ''], ['noreply@example.com', ''],
]);
const optionFor = (table: Readonly<Record<string, string>>, text: string): string =>
  Object.entries(table).find(([, value]) => value === text)?.[0] ?? 'none';
/** One corpus-wide answer: every body of a test corpus shares its greeting, closing, tone and length. */
function corpusValue(bodies: readonly unknown[], read: (fact: MessageFact) => string): string {
  const values = bodies.map(body => read(messageFact(body)));
  const value = values[0];
  if (value === undefined || !values.every(entry => entry === value)) throw new Error('Unmapped exact corpus style');
  return value;
}
function messageFact(body: unknown): MessageFact {
  const fact = facts.find(fact => fact.body === body);
  if (!fact) throw new Error('Unmapped complete style fixture body');
  return fact;
}
function recordedStyles() {
  return fakePort((name, question, value) => {
    const state = object(value);
    if (Object.keys(state).join() === 'bodies' && Array.isArray(state.bodies) && question.type === 'choice') {
      const bodies = state.bodies;
      if (name === 'greeting') return choiceAnswer(question, corpusValue(bodies, fact => optionFor(STYLE_GREETINGS, fact.greeting)), 0.999);
      if (name === 'signOff') return choiceAnswer(question, corpusValue(bodies, fact => optionFor(STYLE_SIGN_OFFS, fact.signOff)), 0.999);
      if (name === 'tone') return choiceAnswer(question, corpusValue(bodies, fact => fact.tone), 0.999);
      if (name === 'length') return choiceAnswer(question, corpusValue(bodies, fact => fact.sentences.length <= 2 ? 'short' : fact.sentences.length <= 5 ? 'medium' : 'long'), 0.999);
    }
    if (Object.keys(state).join() === 'context,candidates,selectionFitInstructions'
      && typeof state.selectionFitInstructions === 'string' && Array.isArray(state.candidates)) {
      const from = object(state.context).from;
      if (typeof from !== 'string' || !names.has(from)) throw new Error('Unmapped complete From header');
      const expected = names.get(from);
      const candidates = state.candidates.map(object), selected = candidates.find(candidate => object(candidate.content).text === expected);
      const chosen = selected?.id ?? 'none';
      if (name === 'pick' && question.type === 'choice' && typeof chosen === 'string') return choiceAnswer(question, chosen, 0.999);
      if (/^fits_\d+$/.test(name) && question.type === 'noul') return noulAnswer(object(candidates[Number(name.slice(5))]).id === chosen ? 0.999 : 0.001);
    }
    throw new Error('Unknown complete style fixture request');
  });
}
beforeEach(() => { source = taskRouteSourceFixture(); styles = recordedStyles(); prior = installJudgmentPort(styles.port); });
afterEach(async () => { installJudgmentPort(prior); await source.close(); });
const options = () => ({ sourceOwner: source.owner });
const extractSenderName = (from: string) => nativeExtractSenderName(from, options());
const extractStyleProfile = (messages: readonly EmailSummary[]) => nativeExtractStyleProfile(messages, options());
const composeDraftReply = (inbound: EmailSummary, profile: StyleProfile, context: string, predicate: Parameters<typeof nativeComposeDraftReply>[3]) => nativeComposeDraftReply(inbound, profile, context, predicate, options());





// ---------------------------------------------------------------------------
// extractSenderName
// ---------------------------------------------------------------------------

describe('extractSenderName', () => {
  it('extracts display name from "Name <email>" form', async () => {
    expect(await extractSenderName('Alice Smith <alice@example.com>')).toBe('Alice');
  });

  it('does not invent a personal name from a bare email address', async () => {
    expect(await extractSenderName('bob@example.com')).toBe('');
  });

  it('returns empty string when from is empty', async () => {
    expect(await extractSenderName('')).toBe('');
  });

  it('handles quoted display name', async () => {
    expect(await extractSenderName('"Carol Jones" <carol@example.com>')).toBe('Carol');
  });

  it('requires an explicit displayed personal name', async () => {
    expect(await extractSenderName('dave@example.com')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// replySubject
// ---------------------------------------------------------------------------

describe('replySubject', () => {
  it('prepends Re: when subject does not have it',  () => {
    expect(replySubject('Project update')).toBe('Re: Project update');
  });

  it('does not double-prefix when subject already starts with Re:',  () => {
    expect(replySubject('Re: Project update')).toBe('Re: Project update');
  });

  it('is case-insensitive for Re: prefix detection',  () => {
    expect(replySubject('RE: Important')).toBe('RE: Important');
  });

  it('trims leading/trailing whitespace before checking prefix',  () => {
    const result = replySubject('  Hello  ');
    expect(result).toBe('Re: Hello');
  });
});

// ---------------------------------------------------------------------------
// extractStyleProfile, empty corpus
// ---------------------------------------------------------------------------

describe('extractStyleProfile: empty corpus', () => {
  it('returns default profile when corpus is empty', async () => {
    const profile = await extractStyleProfile([]);
    expect(profile.isDefault).toBe(true);
    expect(profile.greeting).toBe('Hi');
    expect(profile.signOff).toBe('Thanks');
    expect(profile.medianSentenceCount).toBeGreaterThanOrEqual(1);
    expect(['formal', 'casual', 'neutral']).toContain(profile.tone);
  });
});

// ---------------------------------------------------------------------------
// extractStyleProfile, corpus with bodies
// ---------------------------------------------------------------------------

describe('extractStyleProfile: corpus with bodies', () => {
  it('detects casual greeting from corpus', async () => {
    const sent = [
      makeSummary({ bodyPreview: 'Hey Bob,\nJust checking in.\nCheers' }),
      makeSummary({ bodyPreview: 'Hey Carol,\nSounds good!\nCheers' }),
      makeSummary({ bodyPreview: 'Hey Dave,\nLet me know.\nCheers' }),
    ];
    const profile = await extractStyleProfile(sent);
    expect(profile.greeting).toBe('Hey');
    expect(profile.isDefault).toBe(false);
  });

  it('detects formal sign-off from corpus', async () => {
    const sent = [
      makeSummary({ bodyPreview: 'Dear Alice,\nPlease see the attached.\nKind regards' }),
      makeSummary({ bodyPreview: 'Dear Bob,\nKindly review the document.\nKind regards' }),
    ];
    const profile = await extractStyleProfile(sent);
    expect(profile.signOff).toBe('Kind regards');
  });

  it('sets medianSentenceCount >= 1', async () => {
    const sent = [
      makeSummary({ bodyPreview: 'Hi,\nOne sentence.\nThanks' }),
    ];
    const profile = await extractStyleProfile(sent);
    expect(profile.medianSentenceCount).toBeGreaterThanOrEqual(1);
  });

  it('classifies formal tone correctly', async () => {
    const sent = [
      makeSummary({
        bodyPreview:
          'Dear Ms Smith,\nPlease kindly review the enclosed document pursuant to our agreement.\nSincerely',
      }),
    ];
    const profile = await extractStyleProfile(sent);
    expect(profile.tone).toBe('formal');
  });

  it('sent messages with empty bodyPreview give the default profile and ask the judgment port nothing', async () => {
    const sent = [
      makeSummary({ bodyPreview: '' }),
      makeSummary({ bodyPreview: '' }),
    ];
    const profile = await extractStyleProfile(sent);
    // No readable text means nothing was learned, so the values are the defaults and say so.
    expect(profile).toEqual({ greeting: 'Hi', signOff: 'Thanks', medianSentenceCount: 3, tone: 'neutral', isDefault: true });
    expect(styles.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// composeDraftReply
// ---------------------------------------------------------------------------

describe('composeDraftReply', () => {
  const inbound = makeSummary({
    from: 'Alice Smith <alice@example.com>',
    subject: 'Project update',
    bodyPreview: 'Hi, just checking in on the project status...',
  });
  const defaultProfile: StyleProfile = { greeting: 'Hi', signOff: 'Thanks', medianSentenceCount: 3, tone: 'neutral', isDefault: true };

  it('returns a draft with requiresBeforeSendReview = true', async () => {
    const result = await composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.requiresBeforeSendReview).toBe(true);
  });

  it('subject is prefixed with Re:', async () => {
    const result = await composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.subject).toMatch(/^Re:/i);
  });

  it('body includes greeting and sign-off', async () => {
    const result = await composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.body).toContain(defaultProfile.greeting);
    expect(result.body).toContain(defaultProfile.signOff);
  });

  it('body includes extracted sender first name', async () => {
    const result = await composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.body).toContain('Alice');
  });

  it('weaves context into the draft body', async () => {
    const result = await composeDraftReply(
      inbound,
      defaultProfile,
      'The milestone is on track and details follow Friday.',
      testContainsSecretLikeText,
    );
    expect(result.body).toContain('The milestone is on track');
  });

  it('reviewBoundary mentions confirm:true', async () => {
    const result = await composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.reviewBoundary).toContain('confirm:true');
  });

  it('returns the profile used', async () => {
    const result = await composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.profile).toEqual(defaultProfile);
    expect(result.profile).not.toBe(defaultProfile);
  });

  it('throws when context contains secret-like text', async () => {
    await expect(composeDraftReply(inbound, defaultProfile, 'token: abc123secretpassword', testContainsSecretLikeText)).rejects.toBeInstanceOf(StyleReplyReadingError);
  });

  it('is deterministic: same inputs produce identical output', async () => {
    const a = await composeDraftReply(inbound, defaultProfile, 'some context', testContainsSecretLikeText);
    const b = await composeDraftReply(inbound, defaultProfile, 'some context', testContainsSecretLikeText);
    expect(a.body).toBe(b.body);
    expect(a.subject).toBe(b.subject);
  });

  it('body does not contain secret-like text for normal inputs', async () => {
    const result = await composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    // Composition runs the secret check on its own output, so reaching here means it passed;
    // the assertion is that the composed text is clean by the same predicate.
    expect(testContainsSecretLikeText(result.body)).toBe(false);
    expect(result.body.length).toBeGreaterThan(defaultProfile.greeting.length);
  });

  it('handles inbound with no sender name gracefully', async () => {
    const noName = makeSummary({ from: 'noreply@example.com', subject: 'Alert' });
    const result = await composeDraftReply(noName, defaultProfile, '', testContainsSecretLikeText);
    expect(result.body).toBeTruthy();
    expect(result.requiresBeforeSendReview).toBe(true);
  });
});




