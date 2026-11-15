/** Re-verifying an already published release must not depend on what is latest or on main today. */
import { expect, test } from 'bun:test';
import { readPublicAcceptanceDelivery, type AcceptanceFetch } from './accept-published-suite.mjs';

const source = 'a'.repeat(40), tag = 'v3.1.2', target = 'darwin-arm64';
const api = 'https://api.github.com/repos/mgd34msu/goodvibes', download = `https://github.com/mgd34msu/goodvibes/releases/download/${tag}/`;
const immutableUrl = `https://raw.githubusercontent.com/mgd34msu/goodvibes/${source}/scripts/install.sh`, publicUrl = 'https://goodvibes.sh/install.sh';
const descriptors = ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent'].map(command => `${command}-macos-arm64.reader-ci-artifact.json`);

function deliver(options: { latestTag: string; publicBody?: string; mode?: 'release' | 'recheck' }) {
  const assets = ['SHA256SUMS.txt', ...descriptors.flatMap(name => [name, name.replace('.reader-ci-artifact.json', '')])].map(name => ({ name }));
  const readers = descriptors.map(name => ({ target, sourceCommit: source, headCommit: source, readers: { version: '3.1.2' },
    files: [{ path: name.replace('.reader-ci-artifact.json', '') }] }));
  const responses = new Map<string, { body: unknown; url?: string }>([
    [`${api}/releases/tags/${tag}`, { body: { tag_name: tag, draft: false, assets } }],
    [`${api}/releases/latest`, { body: { tag_name: options.latestTag } }],
    [immutableUrl, { body: '#!/bin/sh\nexit 0\n' }],
    [publicUrl, { body: options.publicBody ?? '#!/bin/sh\nexit 0\n', url: immutableUrl }],
    ...descriptors.map((name, i) => [download + name, { body: readers[i] }] as const),
  ]);
  const requests: string[] = [];
  const fetchImpl: AcceptanceFetch = async (url) => {
    requests.push(url);
    const fixture = responses.get(url); if (!fixture) throw new Error('Unowned public fixture request');
    const response = new Response(typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body));
    Object.defineProperty(response, 'url', { value: fixture.url ?? url }); return response;
  };
  const run = () => readPublicAcceptanceDelivery({ tag, source, target, ...(options.mode ? { mode: options.mode } : {}),
    checkpoint() {}, onHttpStatus() {} }, fetchImpl);
  return { run, requests };
}

test('the release-time run still requires the tag to be latest', async () => {
  await expect(deliver({ latestTag: 'v3.2.0' }).run()).rejects.toThrow('exact tag to be latest');
});

test('the release-time run still requires the public installer to equal the release source', async () => {
  await expect(deliver({ latestTag: tag, publicBody: '#!/bin/sh\necho moved\n' }).run()).rejects.toThrow('differs from the accepted release source');
});

test('a recheck of an older tag passes without asking what is latest or reading the public installer', async () => {
  const fixture = deliver({ latestTag: 'v3.2.0', mode: 'recheck' });
  const result = await fixture.run();
  expect(result.mode).toBe('recheck');
  expect(result.published.url).toBe(immutableUrl);
  expect(fixture.requests).not.toContain(`${api}/releases/latest`);
  expect(fixture.requests).not.toContain(publicUrl);
});

test('an unknown mode is refused', async () => {
  await expect(deliver({ latestTag: tag, mode: 'anything' as 'recheck' }).run()).rejects.toThrow('Unknown published acceptance mode');
});
