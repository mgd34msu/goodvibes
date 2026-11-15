/**
 * Installs language-server binaries into the user's own bin directory, when the
 * owner asks for it (`/intelligence install`). A code lookup never calls this:
 * a missing server is reported to the caller with the command that installs it.
 *
 * rust-analyzer is downloaded from its GitHub release and installed only when
 * the publisher's SHA-256 sidecar matches the downloaded bytes. gopls is built
 * with `go install` when Go is on PATH. Every attempt is bounded by the
 * caller's signal and a time limit, and its outcome is remembered by the
 * caller (see LspService.installServer). Never throws.
 */

import { existsSync, mkdirSync, chmodSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { instrumentedFetch } from '../../utils/fetch-with-timeout.js';

/** Platform + arch key for download URL resolution. */
type PlatformKey = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';

function getPlatformKey(): PlatformKey | null {
  const platform = process.platform;
  const arch = process.arch;
  // Windows is not supported, goodvibes-platform targets Linux and macOS only.
  // Windows users would need WSL.

  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  return null;
}

interface BinarySpec {
  /** Binary name (used as filename in the bin directory) */
  name: string;
  /** GitHub repo in owner/repo format */
  repo: string;
  /** Map from PlatformKey to the asset filename pattern in GitHub releases */
  assets: Record<PlatformKey, string>;
  /** Whether the downloaded asset is a gzip file that needs decompression */
  gzip?: boolean | undefined;
}

/**
 * rust-analyzer: Downloads from rust-lang/rust-analyzer GitHub releases.
 * Assets are gzipped single binaries with SHA256 sidecar files for verification.
 *
 * gopls: Not available as prebuilt binary. Installed via `go install` if Go is
 * on PATH, see installGopls(). If Go is not installed, gopls is unavailable.
 */
const BINARY_SPECS: BinarySpec[] = [
  {
    name: 'rust-analyzer',
    repo: 'rust-lang/rust-analyzer',
    assets: {
      'linux-x64': 'rust-analyzer-x86_64-unknown-linux-gnu.gz',
      'linux-arm64': 'rust-analyzer-aarch64-unknown-linux-gnu.gz',
      'darwin-x64': 'rust-analyzer-x86_64-apple-darwin.gz',
      'darwin-arm64': 'rust-analyzer-aarch64-apple-darwin.gz',
    },
    gzip: true,
  },
];

/** Default limit for one install attempt. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 180_000;

/** Commands this module can install. */
export function isInstallableServer(name: string): boolean {
  return name === 'gopls' || BINARY_SPECS.some((spec) => spec.name === name);
}

/** How to install a server by hand, for the message a lookup returns. */
export function manualInstallHint(name: string): string | undefined {
  switch (name) {
    case 'rust-analyzer': return 'rustup component add rust-analyzer';
    case 'gopls': return 'go install golang.org/x/tools/gopls@latest';
    case 'pyright-langserver': return 'npm install -g pyright';
    case 'typescript-language-server': return 'npm install -g typescript-language-server typescript';
    case 'vscode-css-language-server':
    case 'vscode-html-language-server':
    case 'vscode-json-language-server': return 'npm install -g vscode-langservers-extracted';
    case 'bash-language-server': return 'npm install -g bash-language-server';
    default: return undefined;
  }
}

/**
 * Get the path where a binary would be cached.
 */
export function getBinaryPath(binaryDir: string, name: string): string {
  return join(binaryDir, name);
}

export type BinaryInstallResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string; readonly timedOut?: boolean };

function failed(reason: string, timedOut = false): BinaryInstallResult {
  return timedOut ? { ok: false, reason, timedOut } : { ok: false, reason };
}

/**
 * Download a binary from GitHub releases (latest).
 */
async function downloadBinary(binaryDir: string, spec: BinarySpec, signal: AbortSignal): Promise<BinaryInstallResult> {
  const name = spec.name;
  const platformKey = getPlatformKey();
  if (!platformKey) return failed(`${name} has no download for ${process.platform}/${process.arch}`);
  const assetName = spec.assets[platformKey];

  const destPath = getBinaryPath(binaryDir, name);
  if (existsSync(destPath)) return { ok: true, path: destPath };

  logger.info(`BinaryDownloader: downloading ${name} for ${platformKey}...`);
  const tmpPath = `${destPath}.tmp`;

  try {
    const releaseUrl = `https://api.github.com/repos/${spec.repo}/releases/latest`;
    const releaseRes = await instrumentedFetch(releaseUrl, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'goodvibes-platform' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });

    if (!releaseRes.ok) {
      return failed(releaseRes.status === 403 || releaseRes.status === 429
        ? `GitHub refused the release lookup for ${name} (rate limit); try again later or install it yourself`
        : `GitHub answered ${releaseRes.status} for the latest ${name} release`);
    }

    const release = await releaseRes.json() as { assets?: Array<{ name: string; browser_download_url: string }> };
    if (!release || !Array.isArray(release.assets)) return failed(`the latest ${name} release could not be read`);
    const asset = release.assets.find(a => a.name === assetName);
    if (!asset) return failed(`the latest ${name} release has no ${assetName}`);

    // A publisher checksum is required before installing executable bytes.
    const sha256Asset = release.assets.find(a => a.name === assetName + '.sha256');
    if (!sha256Asset) return failed(`the latest ${name} release publishes no checksum, so it was not installed`);
    const sha256Res = await instrumentedFetch(sha256Asset.browser_download_url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      headers: { 'User-Agent': 'goodvibes-platform' },
    });
    if (!sha256Res.ok) return failed(`the ${name} checksum could not be fetched, so it was not installed`);
    const checksum = /^([a-f0-9]{64})(?:[ \t]+\*?([^\r\n]+))?$/i.exec((await sha256Res.text()).trim());
    if (!checksum || !checksum[1] || (checksum[2] !== undefined && checksum[2] !== assetName && checksum[2] !== `./${assetName}`)) {
      return failed(`the ${name} checksum is malformed or names another file, so it was not installed`);
    }
    const expectedHash = checksum[1].toLowerCase();

    const downloadRes = await instrumentedFetch(asset.browser_download_url, {
      signal,
      headers: { 'User-Agent': 'goodvibes-platform' },
    });
    if (!downloadRes.ok) return failed(`the ${name} download failed with ${downloadRes.status}`);

    // Verify the raw bytes before decompressing anything.
    const rawBytes = await downloadRes.arrayBuffer();
    const actualHash = Bun.CryptoHasher.hash('sha256', new Uint8Array(rawBytes), 'hex');
    if (actualHash !== expectedHash) {
      logger.error('BinaryDownloader: release checksum mismatch; installation refused', { name });
      return failed(`the downloaded ${name} does not match its published checksum, so it was not installed`);
    }

    mkdirSync(binaryDir, { recursive: true });
    await Bun.write(tmpPath, spec.gzip ? Bun.gunzipSync(new Uint8Array(rawBytes)) : rawBytes);
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, destPath);

    logger.info(`BinaryDownloader: ${name} downloaded to ${destPath}`);
    return { ok: true, path: destPath };
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch (cleanupError) {
      logger.warn(`BinaryDownloader: failed to remove partial download for ${name}`, {
        path: tmpPath,
        error: summarizeError(cleanupError),
      });
    }
    if (signal.aborted) return failed(`the ${name} install did not finish in time`, true);
    return failed(`the ${name} download failed: ${summarizeError(err)}`);
  }
}

/**
 * Build gopls with `go install` when `go` is on PATH, into the bin directory.
 */
async function installGopls(binaryDir: string, signal: AbortSignal): Promise<BinaryInstallResult> {
  const destPath = getBinaryPath(binaryDir, 'gopls');
  if (existsSync(destPath)) return { ok: true, path: destPath };

  const goPath = Bun.which('go');
  if (!goPath) return failed('Go is not on PATH, so gopls cannot be built');

  logger.info('BinaryDownloader: installing gopls via go install...');
  try {
    mkdirSync(binaryDir, { recursive: true });
    const proc = Bun.spawn([goPath, 'install', 'golang.org/x/tools/gopls@latest'], {
      env: { ...process.env, GOBIN: binaryDir },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const kill = (): void => { proc.kill(); };
    signal.addEventListener('abort', kill, { once: true });
    let exitCode: number;
    let stderr: string;
    try {
      [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    } finally {
      signal.removeEventListener('abort', kill);
    }
    if (signal.aborted) return failed('the gopls install did not finish in time', true);
    if (exitCode !== 0) return failed(`go install gopls exited ${exitCode}: ${stderr.trim().slice(-300)}`);
    if (existsSync(destPath)) {
      logger.info(`BinaryDownloader: gopls installed to ${destPath}`);
      return { ok: true, path: destPath };
    }
    return failed('go install finished but gopls is not in the bin directory');
  } catch (err) {
    return failed(`the gopls install failed: ${summarizeError(err)}`);
  }
}

/**
 * Install a language-server binary, bounded by `signal` and `timeoutMs`.
 */
export async function installServerBinary(
  binaryDir: string,
  name: string,
  options: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {},
): Promise<BinaryInstallResult> {
  const cached = getBinaryPath(binaryDir, name);
  if (existsSync(cached)) return { ok: true, path: cached };
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  if (name === 'gopls') return installGopls(binaryDir, signal);
  const spec = BINARY_SPECS.find((candidate) => candidate.name === name);
  if (!spec) return failed(`${name} cannot be installed automatically`);
  return downloadBinary(binaryDir, spec, signal);
}

/**
 * Ensure a binary is available, installing it if needed.
 * Returns the path to the binary, or null if unavailable.
 */
export async function ensureBinary(
  binaryDir: string,
  name: string,
  options: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {},
): Promise<string | null> {
  const result = await installServerBinary(binaryDir, name, options);
  if (result.ok) return result.path;
  logger.warn('BinaryDownloader: install did not complete', { name, reason: result.reason });
  return null;
}
