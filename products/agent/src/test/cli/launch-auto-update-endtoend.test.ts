/** Actual launch/apply/respawn/rollback with a complete synthetic release and
 * real native file/directory transactions. Authored source; execution deferred. */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { rollbackUpdate } from '../../input/commands/update-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { agentFixtureRelease, fixtureDigest, installAgentFixture } from '../helpers/suite-release.ts';
const OLD = '3.1.2', NEXT = '3.1.3', TAG = `v${NEXT}`, GITHUB = 'https://github.com/mgd34msu/goodvibes';
const launchModule = join(import.meta.dir, '..', '..', 'cli', 'launch-auto-update.ts');
const roots: string[] = [], servers: { stop(force: boolean): void }[] = [];
afterAll(() => { for (const server of servers) server.stop(true); for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function source(version: string, old: boolean): string {
  return `#!/usr/bin/env bun
import {runLaunchAutoUpdate,restartOntoUpdatedBinary} from ${JSON.stringify(launchModule)};
const currentVersion=${JSON.stringify(version)}, base=process.env.GV_TEST_RELEASES_BASE;
const fetchImpl=${old ? `async(url,init)=>{const target=base+url.slice(${JSON.stringify(GITHUB)}.length);const response=await fetch(target,init);if(response.url!==target)throw new Error('unexpected redirect');Object.defineProperty(response,'url',{value:url});return response;}` : `async()=>{console.log('UNEXPECTED-FETCH');throw new Error('unexpected fetch');}`};
const outcome=await runLaunchAutoUpdate({fetchImpl,execPath:process.argv[1],platform:process.platform,arch:process.arch,currentVersion,
settings:process.env.GV_TEST_DISABLE==='1'?{autoUpdateAtLaunch:false}:{launchCheckTimeoutMs:5000},env:process.env,
configManager:{get:key=>key==='controlPlane.webui.bundleDir'?process.env.GV_TEST_WEBUI_DIR:undefined},print:line=>console.log(line)});
if(outcome.action==='restart')process.exit(restartOntoUpdatedBinary({execPath:process.argv[1],argv:process.argv.slice(2),env:process.env,fromVersion:currentVersion}));
console.log('RUNNING v'+currentVersion+' argv='+JSON.stringify(process.argv.slice(2))+' outcome='+outcome.action+':'+outcome.reason);
`;
}
function install() {
  const root = makeProjectTempDir('agent-suite-launch-'); roots.push(root);
  const oldSource = source(OLD, true); return { root, oldSource, ...installAgentFixture(root, process.platform, process.arch, OLD, oldSource) };
}
function serve(options: { corrupt?: 'app' | 'addon' } = {}) {
  const nextSource = source(NEXT, false), release = agentFixtureRelease(process.platform, process.arch, NEXT, nextSource);
  const corruptName = options.corrupt === 'app' ? release.payload.asset : options.corrupt === 'addon'
    ? `sqlite-vec-${release.payload.target}.${process.platform === 'linux' ? 'so' : 'dylib'}` : undefined;
  const manifest = [...release.assets].map(([name, bytes]) => `${fixtureDigest(name === corruptName ? 'incorrect-release-pin' : bytes)}  ${name}\n`).join('');
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/releases/latest') return new Response(null, { status: 302, headers: { location: `${GITHUB}/releases/tag/${TAG}` } });
    const name = path.split('/').at(-1)!;
    if (name === 'SHA256SUMS.txt') return new Response(manifest);
    const bytes = release.assets.get(name); return new Response(bytes ?? 'missing', { status: bytes ? 200 : 404 });
  } }); servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, nextSource };
}
async function run(installation: ReturnType<typeof install>, base: string, args: string[], disabled = false) {
  const child = Bun.spawn([installation.appPath, ...args], { env: { ...process.env, GV_TEST_RELEASES_BASE: base,
    GV_TEST_WEBUI_DIR: installation.webui, ...(disabled ? { GV_TEST_DISABLE: '1' } : {}) }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout: out + err, code };
}
const supported = ['linux', 'darwin'].includes(process.platform) && ['x64', 'arm64'].includes(process.arch);
describe.if(supported)('Agent suite launch update, actual filesystem and respawn', () => {
  test('updates every selected companion and configured WebUI, restarts, then restores the complete original release', async () => {
    const f = install(), release = serve(), output = await run(f, release.base, ['--session', 'alpha']);
    expect(output.code).toBe(0); expect(output.stdout).toContain(`Updated GoodVibes ${NEXT}: goodvibes-agent.`);
    expect(output.stdout).toContain(`auto-update: ${TAG} installed, restarting onto the new version`);
    expect(output.stdout).toContain(`RUNNING v${NEXT} argv=["--session","alpha"] outcome=continue:just-updated`);
    expect(output.stdout).not.toContain('UNEXPECTED-FETCH'); expect(readFileSync(f.appPath, 'utf8')).toBe(release.nextSource);
    expect(readFileSync(f.addonPath, 'utf8')).toBe('new-addon'); expect(readFileSync(join(f.driver, 'index.js'), 'utf8')).toBe('new-driver');
    expect(readFileSync(join(f.webui, 'index.html'), 'utf8')).toBe('new-webui');
    const lines: string[] = []; rollbackUpdate({ execPath: f.appPath, platform: process.platform, arch: process.arch, currentVersion: NEXT,
      configManager: { get: key => key === 'controlPlane.webui.bundleDir' ? f.webui : undefined }, print: line => lines.push(line) });
    expect(lines.join('\n')).toContain(`Restored GoodVibes ${OLD}: goodvibes-agent.`);
    expect(readFileSync(f.appPath, 'utf8')).toBe(f.oldSource); expect(readFileSync(f.addonPath, 'utf8')).toBe('old-addon');
    expect(readFileSync(join(f.webui, 'index.html'), 'utf8')).toBe('old-webui'); expect(readFileSync(join(f.driver, 'index.html'), 'utf8')).toBe('old-driver');
    const restored = await run(f, release.base, ['--restored'], true); expect(restored.code).toBe(0);
    expect(restored.stdout).toContain(`RUNNING v${OLD} argv=["--restored"] outcome=continue:disabled`);
  }, 30_000);
  for (const corrupt of ['app', 'addon'] as const) test(`a corrupted ${corrupt} release pin leaves every original selected member intact`, async () => {
    const f = install(), release = serve({ corrupt }), output = await run(f, release.base, ['--work']);
    expect(output.code).toBe(0); expect(output.stdout).toContain('auto-update failed:'); expect(output.stdout).toContain('checksum mismatch');
    expect(output.stdout).toContain(`RUNNING v${OLD} argv=["--work"] outcome=continue:update-failed`);
    expect(readFileSync(f.appPath, 'utf8')).toBe(f.oldSource); expect(readFileSync(f.addonPath, 'utf8')).toBe('old-addon');
    expect(readFileSync(join(f.webui, 'index.html'), 'utf8')).toBe('old-webui'); expect(readFileSync(join(f.driver, 'index.html'), 'utf8')).toBe('old-driver');
  }, 30_000);
  test('offline release discovery starts the current version with one visible diagnostic', async () => {
    const f = install(), dead = Bun.serve({ port: 0, fetch: () => new Response('') }), base = `http://127.0.0.1:${dead.port}`; dead.stop(true);
    const output = await run(f, base, ['--offline']); expect(output.code).toBe(0);
    expect(output.stdout.split('\n').filter(line => line === 'update check skipped: offline')).toHaveLength(1);
    expect(output.stdout).toContain(`RUNNING v${OLD} argv=["--offline"] outcome=continue:check-skipped`); expect(readFileSync(f.appPath, 'utf8')).toBe(f.oldSource);
  }, 30_000);
});
