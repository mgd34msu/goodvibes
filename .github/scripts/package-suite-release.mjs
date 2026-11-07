// Runs on release builders. End-user installation only downloads these files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';

const [target, destination, tag] = process.argv.slice(2);
assert(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].includes(target));
assert(/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag));
const root = process.cwd();
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], timeout: 300_000 }).toString().trim();
const source = run('git', ['rev-parse', 'HEAD']);
assert.equal(JSON.parse(readFileSync('package.json')).version, tag.slice(1));
run('git', ['diff', '--exit-code', 'HEAD']);
mkdirSync(destination, { recursive: true });
const files = {};
const put = (path, name = basename(path)) => {
  const bytes = readFileSync(path);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (files[name]) assert.equal(files[name].sha256, hash, 'Product addon bytes differ');
  else {
    cpSync(path, join(destination, name));
    files[name] = { sha256: hash, size: bytes.length };
  }
};
const [platform, arch] = target.split('-');
assert.equal(process.platform, platform); assert.equal(process.arch, arch);
const suffix = `${platform === 'darwin' ? 'macos' : platform}-${arch}`;
for (const [product, command, output] of [['tui', 'goodvibes', 'dist'], ['agent', 'goodvibes-agent', 'dist'], ['daemon', 'goodvibes-daemon', 'native']]) {
  run('bun', ['run', product === 'tui' ? 'build' : 'build:binary', '--target', target], join(root, 'products', product));
  const directory = join(root, 'products', product, output);
  const binary = join(directory, `${command}-${suffix}`);
  assert.equal(run(binary, ['--version']), `${command} ${tag.slice(1)}`);
  put(binary);
  if (platform === 'linux') for (const ending of ['.bun', '.bun.json', '.bun.LICENSE.md']) put(binary + ending);
  const extension = platform === 'linux' ? 'so' : 'dylib';
  put(join(directory, `lib/sqlite-vec-${target}/vec0.${extension}`), `sqlite-vec-${target}.${extension}`);
}
const addonStage = join(destination, '.addon');
const addonRelative = `lib/sqlite-vec-${target}/vec0.${platform === 'linux' ? 'so' : 'dylib'}`;
mkdirSync(dirname(join(addonStage, addonRelative)), { recursive: true });
try {
  cpSync(join(destination, `sqlite-vec-${target}.${platform === 'linux' ? 'so' : 'dylib'}`), join(addonStage, addonRelative));
  const archive = `sqlite-vec-${target}.tar.gz`;
  run('tar', ['-czf', join(resolve(destination), archive), '-C', addonStage, addonRelative]);
  const bytes = readFileSync(join(destination, archive));
  files[archive] = {sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
} finally { rmSync(addonStage, {recursive:true,force:true}); }
if (target === 'linux-x64') {
  run('bun', ['run', 'build'], join(root, 'products/webui'));
  run('bun', ['scripts/pack-bundle.ts', '--out', destination, '--version', tag.slice(1)], join(root, 'products/webui'));
  rmSync(join(destination, 'SHA256SUMS.txt'), { force: true });
  const bundle = `goodvibes-webui-bundle-${tag.slice(1)}.tar.gz`;
  const bytes = readFileSync(join(destination, bundle));
  files[bundle] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  const staging = join(destination, '.browser'); mkdirSync(staging);
  try {
    const require = createRequire(join(root, 'packages/engine/package.json'));
    const driver = dirname(require.resolve('playwright-core/package.json'));
    for (const name of ['package.json', 'index.js', 'cli.js']) assert(existsSync(join(driver, name)));
    cpSync(driver, join(staging, 'playwright-core'), { recursive: true, dereference: true });
    run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=ustar', '-czf', join(resolve(destination), 'browser-driver.tar.gz'), '-C', staging, 'playwright-core']);
    const driverBytes = readFileSync(join(destination, 'browser-driver.tar.gz'));
    files['browser-driver.tar.gz'] = { sha256: createHash('sha256').update(driverBytes).digest('hex'), size: driverBytes.length };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
run('git', ['diff', '--exit-code', 'HEAD']);
writeFileSync(join(destination, `suite-release-source-${target}.json`), JSON.stringify({ schema: 1, tag, sourceCommit: source, target, files }, null, 2) + '\n');
console.log(JSON.stringify({ tag, sourceCommit: source, target, files: Object.keys(files) }));
