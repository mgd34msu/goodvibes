import { existsSync } from 'node:fs';
import { getDefaultInboundCertPaths, inspectPrivateKeyPermissions, resolvePathFromGoodVibesRoot } from './shared.js';

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

export interface ResolvedInboundTlsContext extends InboundTlsSnapshot {
  readonly tls?: Bun.TLSOptions | undefined;
}

export interface InboundTlsConfigReader {
  get(path: string): unknown;
  getControlPlaneConfigDir(): string;
}

const TLS_MODES: readonly InboundTlsMode[] = ['off', 'proxy', 'direct'];

function readMode(configManager: InboundTlsConfigReader, surface: InboundServerSurface): string {
  const raw = configManager.get(`${surface}.tls.mode`);
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value || 'off';
}

function readTrustProxy(configManager: InboundTlsConfigReader, surface: InboundServerSurface): boolean {
  return configManager.get(`${surface}.trustProxy`) === true;
}

function readHost(configManager: InboundTlsConfigReader, surface: InboundServerSurface): string {
  const raw = configManager.get(`${surface}.host`);
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '127.0.0.1';
}

function readPort(configManager: InboundTlsConfigReader, surface: InboundServerSurface): number {
  const raw = configManager.get(`${surface}.port`);
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : surface === 'controlPlane' ? 3421 : 3422;
}

function readConfiguredCertPath(configManager: InboundTlsConfigReader, surface: InboundServerSurface): string | null {
  return resolvePathFromGoodVibesRoot(
    (surface === 'controlPlane'
      ? configManager.get('controlPlane.tls.certFile')
      : configManager.get('httpListener.tls.certFile')) as string | null | undefined,
    configManager,
  );
}

function readConfiguredKeyPath(configManager: InboundTlsConfigReader, surface: InboundServerSurface): string | null {
  return resolvePathFromGoodVibesRoot(
    (surface === 'controlPlane'
      ? configManager.get('controlPlane.tls.keyFile')
      : configManager.get('httpListener.tls.keyFile')) as string | null | undefined,
    configManager,
  );
}

export function inspectInboundTls(configManager: InboundTlsConfigReader, surface: InboundServerSurface): InboundTlsSnapshot {
  const mode = readMode(configManager, surface);
  const trustProxy = readTrustProxy(configManager, surface);
  const host = readHost(configManager, surface);
  const port = readPort(configManager, surface);
  if (!TLS_MODES.includes(mode as InboundTlsMode)) {
    // An unrecognised value must not read as "plain http, ready": the operator
    // asked for some TLS setup and would be served none.
    return {
      surface,
      host,
      port,
      mode: 'off',
      scheme: 'http',
      trustProxy,
      usingDefaultPaths: false,
      ready: false,
      errors: [`Unknown ${surface}.tls.mode '${mode}'; expected one of ${TLS_MODES.join(', ')}`],
    };
  }
  if (mode !== 'direct') {
    return {
      surface,
      host,
      port,
      mode: mode as InboundTlsMode,
      scheme: mode === 'proxy' ? 'https' : 'http',
      trustProxy,
      usingDefaultPaths: false,
      ready: true,
      errors: [],
    };
  }

  const defaults = getDefaultInboundCertPaths(configManager);
  const certFile = readConfiguredCertPath(configManager, surface) ?? defaults.certFile;
  const keyFile = readConfiguredKeyPath(configManager, surface) ?? defaults.keyFile;
  const usingDefaultPaths = certFile === defaults.certFile && keyFile === defaults.keyFile;
  const errors: string[] = [];
  if (!existsSync(certFile)) errors.push(`Certificate file not found: ${certFile}`);
  if (!existsSync(keyFile)) errors.push(`Private key file not found: ${keyFile}`);
  const keyPermissions = inspectPrivateKeyPermissions(keyFile);
  return {
    surface,
    host,
    port,
    mode: 'direct',
    scheme: 'https',
    trustProxy,
    certFile,
    keyFile,
    usingDefaultPaths,
    ready: errors.length === 0,
    errors,
    keyPermissions,
  };
}

export function resolveInboundTlsContext(configManager: InboundTlsConfigReader, surface: InboundServerSurface): ResolvedInboundTlsContext {
  const snapshot = inspectInboundTls(configManager, surface);
  if (!snapshot.ready && snapshot.mode !== 'direct') {
    throw new Error(`${surface} TLS configuration is invalid: ${snapshot.errors.join('; ')}`);
  }
  if (snapshot.mode !== 'direct') return snapshot;
  if (!snapshot.ready || !snapshot.certFile || !snapshot.keyFile) {
    throw new Error(
      `${surface} direct TLS is enabled but certificate files are not ready: ${snapshot.errors.join('; ')}`,
    );
  }
  return {
    ...snapshot,
    tls: {
      cert: Bun.file(snapshot.certFile),
      key: Bun.file(snapshot.keyFile),
    },
  };
}
