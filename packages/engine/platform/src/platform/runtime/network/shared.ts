import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { isLoopbackHost } from '@goodvibes/engine/transport-http/paths';
const PEM_EXTENSIONS = new Set(['.pem', '.crt', '.cer']);

export interface NetworkRootConfig {
  getControlPlaneConfigDir(): string;
}

export function getGoodVibesRootDir(configManager: NetworkRootConfig): string {
  const configuredDir = configManager.getControlPlaneConfigDir();
  return resolve(configuredDir);
}

export function getDefaultCertDirectory(configManager: NetworkRootConfig): string {
  return join(getGoodVibesRootDir(configManager), 'certs');
}

export function getDefaultInboundCertPaths(configManager: NetworkRootConfig): {
  readonly certFile: string;
  readonly keyFile: string;
} {
  const certDir = getDefaultCertDirectory(configManager);
  return {
    certFile: join(certDir, 'fullchain.pem'),
    keyFile: join(certDir, 'privkey.pem'),
  };
}

export function resolvePathFromGoodVibesRoot(
  value: string | null | undefined,
  configManager: NetworkRootConfig,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return isAbsolute(trimmed)
    ? trimmed
    : resolve(getGoodVibesRootDir(configManager), trimmed);
}

export function readPemEntriesFromDirectory(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && PEM_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(path, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

/** Whether a hostname is this machine; the rule is `isLoopbackHost` in the transport. */
export function isLocalHostname(hostname: string): boolean {
  return isLoopbackHost(hostname);
}

/**
 * The client address a trusted reverse proxy reported.
 *
 * `X-Forwarded-For` lists addresses left to right, and each proxy appends the
 * peer it saw. Only the entries a trusted proxy appended can be believed: the
 * leftmost entries are whatever the client sent, so reading the first one lets
 * any caller pick the address that rate limiting and the audit log record.
 * `trustedProxyHops` is how many proxies in front of the daemon append to the
 * header (default 1); the address is the entry that many positions from the
 * right. A header with fewer entries than that did not pass through every
 * trusted proxy, so no address is returned and the caller falls back to the
 * socket peer. `X-Real-IP` is not read: nothing guarantees the proxy overwrites
 * it, and a client can send its own.
 */
export function extractForwardedClientIp(req: Request, trustProxy: boolean, trustedProxyHops = 1): string | undefined {
  if (!trustProxy) return undefined;
  const hops = Number.isInteger(trustedProxyHops) && trustedProxyHops >= 1 ? trustedProxyHops : 1;
  const entries = (req.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (entries.length < hops) return undefined;
  return entries[entries.length - hops];
}

export function inspectPrivateKeyPermissions(path: string): {
  readonly available: boolean;
  readonly safe?: boolean | undefined;
  readonly mode?: string | undefined;
} {
  if (!existsSync(path) || process.platform === 'win32') {
    return { available: false };
  }
  const stat = statSync(path);
  const mode = stat.mode & 0o777;
  return {
    available: true,
    safe: (mode & 0o077) === 0,
    mode: `0${mode.toString(8)}`,
  };
}
