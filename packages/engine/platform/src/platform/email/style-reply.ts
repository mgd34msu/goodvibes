/** Protected semantic style extraction and draft-only reply composition. */
import { replySubjectLine } from '../judgment-browser/batteries/reply-subject-marker.js';
import type { SecretLikeTextPredicate } from '../google/account-registry.js';
import type { EmailSummary } from './email-service.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { isClassicOperation } from '../runtime/decision-policy.js';
import { readStyleProfile, readStyleSenderName, StyleReplyReadingError, withEmailStyleSource, type StyleReplyReadingOptions } from './style-reply-readings.js';
export { StyleReplyReadingError } from './style-reply-readings.js';
export type { StyleReplyReadingOptions } from './style-reply-readings.js';

// ---------------------------------------------------------------------------
// Style profile
// ---------------------------------------------------------------------------

export type StyleReplyMessage = Pick<EmailSummary, 'from' | 'subject' | 'bodyPreview'>;
export type StyleSentMessage = Pick<EmailSummary, 'bodyPreview'>;

export interface StyleProfile {
  readonly provenance?: 'classic';
  /** Defaults without a decision model are a template choice, never a learned writing style. */
  readonly assessment?: 'not-evaluated';
  /** Most common greeting prefix found in sent messages, e.g. 'Hi', 'Hello', 'Hey'. */
  readonly greeting: string;
  /** Most common sign-off found in sent messages, e.g. 'Thanks', 'Best', 'Cheers'. */
  readonly signOff: string;
  /** Typical sentence count of a sent message (whole number, ≥1). */
  readonly medianSentenceCount: number;
  /** Dominant tone established by the corpus reading: 'formal' | 'casual' | 'neutral'. */
  readonly tone: 'formal' | 'casual' | 'neutral';
  /** True when values are explicit defaults, including an unassessed default template. */
  readonly isDefault: boolean;
  /**
   * Fields of a corpus-derived profile the reading did not establish (the sent
   * messages showed none, or the reading was unsure), so they hold the template
   * value rather than a learned one. Absent when every field was read.
   */
  readonly templateFields?: readonly ('greeting' | 'signOff' | 'medianSentenceCount' | 'tone')[];
}

export const DEFAULT_STYLE_PROFILE: StyleProfile = Object.freeze({ greeting: 'Hi', signOff: 'Thanks', medianSentenceCount: 3, tone: 'neutral', isDefault: true });

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requireSentMessages(value: unknown): void {
  if (!Array.isArray(value) || !value.every(item => record(item) && typeof item.bodyPreview === 'string')) throw new StyleReplyReadingError();
}
function requireDraftInput(inbound: unknown, profile: unknown, context: unknown): void {
  if (!record(inbound) || typeof inbound.from !== 'string' || typeof inbound.subject !== 'string' || typeof inbound.bodyPreview !== 'string'
    || !record(profile) || typeof profile.greeting !== 'string' || typeof profile.signOff !== 'string'
    || typeof profile.medianSentenceCount !== 'number' || !Number.isSafeInteger(profile.medianSentenceCount) || profile.medianSentenceCount < 1
    || (profile.tone !== 'formal' && profile.tone !== 'casual' && profile.tone !== 'neutral') || typeof profile.isDefault !== 'boolean'
    || typeof context !== 'string') throw new StyleReplyReadingError();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read supplied sent messages in one request over the whole corpus; an actually
 * empty corpus has explicit defaults. A part the reading does not establish keeps
 * its template value and is named in `templateFields`; the profile is never refused for it.
 */
export async function extractStyleProfile(sentMessages: readonly StyleSentMessage[], options: StyleReplyReadingOptions = {}): Promise<StyleProfile> {
  return withEmailStyleSource({ sentMessages }, options, source => { requireSentMessages(source.sentMessages); return source.sentMessages.length > 0; }, async (source, readings) => {
    if (isClassicOperation()) return { ...DEFAULT_STYLE_PROFILE, provenance: 'classic' as const, assessment: 'not-evaluated' as const };
    const bodies = source.sentMessages.map(message => message.bodyPreview).filter(body => body.length > 0);
    if (!bodies.length) return { greeting: 'Hi', signOff: 'Thanks', medianSentenceCount: 3, tone: 'neutral', isDefault: true };
    if (!readings) throw new StyleReplyReadingError();
    const read = await readStyleProfile(bodies, readings);
    const templateFields: Array<'greeting' | 'signOff' | 'medianSentenceCount' | 'tone'> = [];
    if (read.greeting === null) templateFields.push('greeting');
    if (read.signOff === null) templateFields.push('signOff');
    if (read.medianSentenceCount === null) templateFields.push('medianSentenceCount');
    if (read.tone === null) templateFields.push('tone');
    return {
      greeting: read.greeting ?? DEFAULT_STYLE_PROFILE.greeting,
      signOff: read.signOff ?? DEFAULT_STYLE_PROFILE.signOff,
      medianSentenceCount: read.medianSentenceCount ?? DEFAULT_STYLE_PROFILE.medianSentenceCount,
      tone: read.tone ?? DEFAULT_STYLE_PROFILE.tone,
      isDefault: false,
      ...(templateFields.length > 0 ? { templateFields } : {}),
    };
  }, undefined, true);
}

export interface DraftReplyResult {
  readonly provenance?: 'classic';
  readonly styleAssessment?: 'not-evaluated';
  /** Fully composed draft body. Never includes credentials or secret-looking text. */
  readonly body: string;
  /** The style profile used to compose this draft. */
  readonly profile: StyleProfile;
  /** Subject line for the reply, prefixed with 'Re: ' if not already. */
  readonly subject: string;
  /** BEFORE-SEND REVIEW BOUNDARY: always true, this is a draft, never auto-sent. */
  readonly requiresBeforeSendReview: true;
  /** Human-readable reminder of the review boundary. */
  readonly reviewBoundary: string;
}

/** Compose a draft after protected name reading. This function has no delivery port. */
export async function composeDraftReply(
  inbound: StyleReplyMessage,
  profile: StyleProfile,
  context: string,
  containsSecretLikeText: SecretLikeTextPredicate,
  options: StyleReplyReadingOptions = {},
): Promise<DraftReplyResult> {
  return withEmailStyleSource({ inbound, profile, context }, options, source => { requireDraftInput(source.inbound, source.profile, source.context); return true; }, async (source, readings) => {
    const classic = isClassicOperation();
    const senderName = !classic && source.inbound.from.trim()
      ? await (readings ? readStyleSenderName(source.inbound.from, readings) : Promise.reject(new StyleReplyReadingError())) : '';
    const subjectLine = replySubject(source.inbound.subject);
    const usedInbound = source.inbound;
    const usedContext = source.context;
    const usedProfile = source.profile;

    // Build body paragraphs scaled to the author's typical message length,
    // which controls only the fixed placeholder length.
    const lines: string[] = [];

    // Greeting
    lines.push(`${usedProfile.greeting}${senderName ? ` ${senderName}` : ''},`);
    lines.push('');

    // Acknowledgement sentence
    const acknowledgement = buildAcknowledgement(usedInbound, usedProfile.tone);
    lines.push(acknowledgement);

    // User-supplied context woven in as a separate paragraph
    if (usedContext.trim()) {
      lines.push('');
      lines.push(usedContext.trim());
    }

    // Filler sentences to approximate the typical length (when no context provided
    // and the profile expects more sentences than the acknowledgement alone)
    if (!classic && !usedContext.trim() && usedProfile.medianSentenceCount > 2) {
      lines.push('');
      lines.push(buildPlaceholderBody(usedProfile.medianSentenceCount - 1, usedProfile.tone));
    }

    // Sign-off
    lines.push('');
    lines.push(`${usedProfile.signOff},`);

    const body = lines.join('\n');

    assertJudgmentInput({ body, subject: subjectLine, profile: usedProfile });
    // Assert no secret-like text in the composed output
    if (containsSecretLikeText(body)) {
      throw new StyleReplyReadingError();
    }

    readings?.assertCurrent();
    // Profiles can arrive from a caller, so only the known field names are echoed.
    const templateFields = (Array.isArray(usedProfile.templateFields) ? usedProfile.templateFields : [])
      .filter(field => field === 'greeting' || field === 'signOff' || field === 'medianSentenceCount' || field === 'tone');
    return {
      ...(classic ? { provenance: 'classic' as const, styleAssessment: 'not-evaluated' as const } : {}),
      body,
      profile: usedProfile,
      subject: subjectLine,
      requiresBeforeSendReview: true,
      reviewBoundary:
        (classic ? 'Without a decision model, this uses the supplied/default template; writing style and personal salutation were not inferred. ' : '') +
        (templateFields.length
          ? `The ${templateFields.join(', ')} in this draft are template defaults: the sent messages did not establish them, so they are not the author's own style. `
          : '') +
        'This is a DRAFT only. Review the content before sending. ' +
        'Sending requires confirm:true on the email send path (SMTP or connector) ' +
        'with explicit user confirmation of recipients and body.',
    };
  }, source => {
    const visit = (value: unknown): void => {
      if (typeof value === 'string' && containsSecretLikeText(value)) throw new StyleReplyReadingError();
      if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child);
    };
    visit(source);
  }, true);
}

// ---------------------------------------------------------------------------
// Internal composition helpers
// ---------------------------------------------------------------------------

/** Select an exact supported personal-name span; bare local parts do not establish names. */
export async function extractSenderName(from: string, options: StyleReplyReadingOptions = {}): Promise<string> {
  return withEmailStyleSource({ from }, options, source => { if (typeof source.from !== 'string') throw new StyleReplyReadingError(); return Boolean(source.from.trim()); }, async (source, readings) => {
    if (!source.from.trim()) return '';
    if (!readings) throw new StyleReplyReadingError();
    return readStyleSenderName(source.from, readings);
  });
}

/** The reply's subject: unchanged when it already marks a reply (in any common language), else "Re: " in front. */
export function replySubject(subject: string): string {
  return replySubjectLine(subject);
}

/** Build a natural acknowledgement sentence adapted to tone. */
function buildAcknowledgement(inbound: StyleReplyMessage, tone: StyleProfile['tone']): string {
  const subject = inbound.subject.trim();
  switch (tone) {
    case 'formal':
      return subject
        ? `Thank you for your message regarding "${subject}".`
        : 'Thank you for reaching out.';
    case 'casual':
      return subject
        ? `Thanks for your message about "${subject}"!`
        : 'Thanks for reaching out!';
    default:
      return subject
        ? `Thanks for your message about "${subject}".`
        : 'Thanks for reaching out.';
  }
}

/**
 * Build placeholder body sentences to approximate target sentence count.
 * Returns one paragraph with `targetCount` filler sentences.
 * Deterministic, no randomness.
 */
function buildPlaceholderBody(targetCount: number, tone: StyleProfile['tone']): string {
  const formalSentences = [
    'I have reviewed the relevant details and will follow up accordingly.',
    'Please let me know if you require any further information.',
    'I will ensure this is addressed in a timely manner.',
    'Kindly advise if you would like to discuss this further.',
  ];
  const casualSentences = [
    'Let me know if you have any questions.',
    'Happy to chat more about this if helpful.',
    'Feel free to reach out if anything else comes up.',
    'Let me know what works best for you.',
  ];
  const neutralSentences = [
    'Let me know if you need anything else.',
    'Happy to discuss further if useful.',
    'Please let me know if you have any questions.',
    'Looking forward to hearing from you.',
  ];

  const pool = tone === 'formal' ? formalSentences : tone === 'casual' ? casualSentences : neutralSentences;
  // Take up to targetCount sentences from the pool (cycle if needed)
  const sentences: string[] = [];
  for (let i = 0; i < Math.min(targetCount, 4); i++) {
    sentences.push(pool[i % pool.length]!);
  }
  return sentences.join(' ');
}
