import { afterEach, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { WEBUI_CODE_LANGUAGES } from '@goodvibes-jev/engine/platform/platform/judgment-browser/catalogs';
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-api';
import { invalidateClientLifetime } from '../lib/client-lifetime';

type Request = BrowserJudgmentRequest<'webui.code.language'>;
let calls: { request: Request; signal: AbortSignal }[] = [];
let transport: (request: Request) => Promise<unknown> = async request => response(request);
mock.module('../lib/goodvibes', () => ({ runBrowserJudgment: (request: Request, signal: AbortSignal) => { calls.push({ request, signal }); return transport(request); } }));
const { MarkdownMessage } = await import('./MarkdownMessage');
const { readCodeLanguage, readCodeLanguageResponse } = await import('../lib/code-language-judgment');
const { highlightCode, normalizeLanguage } = await import('../lib/highlight');
const source = { sessionId: 'synthetic-session', messageId: 'synthetic-message', contentRevision: 'message-owner-revision' };
const content = 'Before\n```\nconst count: number = 2;\n```\nAfter';
function response(request: Request, held = false) {
  return { protocolVersion: 1, batteryVersion: 2, requestId: request.requestId, battery: request.battery,
    status: held ? 'held' : 'settled', ...(held ? { reason: 'uncertain' } : { value: { language: 'typescript' } }),
    readings: { language: { kind: 'choice', choice: 'typescript', confidence: held ? 0.5 : 0.99,
      probabilities: Object.fromEntries(WEBUI_CODE_LANGUAGES.map(language => [language, language === 'typescript' ? 1 : 0])), outcome: held ? 'confirm' : 'act' } },
    outcome: held ? 'confirm' : 'act', evidence: [{ decisionId: 'synthetic', model: 'synthetic', requestedModel: 'synthetic', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 }] };
}
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
function render(text = content, withSource = true, bound = source) {
  if (!container) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); }
  flushSync(() => root!.render(<MarkdownMessage content={text} source={withSource ? bound : undefined} />));
  return container;
}
// The reading path is promise-driven end to end (no timers), so draining the microtask queue
// lets every continuation of an already-settled read run, with no assumed latency.
async function drain() {
  for (let i = 0; i < 20; i++) { await Promise.resolve(); }
  flushSync(() => {});
}
async function wait(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); flushSync(() => {}); }
  throw new Error('Fixture did not settle');
}
afterEach(() => {
  if (root) flushSync(() => root!.unmount()); container?.remove(); root = undefined; container = undefined;
  calls = []; transport = async request => response(request);
});
test('actual Markdown caller sends source binding only and adopts typed language without changing code', async () => {
  const el = render(); await wait(() => !!el.querySelector('.hljs-keyword'));
  expect(el.querySelector('.markdown-code-label')?.textContent).toBe('typescript');
  expect(el.querySelector('code')?.textContent).toBe('const count: number = 2;');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.request.input).toMatchObject({ sessionId: source.sessionId, messageId: source.messageId, start: content.indexOf('```'), end: content.lastIndexOf('```') + 3 });
  expect(calls[0]!.request.input.contentRevision).toBe(source.contentRevision);
  expect(JSON.stringify(calls[0]!.request)).not.toContain('const count');
});
test('no source or an unavailable reader stays escaped plaintext with no heuristic language', async () => {
  const el = render('```\n<script>alert(1)</script>\n```', false);
  await drain();
  expect(calls).toHaveLength(0); expect(el.querySelector('script')).toBeNull();
  expect(el.querySelector('.markdown-code-label')?.textContent).toBe('code');
  expect(el.querySelector('code')?.textContent).toBe('<script>alert(1)</script>');
});
test('declared library aliases stay mechanical; invented aliases do not select a grammar', async () => {
  const el = render('```ts\nconst count: number = 2;\n```');
  expect(el.querySelector('.hljs-keyword')).not.toBeNull(); expect(calls).toHaveLength(0);
  expect(normalizeLanguage('ts')).toBe('typescript'); expect(normalizeLanguage('ps1')).toBe('');
  expect(highlightCode('const count = 2;', '').language).toBe('');
});
test.each(['held', 'outage'])('%s preserves plain code', async kind => {
  transport = kind === 'held' ? async request => response(request, true) : async () => { throw new Error('fixture outage'); };
  const el = render(); await wait(() => calls.length === 1); await drain();
  expect(el.querySelector('.hljs-keyword')).toBeNull(); expect(el.querySelector('code')?.textContent).toBe('const count: number = 2;');
});
test.each(['unmount', 'replace', 'identity'])('%s aborts old reading and prevents late adoption', async kind => {
  const barrier = Promise.withResolvers<unknown>();
  // Only the first reading waits on the barrier; a replacement's own reading never settles,
  // so any highlight below could only come from the stale first reading being adopted.
  transport = () => (calls.length === 1 ? barrier.promise : new Promise(() => {}));
  const el = render(); await wait(() => calls.length === 1); const previous = calls[0]!;
  if (kind === 'unmount') { flushSync(() => root!.unmount()); root = undefined; }
  else if (kind === 'replace') render(content, true, { ...source, messageId: 'replacement-message' });
  else invalidateClientLifetime();
  flushSync(() => {}); await wait(() => previous.signal.aborted);
  barrier.resolve(response(previous.request)); await drain();
  expect(el.querySelector('.hljs-keyword')).toBeNull();
  if (kind === 'replace') expect(el.querySelector('code')?.textContent).toBe('const count: number = 2;');
});
test('client rejects wrong request, mismatched value and malformed language evidence', async () => {
  render(); await wait(() => calls.length === 1); const request = calls[0]!.request; const wire = response(request);
  expect(readCodeLanguageResponse(request, { ...wire, requestId: crypto.randomUUID() })).toBeUndefined();
  expect(readCodeLanguageResponse(request, { ...wire, value: { language: 'python' } })).toBeUndefined();
  expect(readCodeLanguageResponse(request, { ...wire, evidence: [] })).toBeUndefined();
  expect(readCodeLanguageResponse(request, { ...wire, readings: { language: { ...wire.readings.language, probabilities: { typescript: 1 } } } })).toBeUndefined();
});

test('array-coerced language and outcome cannot select a grammar', () => {
  const request: Request = { protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.code.language', batteryVersion: 2,
    input: { ...source, start: 0, end: 5 } };
  for (const property of ['choice', 'outcome'] as const) {
    const raw = response(request);
    Object.assign(raw.readings.language, { [property]: [raw.readings.language[property]] });
    expect(readCodeLanguageResponse(request, raw)).toBeUndefined();
  }
});

test('an admitted approximate-unit Choice reaches the actual Markdown grammar unchanged', async () => {
  transport = async request => {
    const raw = response(request);
    raw.readings.language.probabilities.typescript = 0.99;
    const original = structuredClone(raw);
    expect(readCodeLanguageResponse(request, raw)).toEqual({ status: 'ready', language: 'typescript' });
    expect(raw).toEqual(original);
    return raw;
  };
  const el = render(); await wait(() => !!el.querySelector('.hljs-keyword'));
  expect(el.querySelector('.markdown-code-label')?.textContent).toBe('typescript');
  expect(el.querySelector('code')?.textContent).toBe('const count: number = 2;');
});

test.each(['negative', 'over-one', 'non-finite', 'non-maximal', 'unknown-choice', 'extra-option', 'outside-total', 'invalid-confidence'])(
  'rejects %s code-language Choice evidence', kind => {
    const request: Request = { protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.code.language', batteryVersion: 2,
      input: { ...source, start: 0, end: 5 } };
    const raw = response(request); const reading = raw.readings.language;
    if (kind === 'negative') reading.probabilities.python = -0.001;
    if (kind === 'over-one') reading.probabilities.typescript = 1.001;
    if (kind === 'non-finite') reading.probabilities.typescript = Infinity;
    if (kind === 'non-maximal') { reading.probabilities.typescript = 0.5; reading.probabilities.python = 0.5000000001; }
    if (kind === 'unknown-choice') { reading.choice = 'invented'; Object.assign(raw, { value: { language: 'invented' } }); }
    if (kind === 'extra-option') reading.probabilities.invented = 0;
    if (kind === 'outside-total') reading.probabilities.typescript = 0.8;
    if (kind === 'invalid-confidence') reading.confidence = 1.001;
    expect(readCodeLanguageResponse(request, raw)).toBeUndefined();
  });

test.each(['contentRevision', 'content', 'end'] as const)('%s source replacement refuses a valid late language reading', async field => {
  const answer = Promise.withResolvers<unknown>(); transport = () => answer.promise;
  const current = { ...source, content, start: content.indexOf('```'), end: content.lastIndexOf('```') + 3 };
  // The reader snapshots its source, so a replacement is only visible through the caller's currency check.
  const issued = { ...current };
  Object.assign(current, { isSourceCurrent: () => current.contentRevision === issued.contentRevision && current.content === issued.content && current.end === issued.end });
  const pending = readCodeLanguage(current, new AbortController().signal);
  await wait(() => calls.length === 1);
  if (field === 'end') current.end--;
  else if (field === 'content') current.content += '\nchanged';
  else current.contentRevision = 'replacement-owner-revision';
  answer.resolve(response(calls[0]!.request));
  expect(await pending).toEqual({ status: 'unavailable' });
});
