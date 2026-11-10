/** Actual Agent apply/rollback entry points over the complete shared suite.
 * Regression source is unrun while implementation work remains. */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realUpdateFileIo } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { applyUpdate, rollbackUpdate } from '../../input/commands/update-runtime.ts';
import type { UpdateFetchLike } from '../../runtime/update-check.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { agentFixtureRelease, fixtureDigest, fixtureTarGz, installAgentFixture } from '../helpers/suite-release.ts';
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const OLD = '3.1.2', NEXT = '3.1.3';
function fixture() {
  const root = makeProjectTempDir('agent-suite-command-'); roots.push(root);
  const installed = installAgentFixture(root, 'linux', 'x64', OLD, 'original-agent');
  const release = agentFixtureRelease('linux', 'x64', NEXT, 'new-agent');
  const manifest = () => [...release.assets].map(([name, bytes]) => `${fixtureDigest(bytes)}  ${name}\n`).join('');
  const config = { get: (key: string) => key === 'controlPlane.webui.bundleDir' ? installed.webui : undefined };
  const lines: string[] = [], requests: string[] = [];
  const fetchImpl: UpdateFetchLike = async url => {
    requests.push(url);
    const name = url.split('/').at(-1)!;
    const bytes = release.assets.get(name);
    const response = name === 'latest' ? new Response(null, { status: 302, headers: { location: `https://github.com/mgd34msu/goodvibes/releases/tag/v${NEXT}` } })
      : name === 'SHA256SUMS.txt' ? new Response(manifest()) : new Response(bytes ? Uint8Array.from(bytes) : 'missing', { status: bytes ? 200 : 404 });
    Object.defineProperty(response, 'url', { value: url }); return response;
  };
  const options = { fetchImpl, execPath: installed.appPath, platform: 'linux' as const, arch: 'x64', currentVersion: OLD,
    configManager: config, print: (line: string) => lines.push(line) };
  return { root, installed, release, lines, requests, options };
}
function originals(f: ReturnType<typeof fixture>): void {
  expect(readFileSync(f.installed.appPath, 'utf8')).toBe('original-agent');
  expect(readFileSync(f.installed.addonPath, 'utf8')).toBe('old-addon');
  expect(readFileSync(join(f.installed.driver, 'index.html'), 'utf8')).toBe('old-driver');
  expect(readFileSync(join(f.installed.webui, 'index.html'), 'utf8')).toBe('old-webui');
}
test('Agent apply and rollback delegate the selected program, raw native companions, driver and actual configured WebUI together', async () => {
  const f = fixture(), result = await applyUpdate(f.options);
  expect(result?.programs).toEqual(['goodvibes-agent']); expect(result?.version).toBe(NEXT);
  expect(readFileSync(f.installed.appPath, 'utf8')).toBe('new-agent'); expect(readFileSync(f.installed.addonPath, 'utf8')).toBe('new-addon');
  expect(readFileSync(join(f.installed.driver, 'index.js'), 'utf8')).toBe('new-driver'); expect(readFileSync(join(f.installed.webui, 'index.html'), 'utf8')).toBe('new-webui');
  expect(f.lines.join('\n')).toContain(`Updated GoodVibes ${NEXT}: goodvibes-agent.`);
  rollbackUpdate({ ...f.options, currentVersion: NEXT }); originals(f);
  expect(f.lines.join('\n')).toContain(`Restored GoodVibes ${OLD}: goodvibes-agent.`);
});
for (const missing of ['browser-driver.tar.gz', 'sqlite-vec-linux-x64.so', 'goodvibes-agent-linux-x64.bun', 'goodvibes-agent-linux-x64.reader-ci-artifact.json']) {
  test(`a release missing ${missing} refuses a partial Agent update`, async () => {
    const f = fixture(); f.release.assets.delete(missing);
    await expect(applyUpdate(f.options)).rejects.toThrow(); originals(f);
  });
}
test('a verified archive missing a required driver entry refuses before replacing the binary', async () => {
  const f = fixture(); f.release.assets.set('browser-driver.tar.gz', fixtureTarGz({ 'playwright-core/package.json': '{}', 'playwright-core/index.js': 'incomplete' }));
  await expect(applyUpdate(f.options)).rejects.toThrow(); originals(f);
});
test('a changed configured bundle path during latest-release lookup is never adopted after the await', async () => {
  // Configuration changes reject immediately after HEAD, before any installed
  // payload, reader descriptor or future release content is needed.
  const root = makeProjectTempDir('agent-suite-config-preflight-'); roots.push(root);
  const appPath = join(root, 'goodvibes-agent'), webui = join(root, 'webui', OLD);
  mkdirSync(webui, { recursive: true });
  writeFileSync(appPath, 'original-agent');
  writeFileSync(join(webui, 'index.html'), 'old-webui');
  let selected = webui;
  const requests: { url: string; method: string | undefined }[] = [], contentReads: string[] = [];
  const configManager = { get: (key: string) => key === 'controlPlane.webui.bundleDir' ? selected : undefined };
  await expect(applyUpdate({ execPath: appPath, platform: 'linux', arch: 'x64', currentVersion: OLD,
    configManager, print: () => {}, io: { ...realUpdateFileIo, readFile(path) {
      contentReads.push(path); throw new Error('Configuration preflight must not read native payloads or reader descriptors');
    } }, fetchImpl: async (url, init) => {
      requests.push({ url, method: init?.method });
      if (url !== 'https://github.com/mgd34msu/goodvibes/releases/latest' || init?.method !== 'HEAD') {
        throw new Error('Configuration preflight must not fetch release content');
      }
      selected = join(root, 'webui', 'foreign');
      const response = new Response(null, { status: 302, headers: { location: `https://github.com/mgd34msu/goodvibes/releases/tag/v${NEXT}` } });
      Object.defineProperty(response, 'url', { value: url }); return response;
    } })).rejects.toThrow('selection changed');
  expect(requests).toEqual([{ url: 'https://github.com/mgd34msu/goodvibes/releases/latest', method: 'HEAD' }]);
  expect(contentReads).toEqual([]);
  expect(readFileSync(appPath, 'utf8')).toBe('original-agent');
  expect(readFileSync(join(webui, 'index.html'), 'utf8')).toBe('old-webui');
});
test('package-managed installs retain install-kind gating and never enter suite downloads', async () => {
  let requested = 0; const lines: string[] = [];
  await applyUpdate({ fetchImpl: async () => { requested++; throw new Error('unexpected network'); }, execPath: '/fixture/node_modules/@goodvibes-jev/agent/bin/goodvibes-agent',
    platform: 'linux', arch: 'x64', currentVersion: OLD, print: line => lines.push(line) });
  expect(requested).toBe(0); expect(lines.join('\n')).toContain('not a self-updatable binary');
});

test('the registered native /update command passes its original platform config into shared suite apply and rollback', async () => {
  // Module mocks are isolated in a child so they cannot replace platform exports for
  // another suite. The command, preflight, getter capture and report are real.
  const modulePath = join(import.meta.dir, '..', '..', 'input', 'commands', 'update-runtime.ts');
  const workspacePath = join(import.meta.dir, '..', '..', 'runtime', 'workspace-update-policy.ts');
  const script = `
import {mock} from 'bun:test';
const enginePath='@goodvibes-jev/engine/platform/platform/runtime/self-update', opsPath='@goodvibes-jev/engine/platform/platform/runtime/operations';
const platform=await import(enginePath),ops=await import(opsPath);const calls=[],lines=[];let uncertain=false,halts=0;
const result={version:'99.0.0',programs:['goodvibes-agent','goodvibes-daemon'],files:[],directoryPaths:['/fixture/webui/3.1.2'],preservedPaths:[]};
mock.module(enginePath,()=>({...platform,applySuiteUpdate:async options=>{calls.push({kind:'apply',directory:options.webuiDirectory});options.assertCurrent?.();if(uncertain)throw new platform.SuiteUpdateRecoveryError(['/fixture/claim'],[],new Error('Synthetic uncertainty'));return result;},rollbackSuiteUpdate:options=>{calls.push({kind:'rollback',directory:options.webuiDirectory});return {...result,version:'98.0.0'};}}));
mock.module(opsPath,()=>({...ops,detectInstallKind:()=> 'binary'}));
mock.module(${JSON.stringify(workspacePath)},()=>({IS_WORKSPACE_DISTRIBUTION:false,WORKSPACE_UPDATE_GUIDANCE:'source only',WORKSPACE_REBUILD_COMMAND:'source only'}));
globalThis.fetch=async url=>{const response=new Response(null,{status:302,headers:{location:'https://github.com/mgd34msu/goodvibes/releases/tag/v99.0.0'}});Object.defineProperty(response,'url',{value:String(url)});return response;};
const product=await import(${JSON.stringify(modulePath)});let command;product.registerUpdateCommand({register(value){command=value;}});
const configManager={get:key=>key==='controlPlane.webui.bundleDir'?'/fixture/webui/3.1.2':undefined};
const context={platform:{configManager},print:line=>lines.push(line),exit(){halts++;}};
await command.handler(['apply'],context);await command.handler(['rollback'],context);uncertain=true;await command.handler(['apply'],context);console.log(JSON.stringify({calls,lines,halts}));
`;
  const child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, err }).toEqual({ code: 0, err: '' });
  const result = JSON.parse(out.trim().split('\n').at(-1)!) as { calls: unknown[]; lines: string[]; halts: number };
  expect(result.calls).toEqual([{ kind: 'apply', directory: '/fixture/webui/3.1.2' }, { kind: 'rollback', directory: '/fixture/webui/3.1.2' }, { kind: 'apply', directory: '/fixture/webui/3.1.2' }]);
  expect(result.halts).toBe(1);
  expect(result.lines.join('\n')).toContain('Updated GoodVibes 99.0.0'); expect(result.lines.join('\n')).toContain('Restored GoodVibes 98.0.0');
});
