import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Read-only shell inspection; unset display values have explicit defaults. */
export interface InspectableDomain {
  readonly name: string;
  getState(): Record<string, unknown>;
  getRevision(): number;
  getLastUpdatedAt(): number;
}

export type InboundTlsMode = 'off' | 'proxy' | 'direct';
export type InboundServerSurface = 'controlPlane' | 'httpListener';

export interface InboundTlsSnapshot {
  readonly surface: InboundServerSurface;
  readonly host: string;
  readonly port: number;
  readonly mode: InboundTlsMode;
  readonly scheme: 'http' | 'https';
  readonly trustProxy: boolean;
  readonly certFile?: string | undefined;
  readonly keyFile?: string | undefined;
  readonly usingDefaultPaths: boolean;
  readonly ready: boolean;
  readonly errors: readonly string[];
  readonly keyPermissions?: {
    readonly available: boolean;
    readonly safe?: boolean | undefined;
    readonly mode?: string | undefined;
  };
}

interface InboundTlsConfigReader {
  get(path: string): unknown;
  getControlPlaneConfigDir(): string;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function resolveGoodVibesRoot(configManager: Pick<InboundTlsConfigReader, 'getControlPlaneConfigDir'>): string {
  return resolve(configManager.getControlPlaneConfigDir());
}

function resolvePathFromGoodVibesRoot(value: string | null | undefined, configManager: Pick<InboundTlsConfigReader, 'getControlPlaneConfigDir'>): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) return trimmed;
  return resolve(resolveGoodVibesRoot(configManager), trimmed);
}

function getDefaultInboundCertPaths(configManager: Pick<InboundTlsConfigReader, 'getControlPlaneConfigDir'>): { readonly certFile: string; readonly keyFile: string } {
  const certDir = join(resolveGoodVibesRoot(configManager), 'certs');
  return {
    certFile: join(certDir, 'fullchain.pem'),
    keyFile: join(certDir, 'privkey.pem'),
  };
}

function inspectPrivateKeyPermissions(path: string): { readonly available: boolean; readonly safe?: boolean | undefined; readonly mode?: string | undefined } {
  try {
    const stats = statSync(path);
    if (process.platform === 'win32') return { available: true };
    const mode = stats.mode & 0o777;
    return {
      available: true,
      safe: (mode & 0o077) === 0,
      mode: mode.toString(8).padStart(4, '0'),
    };
  } catch {
    return { available: false };
  }
}

export function extractForwardedClientIp(req: Request, trustProxy: boolean): string | undefined {
  if (!trustProxy) return undefined;
  const forwardedFor = req.headers.get('x-forwarded-for');
  const firstForwarded = forwardedFor?.split(',')[0]?.trim();
  if (firstForwarded) return firstForwarded;
  return req.headers.get('x-real-ip')?.trim() || undefined;
}

export function inspectInboundTls(configManager: InboundTlsConfigReader, surface: InboundServerSurface): InboundTlsSnapshot {
  const prefix = surface === 'controlPlane' ? 'controlPlane' : 'httpListener';
  const defaultPort = surface === 'controlPlane' ? 3421 : 3422;
  const mode = (readString(configManager.get(`${prefix}.tls.mode`)) || 'off') as InboundTlsMode;
  const trustProxy = readBoolean(configManager.get(`${prefix}.trustProxy`));
  const host = readString(configManager.get(`${prefix}.host`)) || '127.0.0.1';
  const port = readNumber(configManager.get(`${prefix}.port`), defaultPort);
  const defaults = getDefaultInboundCertPaths(configManager);
  const explicitCert = resolvePathFromGoodVibesRoot(readString(configManager.get(`${prefix}.tls.certFile`)), configManager);
  const explicitKey = resolvePathFromGoodVibesRoot(readString(configManager.get(`${prefix}.tls.keyFile`)), configManager);
  const certFile = explicitCert ?? defaults.certFile;
  const keyFile = explicitKey ?? defaults.keyFile;
  const usingDefaultPaths = explicitCert === null && explicitKey === null;
  const errors: string[] = [];

  if (mode === 'direct') {
    if (!existsSync(certFile)) errors.push(`Certificate file not found: ${certFile}`);
    if (!existsSync(keyFile)) errors.push(`Private key file not found: ${keyFile}`);
  }

  const keyPermissions = mode === 'direct' ? inspectPrivateKeyPermissions(keyFile) : undefined;
  return {
    surface,
    host,
    port,
    mode,
    scheme: mode === 'off' ? 'http' : 'https',
    trustProxy,
    ...(mode === 'direct' ? { certFile, keyFile } : {}),
    usingDefaultPaths,
    ready: mode === 'off' || mode === 'proxy' || errors.length === 0,
    errors,
    ...(keyPermissions ? { keyPermissions } : {}),
  };
}
