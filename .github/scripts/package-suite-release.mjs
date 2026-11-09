// Runs on release builders. End-user installation only downloads these files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [target, destination, tag] = process.argv.slice(2);
assert(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].includes(target));
assert(typeof tag === 'string' && tag.length <= 129 && /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag));
const root = process.cwd();
// This coordinator may itself be retained outside the checkout by the workflow.
// Reader evidence must come from the exact selected release source, not that
// coordinator's former relative directory or a nearby installed engine.
const { inspectTerminalReaderArtifact, retainTerminalReaderCohort } = await import(pathToFileURL(join(root, 'packages/engine/toolchain/src/lib/client-reader-artifact.ts')).href);
const { clientReaderPayloadPaths, clientReaderMemberAsset } = await import(pathToFileURL(join(root, 'packages/engine/platform/src/platform/runtime/client-reader-artifact.ts')).href);
const { resolveDaemonNativePayloads, retainDaemonNativeFiles, parseDaemonCiArtifact, assertDaemonNativePayloadPins } = await import(pathToFileURL(join(root, 'packages/engine/platform/src/platform/runtime/daemon-native-cohort.ts')).href);
const { realUpdateFileIo } = await import(pathToFileURL(join(root, 'packages/engine/platform/src/platform/runtime/update-file-io.ts')).href);
const { parseNativeReaderCapabilities } = await import(pathToFileURL(join(root, 'packages/engine/platform/src/platform/runtime/native-reader-compatibility.ts')).href);
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], timeout: 300_000 }).toString().trim();
const source = run('git', ['rev-parse', 'HEAD']);
const sourceTree = run('git', ['rev-parse', 'HEAD^{tree}']);
assert.equal(JSON.parse(readFileSync('package.json')).version, tag.slice(1));
run('git', ['diff', '--exit-code', 'HEAD']);
const { createReleaseStage } = await import(pathToFileURL(join(root, 'packages/engine/toolchain/src/lib/release-publication.ts')).href);
const releaseStage = createReleaseStage(destination, '.suite-staging-');
const ownedOutputs = [];
try {
  const files = {};
  const retainedReleaseSources = [];
  const publishBytes = (name, bytes, mode) => {
    const original = releaseStage.publishBytes(name, bytes, mode);
    ownedOutputs.push(original); retainedReleaseSources.push(original.assertCurrent);
  };
  const publishArchive = (name) => {
    const original = releaseStage.publish(name, name);
    ownedOutputs.push(original); retainedReleaseSources.push(original.assertCurrent);
    original.assertCurrent(); const bytes = readFileSync(original.path); original.assertCurrent();
    files[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  };
  const put = (path, name = basename(path)) => {
    const bytes = readFileSync(path);
    if (files[name]) {
      // Several products supply the same published addon. Compare this input
      // with the actual original output; its first pin is already the release
      // checksum. A copied filename or replaced output cannot inherit it.
      const original = ownedOutputs.find(output => output.path === join(destination, name));
      assert(original, 'Original published addon owner is missing');
      original.assertCurrent();
      const selected = readFileSync(original.path);
      original.assertCurrent();
      assert(bytes.equals(selected), 'Product addon bytes differ');
      return;
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    publishBytes(name, bytes, lstatSync(path).mode & 0o777);
    files[name] = { sha256: hash, size: bytes.length };
  };
  const [platform, arch] = target.split('-');
  assert.equal(process.platform, platform); assert.equal(process.arch, arch);
  const suffix = `${platform === 'darwin' ? 'macos' : platform}-${arch}`;
  for (const [product, command, output] of [['tui', 'goodvibes', 'dist'], ['agent', 'goodvibes-agent', 'dist'], ['daemon', 'goodvibes-daemon', 'native']]) {
    run('bun', ['run', product === 'tui' ? 'build' : 'build:binary', '--target', target], join(root, 'products', product));
    const directory = join(root, 'products', product, output);
    const binary = join(directory, `${command}-${suffix}`);
    const extension = platform === 'linux' ? 'so' : 'dylib';
    const daemonPayloads = product === 'daemon' && platform === 'linux' ? resolveDaemonNativePayloads(platform, arch) : undefined;
    const readerCurrent = daemonPayloads ? retainDaemonNativeFiles(daemonPayloads.map(payload => ({ label: payload.relativePath, path: join(directory, payload.relativePath), assetName: payload.assetName, executable: payload.executable })), realUpdateFileIo)
      : retainTerminalReaderCohort(directory, `@goodvibes-jev/${product}`, target);
    readerCurrent?.();
    assert.equal(run(binary, ['--version']), `${command} ${tag.slice(1)}`);
    readerCurrent?.();
    put(binary);
    if (platform === 'linux') for (const ending of ['.bun', '.bun.json', '.bun.LICENSE.md']) put(binary + ending);
    // Complete actual Darwin daemon companions precede inspection. Pins are
    // computed once by put(), then mapped from flat assets to fixed runtime paths.
    put(join(directory, `lib/sqlite-vec-${target}/vec0.${extension}`), `sqlite-vec-${target}.${extension}`);
    if (product === 'daemon' && platform === 'darwin') {
      put(join(directory, `lib/sqlite-${target}/libsqlite3.dylib`), `sqlite-${target}.dylib`);
      put(join(directory, `lib/sqlite-${target}/libsqlite3.dylib.json`), `sqlite-${target}.dylib.json`);
    }
    const emitReader = (name, artifact) => {
      const bytes = Buffer.from(JSON.stringify(artifact, null, 2) + '\n');
      publishBytes(name, bytes, 0o644);
      files[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    };
    if (daemonPayloads) {
      readerCurrent();
      const declared = parseNativeReaderCapabilities(JSON.parse(execFileSync(binary, ['check-install-reader', '--describe'], {
        encoding: 'utf8', timeout: 15_000, maxBuffer: 32 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory, LANG: 'C' },
      })));
      readerCurrent(); assert.equal(declared.version, tag.slice(1));
      const descriptor = parseDaemonCiArtifact({ schema: 2, sourceCommit: source, sourceTree, headCommit: source, target,
        files: daemonPayloads.map(payload => ({ path: payload.relativePath, ...files[payload.assetName], mode: payload.executable ? 0o755 : 0o644 })), readers: declared }, target);
      assertDaemonNativePayloadPins(descriptor, descriptor.files, readFileSync(binary + '.bun.json')); readerCurrent();
      const { readers: _readers, ...base } = descriptor;
      emitReader(`${basename(binary)}.ci-artifact.json`, { ...base, schema: 1 });
      emitReader(`${basename(binary)}.reader-ci-artifact.json`, descriptor);
    } else {
      const packageName = `@goodvibes-jev/${product}`, names = clientReaderPayloadPaths(packageName, target);
      const artifact = inspectTerminalReaderArtifact({ directory, packageName, version: tag.slice(1),
        target, sourceCommit: source, sourceTree, headCommit: source, assertCurrent: readerCurrent,
        files: names.map(path => ({ path, ...files[clientReaderMemberAsset({packageName,target}, path)], mode: path === basename(binary) || path.endsWith('.bun') ? 0o755 : 0o644 })) });
      readerCurrent(); emitReader(`${basename(binary)}.reader-ci-artifact.json`, artifact);
    }
  }
  const addonStage = join(releaseStage.path, 'addon');
  const addonRelative = `lib/sqlite-vec-${target}/vec0.${platform === 'linux' ? 'so' : 'dylib'}`;
  releaseStage.assertCurrent(); mkdirSync(dirname(join(addonStage, addonRelative)), { recursive: true });
  {
    releaseStage.assertCurrent();
    cpSync(join(destination, `sqlite-vec-${target}.${platform === 'linux' ? 'so' : 'dylib'}`), join(addonStage, addonRelative));
    const archive = `sqlite-vec-${target}.tar.gz`;
    releaseStage.assertCurrent();
    run('tar', ['-czf', join(releaseStage.path, archive), '-C', addonStage, addonRelative]);
    publishArchive(archive);
  }
  if (target === 'linux-x64') {
    run('bun', ['run', 'build'], join(root, 'products/webui'));
    const { packBundle } = await import(pathToFileURL(join(root, 'products/webui/scripts/pack-bundle.ts')).href);
    const packed = packBundle({ distDir: join(root, 'products/webui/dist'), outDir: resolve(destination), version: tag.slice(1) });
    ownedOutputs.push({ removeOwned: packed.removeOwnedArchive });
    packed.assertCurrent();
    packed.removeOwnedChecksum();
    files[packed.assetName] = { sha256: packed.sha256, size: packed.size };
    retainedReleaseSources.push(packed.assertCurrent);
    const staging = join(releaseStage.path, 'browser'); releaseStage.assertCurrent(); mkdirSync(staging);
    {
      const require = createRequire(join(root, 'packages/engine/package.json'));
      const driver = dirname(require.resolve('playwright-core/package.json'));
      for (const name of ['package.json', 'index.js', 'cli.js']) assert(existsSync(join(driver, name)));
      releaseStage.assertCurrent();
      cpSync(driver, join(staging, 'playwright-core'), { recursive: true, dereference: true });
      releaseStage.assertCurrent();
      run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=ustar', '-czf', join(releaseStage.path, 'browser-driver.tar.gz'), '-C', staging, 'playwright-core']);
      publishArchive('browser-driver.tar.gz');
    }
  }
  run('git', ['diff', '--exit-code', 'HEAD']);
  for (const assertCurrent of retainedReleaseSources) assertCurrent();
  publishBytes(`suite-release-source-${target}.json`, Buffer.from(JSON.stringify({ schema: 1, tag, sourceCommit: source, target, files }, null, 2) + '\n'));
  for (const assertCurrent of retainedReleaseSources) assertCurrent();
  releaseStage.cleanup();
  console.log(JSON.stringify({ tag, sourceCommit: source, target, files: Object.keys(files) }));
} catch (error) {
  for (const original of ownedOutputs.reverse()) { try { original.removeOwned(); } catch { /* never remove later foreign outputs */ } }
  try { releaseStage.cleanup(); } catch { /* preserve a replaced staging directory */ }
  throw error;
}
