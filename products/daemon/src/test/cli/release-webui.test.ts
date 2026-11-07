import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshReleaseWebUi } from '../../cli/release-webui.js';

let root: string, bundle: string, archive: Buffer;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'daemon-release-webui-'));
  bundle = join(root, 'webui/3.1.0'); mkdirSync(bundle, {recursive:true});
  writeFileSync(join(bundle, 'index.html'), 'previous UI');
  const stage = join(root, 'stage/goodvibes-webui'); mkdirSync(stage, {recursive:true});
  writeFileSync(join(stage, 'index.html'), 'updated UI');
  execFileSync('tar', ['--format=ustar', '-czf', join(root, 'bundle.tgz'), '-C', join(root,'stage'), 'goodvibes-webui']);
  archive = readFileSync(join(root, 'bundle.tgz'));
});
afterEach(() => rmSync(root, {recursive:true,force:true}));
function fixture(invalid = false) {
  let current = true;
  const requests: string[] = [];
  const hash = invalid ? '0'.repeat(64) : createHash('sha256').update(archive).digest('hex');
  const options = {execPath:join(root,'goodvibes-daemon'),version:'3.1.1',bundleDir:bundle,signal:new AbortController().signal,
    assertCurrent:()=>{if (!current) throw new Error('Owner retired');},
    fetchImpl:(async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(String(input).endsWith('SHA256SUMS.txt') ? `${hash}  goodvibes-webui-bundle-3.1.1.tar.gz\n` : new Uint8Array(archive));
    }) as typeof fetch};
  return {options,requests,retire:()=>{current=false;}};
}
test('an already installed matching release and a custom bundle require no downloads', async () => {
  const f=fixture();
  expect(await refreshReleaseWebUi({...f.options,version:'3.1.0'})).toBeUndefined();
  expect(await refreshReleaseWebUi({...f.options,bundleDir:join(root,'custom-ui')})).toBeUndefined();
  expect(f.requests).toHaveLength(0);
});
test('daemon updates refresh the owned WebUI from the same monorepo version', async () => {
  const f=fixture(); const next=await refreshReleaseWebUi(f.options);
  expect(next).toBe(join(root,'webui/3.1.1'));
  expect(readFileSync(join(next!,'index.html'),'utf8')).toBe('updated UI');
  expect(readFileSync(join(bundle,'index.html'),'utf8')).toBe('previous UI');
  expect(f.requests).toHaveLength(2);
  expect(f.requests.every(url=>url.startsWith('https://github.com/mgd34msu/goodvibes-jev/releases/download/v3.1.1/'))).toBe(true);
});
test('bad release bytes leave the old UI in place', async () => {
  const f=fixture(true);
  await expect(refreshReleaseWebUi(f.options)).rejects.toThrow();
  expect(existsSync(join(root,'webui/3.1.1'))).toBe(false);
  expect(readFileSync(join(bundle,'index.html'),'utf8')).toBe('previous UI');
});
test('a retired owner cannot publish downloaded WebUI files', async () => {
  const f=fixture(); const fetchImpl=f.options.fetchImpl;
  f.options.fetchImpl=(async (input: string | URL | Request, init?: RequestInit) => {
    const result=await fetchImpl(input,init);
    if (!String(input).endsWith('SHA256SUMS.txt')) f.retire();
    return result;
  }) as typeof fetch;
  await expect(refreshReleaseWebUi(f.options)).rejects.toThrow('Owner retired');
  expect(existsSync(join(root,'webui/3.1.1'))).toBe(false);
});
