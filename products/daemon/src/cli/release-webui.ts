/** Refresh only the release installer's owned WebUI after a daemon update. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readTarGzEntries } from '@goodvibes-jev/engine/sdk/platform/browser';
import { parseChecksumFile, sha256, verifyChecksum } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';

export interface ReleaseWebUiOptions {
  readonly execPath: string;
  readonly version: string;
  readonly bundleDir: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly fetchImpl?: typeof fetch;
}

export async function refreshReleaseWebUi(options: ReleaseWebUiOptions): Promise<string | undefined> {
  const { version, execPath, bundleDir } = options;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) || !isAbsolute(bundleDir)) return;
  const root = join(dirname(execPath), 'webui');
  const previous = relative(root, bundleDir);
  // Custom/source bundles are host-managed. Never adopt or overwrite one.
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(previous)) return;
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) return;
  if (lstatSync(bundleDir).isSymbolicLink()) throw new Error('Release WebUI directory is a symlink');
  const target = join(root, version);
  const assertCurrent = () => { options.signal.throwIfAborted(); options.assertCurrent(); };
  assertCurrent();
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory() || !existsSync(join(target, 'index.html'))) throw new Error('Release WebUI target is incomplete');
    return target === bundleDir ? undefined : target;
  }
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `https://github.com/mgd34msu/goodvibes-jev/releases/download/v${version}`;
  async function download(name: string, limit: number): Promise<Buffer> {
    assertCurrent();
    const response = await fetchImpl(`${base}/${name}`, { signal, redirect: 'follow' });
    assertCurrent();
    if (!response.ok || !response.body) throw new Error('Release WebUI download is unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const next = await reader.read(); assertCurrent();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > limit) throw new Error('Release WebUI download exceeds its size limit');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  const checksums = parseChecksumFile((await download('SHA256SUMS.txt', 1024 * 1024)).toString('utf8'));
  const name = `goodvibes-webui-bundle-${version}.tar.gz`;
  const archive = await download(name, 64 * 1024 * 1024);
  verifyChecksum(name, sha256(archive), checksums.get(name));
  const entries = [...readTarGzEntries(archive, { strict: true, maxOutputLength: 256 * 1024 * 1024 })];
  const seen = new Set<string>();
  for (const entry of entries) {
    const path = entry.path.replace(/\/$/, '');
    if (seen.has(path) || entry.kind === 'other' || !path.startsWith('goodvibes-webui/') && path !== 'goodvibes-webui'
      || path.split('/').some(part => part === '..' || part === '.' || part.includes('\\'))) throw new Error('Release WebUI archive is invalid');
    seen.add(path);
  }
  if (!entries.some(entry => entry.path === 'goodvibes-webui/index.html' && entry.kind === 'file')) throw new Error('Release WebUI has no index');
  assertCurrent();
  const staging = mkdtempSync(join(root, '.incoming-'));
  try {
    for (const entry of entries) {
      const path = resolve(staging, entry.path);
      if (!path.startsWith(staging + sep)) throw new Error('Release WebUI archive escapes staging');
      if (entry.kind === 'directory') mkdirSync(path, { recursive: true });
      else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, entry.data, { flag: 'wx', mode: 0o644 }); }
    }
    assertCurrent();
    renameSync(join(staging, 'goodvibes-webui'), target);
    return target;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
