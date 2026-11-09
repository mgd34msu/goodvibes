import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort, decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { computeSingleEdit } from '../platform/src/platform/tools/edit/match.js';
import { readPendingPrompt, readWillPrompt } from '../platform/src/platform/tools/exec/interactive.js';
import { keepForCall } from '../platform/src/platform/tools/shared/overflow.js';
import { ConversationManager } from '../platform/src/platform/core/conversation.js';
import { ResponseCompletionGuard } from '../platform/src/platform/core/response-completion.js';
import { prepareSystemMessagePresentation } from '../platform/src/platform/runtime/system-message-presentation.js';
import { readNormalizedError } from '../platform/src/platform/utils/error-display.js';
import { readReadable, readSummary } from '../platform/src/platform/tools/fetch/page-reading.js';
import { readCredentialHeader } from '../platform/src/platform/tools/credential-header-reading.js';
import { validateLinkTarget } from '../platform/src/platform/security/link-validation.js';
import { buildLocalReturnContextSummary } from '../platform/src/platform/runtime/session-return-context.js';

let prior: ReturnType<typeof installJudgmentPort>;
let decisionRequests = 0;
beforeEach(() => {
  decisionRequests = 0;
  const fake = fakePort(() => { decisionRequests++; throw new JudgmentError('unavailable', 'test endpoint unavailable'); });
  prior = installJudgmentPort(fake.port);
});
afterEach(() => { installJudgmentPort(prior); });

test('Classic edit, command preparation, output delivery and finalization use no decision requests', async () => {
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const signal = new AbortController().signal;
    const edit = await computeSingleEdit('const value = 1;\n', { path: 'example.ts', find: 'value = 1', replace: 'value = 2' }, 'exact', true, true, false, { signal });
    expect(edit).toEqual({ newContent: 'const value = 2;\n', occurrencesReplaced: 1, warning: undefined });
    expect(await computeSingleEdit('const value = 1;\n', { path: 'example.ts', find: 'wrong target', replace: 'value = 2' }, 'exact', true, true, false, { signal }))
      .toMatchObject({ error: 'Find string not found unambiguously in file' });
    expect(await readWillPrompt('printf done', signal)).toBe(false);
    expect(await readPendingPrompt('interactive-command', 'Continue? ', signal)).toBe('Continue?');
    expect(await keepForCall('first\n' + 'middle'.repeat(50) + '\nlast', 20, 'exec')).toContain('omitted');
    expect(await prepareSystemMessagePresentation('Command exited with code 1.', signal)).toEqual({ provenance: 'classic' });
    await readNormalizedError(Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' }), { signal, site: 'test.classic.error' });

    const conversation = new ConversationManager();
    const request = 'Change value to 2 and report the result.';
    conversation.addUserMessage(request);
    conversation.addAssistantMessage('The file was updated.');
    const response = 'Changed value to 2.';
    const guard = new ResponseCompletionGuard({ conversation, request });
    expect(await guard.check({ conversation, request, response, tools: ['edit'] }, { signal })).toBeNull();
    const current = guard.beginFinalization({ content: response });
    current();
    conversation.addAssistantMessage(response);
    current();
    expect(decisionModelPolicyState()).toMatchObject({ policy: 'Classic - Off', operation: 'classic', reason: 'selected' });
    expect(decisionRequests).toBe(0);
  });
});

test('Preferred exhaustion changes only the decision phase and preserves the existing transcript', async () => {
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage('Continue the existing work.');
    conversation.addAssistantMessage('Completed the first edit.');
    const original = conversation.getMessageSnapshot();
    expect(await readWillPrompt('printf done', new AbortController().signal)).toBe(false);
    expect(decisionRequests).toBe(1);
    expect(decisionModelPolicyState()).toMatchObject({ policy: 'Preferred', operation: 'classic', reason: 'unavailable' });
    const response = 'The existing edit is preserved.';
    const guard = new ResponseCompletionGuard({ conversation, request: 'Continue the existing work.' });
    expect(await guard.check({ conversation, request: 'Continue the existing work.', response, tools: [] })).toBeNull();
    const current = guard.beginFinalization({ content: response });
    conversation.addAssistantMessage(response);
    current();
    expect(conversation.getMessageSnapshot().slice(0, original.length)).toEqual(original);
    expect(decisionRequests).toBe(1);
  });
});

test('Default - On reports exhaustion without selecting Classic', async () => {
  await withDecisionModelPolicy(() => 'Default - On', async () => {
    await expect(readWillPrompt('printf done', new AbortController().signal)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

test('Classic fetch preparation keeps literal page content and deterministic URL/header boundaries', async () => {
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const html = '<html><head><title>Example</title></head><body><h1>Overview</h1><p>Actual source paragraph.</p></body></html>';
    expect(await readReadable(html)).toContain('Actual source paragraph.');
    expect(await readSummary(html, true)).toContain('no semantic summary was generated');
    expect(await readCredentialHeader('Accept')).toBe(false);
    expect(await readCredentialHeader('Authorization')).toBe(true);
    expect(await readCredentialHeader('x-unclassified-private-value')).toBe(true);
    expect(await validateLinkTarget('https://docs.example.com/help', 'example.com')).toMatchObject({ ok: true, provenance: 'classic' });
    expect(await validateLinkTarget('https://example.com@evil.example/help', 'example.com')).toMatchObject({ ok: false, reason: 'contains-userinfo' });
    expect(await validateLinkTarget('https://example.com.evil.example/help', 'example.com')).toMatchObject({ ok: false, reason: 'domain-mismatch' });
    expect(decisionRequests).toBe(0);
  });
});

test('Classic publication still rejects cancellation and changes to the accepted evidence', async () => {
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const abort = new AbortController();
    const conversation = new ConversationManager(); conversation.addUserMessage('Report the result.');
    const input = { conversation, request: 'Report the result.', response: 'Finished.', tools: [] };
    const guard = new ResponseCompletionGuard({ conversation, request: input.request });
    await guard.check(input, { signal: abort.signal });
    const current = guard.beginFinalization({ content: input.response });
    conversation.addUserMessage('The request changed.');
    expect(current).toThrow();
    abort.abort(new Error('owner cancelled'));
    await expect(guard.check(input, { signal: abort.signal })).rejects.toThrow();
    expect(decisionRequests).toBe(0);
  });
});

test('Classic session summaries use actual host approval counts and otherwise report unknown', async () => {
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage('Resume the existing task.');
    conversation.addSystemMessage('[Approval] A historical request was waiting.');
    const messages = conversation.getMessageSnapshot();
    const unknown = await buildLocalReturnContextSummary(messages);
    expect(unknown.pendingApprovals).toBeNull();
    expect(unknown.lines.join('\n')).toContain('consult the live approval queue');
    expect((await buildLocalReturnContextSummary(messages, { pendingApprovals: 2 })).pendingApprovals).toBe(2);
    expect(decisionRequests).toBe(0);
  });
});
