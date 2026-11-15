import { afterEach, describe, test, expect, mock } from 'bun:test';
import {
  readUserFacingError,
  readUserFacingErrorLine,
  type ErrorClass,
} from '../../core/format-user-error.ts';
import { installUserErrorReading } from '../helpers/user-error-reading.ts';
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
const reading = (kind: ErrorClass, sessionEnded = false, states?: string[]) => { restore?.(); restore = installUserErrorReading(kind, sessionEnded, states); };

import { SystemMessageRouter, createSystemMessageRouter } from '../../core/system-message-router.ts';
import type { ConversationManager } from '../../core/conversation';
import type { SystemMessageKind, SystemMessageTarget } from '../../core/system-message-router.ts';

// ---------------------------------------------------------------------------
// Classifier table
// ---------------------------------------------------------------------------

type ClassifyCase = { label: string; err: unknown; expected: ErrorClass };

const classifyCases: ClassifyCase[] = [
  // --- auth ---
  { label: 'status 401', err: { status: 401, message: 'Unauthorized' }, expected: 'auth' },
  { label: 'statusCode 401', err: { statusCode: 401, message: 'permission denied' }, expected: 'auth' },
  { label: 'invalid api key message', err: new Error('Invalid API key provided'), expected: 'auth' },
  { label: 'invalid key (variant)', err: new Error('invalid key: check your credentials'), expected: 'auth' },
  { label: 'Unauthorized string', err: 'Unauthorized', expected: 'auth' },
  { label: 'authentication failed message', err: new Error('authentication failed'), expected: 'auth' },

  // --- rate-limit ---
  { label: 'status 429', err: { status: 429, message: 'Too Many Requests' }, expected: 'rate-limit' },
  { label: 'rate_limit message', err: new Error('rate_limit exceeded'), expected: 'rate-limit' },
  { label: 'rate limit (spaced)', err: new Error('rate limit reached for this model'), expected: 'rate-limit' },
  { label: 'quota exceeded', err: new Error('quota exceeded for this billing period'), expected: 'rate-limit' },

  // --- context-overflow ---
  { label: 'context length', err: new Error('This model\'s maximum context length is 128000 tokens'), expected: 'context-overflow' },
  { label: 'context window', err: new Error('context window exceeded'), expected: 'context-overflow' },
  { label: 'too many tokens', err: new Error('too many tokens in conversation'), expected: 'context-overflow' },
  { label: 'input too long', err: new Error('input is too long for this model'), expected: 'context-overflow' },

  // --- network ---
  { label: 'ECONNREFUSED code', err: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }), expected: 'network' },
  { label: 'ETIMEDOUT', err: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), expected: 'network' },
  { label: 'fetch failed', err: new Error('fetch failed'), expected: 'network' },
  { label: 'socket hang up', err: new Error('socket hang up'), expected: 'network' },
  { label: 'connection refused', err: new Error('connection refused by remote host'), expected: 'network' },
  { label: 'network timeout', err: new Error('network timeout after 30s'), expected: 'network' },

  // --- generic fallback ---
  { label: 'unknown error object', err: new Error('some unknown provider failure'), expected: 'generic' },
  { label: 'plain string', err: 'something went wrong', expected: 'generic' },
  { label: 'null', err: null, expected: 'generic' },
  { label: 'undefined', err: undefined, expected: 'generic' },
];

// The fake reader answers with the class it is given, whatever the error is, so this
// table pins only how a reading maps to a kind. What the reader is shown is pinned below.
describe('reading to kind mapping', () => {
  for (const { label, err, expected } of classifyCases) {
    test(`a reading of ${expected} yields ${expected}: ${label}`, async () => {
      reading(expected);
      expect((await readUserFacingError(err)).kind).toBe(expected);
    });
  }
});

describe('evidence shown to the reader', () => {
  const shown = async (err: unknown): Promise<string[]> => {
    const states: string[] = [];
    reading('generic', false, states);
    await readUserFacingError(err);
    return states;
  };

  test('the HTTP status and message of a 401 reach the reader', async () => {
    const states = await shown({ status: 401, message: 'Unauthorized' });
    expect(states).toHaveLength(1);
    expect(states[0]).toContain('HTTP status: 401');
    expect(states[0]).toContain('Message: Unauthorized');
  });

  test('an errno code settles the class from structure alone, without asking the reader', async () => {
    const states: string[] = [];
    reading('generic', false, states);
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
    expect((await readUserFacingError(err)).kind).toBe('network');
    expect(states).toEqual([]);
  });

  test('a 429 status settles the class from structure alone, without asking the reader', async () => {
    const states: string[] = [];
    reading('generic', false, states);
    expect((await readUserFacingError({ status: 429, message: 'Too Many Requests' })).kind).toBe('rate-limit');
    expect(states).toEqual([]);
  });

  test('a plain-string error reaches the reader as its message', async () => {
    const states = await shown('too many tokens in conversation');
    expect(states).toHaveLength(1);
    expect(states[0]).toContain('Message: too many tokens in conversation');
  });
});

// ---------------------------------------------------------------------------
// readUserFacingError, verify messages and actions per class
// ---------------------------------------------------------------------------

describe('readUserFacingError', () => {
  test('auth error has /login action', async () => {
    reading('auth');
    const result = await readUserFacingError({ status: 401, message: 'Unauthorized' });
    expect(result.kind).toBe('auth');
    expect(result.message).toContain('Authentication failed');
    expect(result.action).toContain('/login');
  });

  test('a dead subscription session is named as such, never as an API key problem', async () => {
    reading('auth', true);
    // The exact failure that shipped: the platform's subscription provider says
    // "subscription session has ended", and the fixed API-key wording told a
    // logged-in subscriber their subscription was not there.
    const result = await readUserFacingError(new Error(
      'Your OpenAI subscription session has ended and could not be refreshed. Sign in to OpenAI again to keep using the subscription.',
    ));
    expect(result.kind).toBe('auth');
    expect(result.message).toMatch(/subscription session has ended/i);
    expect(result.message).not.toMatch(/api key/i);
    expect(result.action).toContain('/login');
  });

  test('rate-limit error has /model action', async () => {
    reading('rate-limit');
    const result = await readUserFacingError({ status: 429, message: 'Too Many Requests' });
    expect(result.kind).toBe('rate-limit');
    expect(result.action).toContain('/model');
  });

  test('context-overflow error has /compact action', async () => {
    reading('context-overflow');
    const result = await readUserFacingError(new Error('context window exceeded'));
    expect(result.kind).toBe('context-overflow');
    expect(result.action).toContain('/compact');
  });

  test('network error has /model action', async () => {
    reading('network');
    const result = await readUserFacingError(new Error('fetch failed'));
    expect(result.kind).toBe('network');
    expect(result.action).toContain('/model');
  });

  test('generic error uses summarizeError fallback and has /model action', async () => {
    reading('generic');
    const result = await readUserFacingError(new Error('some unknown thing'));
    expect(result.kind).toBe('generic');
    expect(result.message).toMatch(/provider error/i);
    expect(result.action).toContain('/model');
  });

  test('readUserFacingErrorLine returns message + action concatenated', async () => {
    reading('network');
    const line = await readUserFacingErrorLine(new Error('socket hang up'));
    expect(typeof line).toBe('string');
    expect(line.length).toBeGreaterThan(0);
    // Should contain both halves
    expect(line).toMatch(/network/i);
    expect(line).toMatch(/\/model|retry/i);
  });
});

// ---------------------------------------------------------------------------
// TURN_ERROR -> SystemMessageRouter integration
// ---------------------------------------------------------------------------

function makeConversation(): {
  addSystemMessage: ReturnType<typeof mock>;
  addTypedSystemMessage: ReturnType<typeof mock>;
  _typedMessages: Array<{ msg: string; kind: string }>;
} {
  const _typedMessages: Array<{ msg: string; kind: string }> = [];
  return {
    addSystemMessage: mock((_msg: string) => {}),
    addTypedSystemMessage: mock((msg: string, kind: string) => { _typedMessages.push({ msg, kind }); }),
    _typedMessages,
  } as unknown as {
    addSystemMessage: ReturnType<typeof mock>;
    addTypedSystemMessage: ReturnType<typeof mock>;
    _typedMessages: Array<{ msg: string; kind: string }>;
  };
}

function makeTargetResolver(
  overrides: Partial<Record<SystemMessageKind, SystemMessageTarget>> = {},
): (kind: SystemMessageKind) => SystemMessageTarget {
  return (kind) => overrides[kind] ?? 'both';
}

/**
 * Simulates what main.ts TURN_ERROR handler does:
 * format the error and route it as a high-priority system message.
 */
async function simulateTurnError(
  router: SystemMessageRouter,
  err: unknown,
): Promise<void> {
  const { message, action } = await readUserFacingError(err);
  router.high(`[Error] ${message} ${action}`);
}

// (the purge): the system-messages side surface was DELETE-disposition and has been
// removed; SystemMessageRouter no longer takes a delivery-surface argument at all (see
// system-message-router.ts's file doc, every message now reaches
// conversation.addTypedSystemMessage()). These tests used to also assert on
// a mock surface's push() calls; that assertion is gone, the conversation
// assertion is what remains and is unchanged in spirit.
describe('TURN_ERROR -> SystemMessageRouter', () => {
  test('auth error routes as high-priority message containing /login', async () => {
    reading('auth');
    const conv = makeConversation();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver({ system: 'both' }),
    );

    await simulateTurnError(router, { status: 401, message: 'Unauthorized' });

    expect(conv.addTypedSystemMessage).toHaveBeenCalledTimes(1);
    const [msg, kind] = (conv.addTypedSystemMessage as ReturnType<typeof mock>).mock.calls[0] as [string, string];
    expect(kind).toBe('system');
    expect(msg).toContain('/login');
  });

  test('rate-limit error routes as high-priority message containing /model', async () => {
    reading('rate-limit');
    const conv = makeConversation();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver({ system: 'both' }),
    );

    await simulateTurnError(router, { status: 429, message: 'Too Many Requests' });

    const [msg] = (conv.addTypedSystemMessage as ReturnType<typeof mock>).mock.calls[0] as [string, string];
    expect(msg).toContain('/model');
  });

  test('context-overflow error routes as high-priority message containing /compact', async () => {
    reading('context-overflow');
    const conv = makeConversation();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver({ system: 'both' }),
    );

    await simulateTurnError(router, new Error('context window exceeded'));

    const [msg] = (conv.addTypedSystemMessage as ReturnType<typeof mock>).mock.calls[0] as [string, string];
    expect(msg).toContain('/compact');
  });

  test('network error routes as high-priority message', async () => {
    reading('network');
    const conv = makeConversation();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver({ system: 'both' }),
    );

    await simulateTurnError(router, new Error('fetch failed'));

    const [msg] = (conv.addTypedSystemMessage as ReturnType<typeof mock>).mock.calls[0] as [string, string];
    expect(msg).toMatch(/network/i);
  });

  test('generic error routes as high-priority message', async () => {
    reading('generic');
    const conv = makeConversation();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver({ system: 'both' }),
    );

    await simulateTurnError(router, new Error('completely unknown failure'));

    const [msg] = (conv.addTypedSystemMessage as ReturnType<typeof mock>).mock.calls[0] as [string, string];
    expect(msg).toMatch(/\[Error\]/i);
  });
});
