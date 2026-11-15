import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { composeDraftReply, countSentences, extractStyleProfile } from '../platform/src/platform/email/style-reply.js';
import { taskRouteSourceFixture } from './_helpers/task-route-source.ts';

let prior: ReturnType<typeof installJudgmentPort>;
const owners: ReturnType<typeof taskRouteSourceFixture>[] = [];
beforeEach(() => { prior = installJudgmentPort(undefined); });
afterEach(async () => { installJudgmentPort(prior); for (const owner of owners.splice(0).reverse()) await owner.close(); });
function source() { const fixture = taskRouteSourceFixture({}); owners.push(fixture); return fixture; }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected recorded style state');
  return Object.fromEntries(Object.entries(value));
}

/** A port that finds a sentence end after every full stop and no greeting or sign-off at all. */
function sentencePort(longest: { value: number }, requests: { sentence: number }) {
  return fakePort((name, question, state) => {
    const data = record(state);
    if (name === 'tone' && question.type === 'choice') return choiceAnswer(question, 'neutral', 0.999);
    const items = data.items;
    if (!Array.isArray(items) || !/^item_\d+$/.test(name) || question.type !== 'noul') throw new Error('Unknown style question');
    const item = record(items[Number(name.slice(5))]);
    if (item.purpose !== undefined) return noulAnswer(0.001);
    const document = record(items[0]).document;
    if (typeof document !== 'string') throw new Error('Every sentence batch carries the document first');
    if (Number(name.slice(5)) === 0) requests.sentence += 1;
    longest.value = Math.max(longest.value, String(item.before).length, String(item.after).length);
    const position = Number(item.position);
    return noulAnswer(document.slice(position - 1, position) === '.' ? 0.999 : 0.001);
  });
}

const sentence = 'The plan for this part is ready and shared. ';

test.each([150, 300] as const)('a sent message of about %i words is read in full, not refused', async words => {
  const body = sentence.repeat(Math.ceil(words / 9)).trim();
  const longest = { value: 0 }, requests = { sentence: 0 };
  installJudgmentPort(sentencePort(longest, requests).port);
  const profile = await extractStyleProfile([{ bodyPreview: body }], { sourceOwner: source().owner });
  expect(profile.medianSentenceCount).toBe(Math.ceil(words / 9));
  expect(longest.value).toBeLessThanOrEqual(160);
});

test('a message needing more than one request still counts every sentence once', async () => {
  const body = sentence.repeat(60).trim();
  const longest = { value: 0 }, requests = { sentence: 0 };
  installJudgmentPort(sentencePort(longest, requests).port);
  expect(await countSentences(body, { sourceOwner: source().owner })).toBe(60);
  expect(requests.sentence).toBeGreaterThan(1);
});

test('a corpus with no greeting or closing says so instead of claiming a learned one', async () => {
  const body = 'The plan is ready.';
  installJudgmentPort(sentencePort({ value: 0 }, { sentence: 0 }).port);
  const profile = await extractStyleProfile([{ bodyPreview: body }], { sourceOwner: source().owner });
  expect(profile.isDefault).toBe(false);
  expect(profile.templateFields).toEqual(['greeting', 'signOff']);

  const draft = await composeDraftReply(
    { from: '', subject: 'Plan', bodyPreview: 'Hello' }, profile, 'Thanks for the update on timing.', () => false,
    { sourceOwner: source().owner },
  );
  expect(draft.reviewBoundary).toContain('greeting, signOff');
  expect(draft.reviewBoundary).toContain('template defaults');
});
