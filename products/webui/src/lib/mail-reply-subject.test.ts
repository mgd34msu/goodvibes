import { afterEach, expect, mock, test } from 'bun:test';
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-api';
import { invalidateClientLifetime } from './client-lifetime';

type Request = BrowserJudgmentRequest<'webui.mail.reply-subject'>;
let calls: { input: Request; signal: AbortSignal }[] = [];
let transport: (input: Request, signal: AbortSignal) => Promise<unknown> = async input => response(input);
mock.module('./goodvibes', () => ({
  readBrowserDecisionPolicy: async () => ({ policy: 'Default - On', operation: 'decision', reason: null, revision: 0 }),
  runBrowserJudgment: (input: Request, signal: AbortSignal) => { calls.push({ input, signal }); return transport(input, signal); },
}));
const { readMailReplySubject, readMailReplySubjectResponse } = await import('./mail-reply-subject');
const request = (): Request => ({ protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.mail.reply-subject', batteryVersion: 1, input: { subjectRef: 'synthetic-subject-reference' } });
function response(input: Request, verdict: 'yes' | 'no' | 'uncertain' = 'no') {
  const settled = verdict !== 'uncertain';
  return { protocolVersion: 1, batteryVersion: 1, requestId: input.requestId, battery: input.battery,
    status: settled ? 'settled' : 'held', ...(settled ? { value: { alreadyReply: verdict === 'yes' } } : { reason: 'uncertain' }),
    readings: { already_reply: { kind: 'yes-no', probability: verdict === 'yes' ? 0.99 : verdict === 'no' ? 0.01 : 0.5, verdict, outcome: settled ? 'act' : 'confirm' } },
    outcome: settled ? 'act' : 'confirm', evidence: [{ decisionId: 'synthetic-decision', model: 'synthetic', requestedModel: 'synthetic', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 }] };
}
afterEach(() => { calls = []; transport = async input => response(input); });

test.each(['yes', 'no', 'uncertain'] as const)('accepts a genuine-shaped %s boolean reading without subject text', verdict => {
  const input = request();
  expect(readMailReplySubjectResponse(input, response(input, verdict))).toEqual(verdict === 'uncertain' ? { status: 'held' } : { status: 'ready', alreadyReply: verdict === 'yes' });
});
test.each(['request', 'invented-text', 'boolean', 'missing-reading', 'unsettled', 'evidence'] as const)('rejects %s response integrity failure', kind => {
  const input = request(); const wire = response(input);
  let raw: unknown = wire;
  if (kind === 'request') raw = { ...wire, requestId: crypto.randomUUID() };
  if (kind === 'invented-text') raw = { ...wire, value: { alreadyReply: false, subject: 'Different text' } };
  if (kind === 'boolean') raw = { ...wire, value: { alreadyReply: true } };
  if (kind === 'missing-reading') raw = { ...wire, readings: {} };
  if (kind === 'unsettled') raw = { ...wire, readings: { already_reply: { ...wire.readings.already_reply, verdict: 'uncertain' } } };
  if (kind === 'evidence') raw = { ...wire, evidence: [] };
  expect(readMailReplySubjectResponse(input, raw)).toBeUndefined();
});
test.each([['RE: Lunch?', true], ['Fwd: AW: Lunch?', true], ['Lunch?', false], ['Invoice: May', false]] as const)('the rule decides %s with no request', async (subject, alreadyReply) => {
  expect(await readMailReplySubject('synthetic-subject-reference', new AbortController().signal, subject)).toMatchObject({ status: 'ready', provenance: 'rule', alreadyReply });
  expect(calls).toHaveLength(0);
});
test('an unknown short prefix sends only the issued reference and exposes a client-lifetime-bound boolean', async () => {
  transport = async input => response(input, 'yes');
  const result = await readMailReplySubject('synthetic-subject-reference', new AbortController().signal, 'Vs: Lunch?');
  expect(result).toMatchObject({ status: 'ready', alreadyReply: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.input.input).toEqual({ subjectRef: 'synthetic-subject-reference' });
  if (result.status !== 'ready') throw new Error('Missing ready fixture');
  expect(result.isCurrent()).toBe(true);
  invalidateClientLifetime();
  expect(result.isCurrent()).toBe(false);
});
test.each(['cancel', 'client-change'] as const)('%s aborts the transport and rejects its late answer', async kind => {
  const barrier = Promise.withResolvers<unknown>();
  const started = Promise.withResolvers<void>();
  transport = () => { started.resolve(); return barrier.promise; };
  const abort = new AbortController();
  const pending = readMailReplySubject('synthetic-subject-reference', abort.signal, 'Vs: Lunch?');
  await started.promise;
  if (kind === 'cancel') abort.abort(); else invalidateClientLifetime();
  expect(calls[0]!.signal.aborted).toBe(true);
  barrier.resolve(response(calls[0]!.input, 'yes'));
  expect(await pending).toEqual({ status: 'unavailable' });
});
test('an unsure or failed reading leaves the rule answer, so the draft is never held', async () => {
  expect(await readMailReplySubject('synthetic-subject-reference', new AbortController().signal)).toEqual({ status: 'held' });
  expect(calls).toHaveLength(0);
  transport = async input => response(input, 'uncertain');
  expect(await readMailReplySubject('synthetic-subject-reference', new AbortController().signal, 'Vs: Lunch?')).toMatchObject({ status: 'ready', provenance: 'rule', alreadyReply: false });
  transport = async () => { throw new Error('synthetic outage'); };
  expect(await readMailReplySubject('synthetic-subject-reference', new AbortController().signal, 'Vs: Lunch?')).toMatchObject({ status: 'ready', provenance: 'rule', alreadyReply: false });
  expect(calls).toHaveLength(2);
});
