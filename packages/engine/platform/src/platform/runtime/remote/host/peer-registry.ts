import { HandlerSqliteStore } from '../../../state/daemon-handler-sqlite-store.js';
import { isValidSecretReference } from '../../../config/secret-refs.js';

// Remote backends resolve this scheme only: a `goodvibes://` value that is not
// a well-formed secret reference is refused at registration.
function isMalformedGoodVibesSecretReferenceValue(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://') && !isValidSecretReference(normalized);
}

// ---------------------------------------------------------------------------
// Backend vocabulary + per-backend config shapes
// ---------------------------------------------------------------------------

export type BackendKind = 'docker' | 'ssh' | 'cloud-terminal' | 'local-process';

export type CloudProvider = 'gcp' | 'aws' | 'azure';

export interface DockerBackendConfig {
  containerName: string;
  /**
   * Optional Docker host. When it points at a remote daemon over TLS this MUST
   * be a goodvibes://secrets/ reference (never a raw URL with embedded creds).
   * A bare local socket path (unix://...) or tcp host without credentials is
   * also accepted.
   */
  dockerHost?: string;
}

export interface SshBackendConfig {
  sshHost: string;
  sshPort?: number;
  sshUser: string;
  /** goodvibes://secrets/ reference to the private key, never the raw key. */
  identityRef: string;
}

export interface CloudTerminalBackendConfig {
  provider: CloudProvider;
  projectId?: string;
  /** goodvibes://secrets/ reference to the provider credential. */
  credentialRef: string;
  /** Optional zone/region/location passed to the provider CLI. */
  location?: string;
  /** For gcp: the Cloud Shell / VM instance to target. */
  instance?: string;
}

export interface LocalProcessBackendConfig {
  /** Optional working directory for spawned processes. */
  cwd?: string;
  /** Optional allowlist of executables; when set, only these may be invoked. */
  allowedCommands?: string[];
}

export type BackendConfig =
  | ({ kind: 'docker' } & DockerBackendConfig)
  | ({ kind: 'ssh' } & SshBackendConfig)
  | ({ kind: 'cloud-terminal' } & CloudTerminalBackendConfig)
  | ({ kind: 'local-process' } & LocalProcessBackendConfig);

export interface PeerRecord {
  peerId: string;
  displayName: string;
  backendKind: BackendKind;
  backendConfig: BackendConfig;
}

export interface PeerRegistrationInput {
  peerId: string;
  displayName: string;
  backendKind: BackendKind;
  // Raw, untrusted config from the operator method body. Normalized + validated.
  backendConfig: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Validation helpers, backendConfig must hold ONLY secret refs for any
// credential-bearing field. Raw secrets are rejected outright.
// ---------------------------------------------------------------------------

/** A registration the caller has to correct; a route answers it as a 400 with this code. */
class PeerRegistryValidationError extends Error {
  readonly status = 400;
  readonly code = 'REMOTE_BACKEND_INVALID_CONFIG';
  constructor(message: string) {
    super(message);
    this.name = 'PeerRegistryValidationError';
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PeerRegistryValidationError(`Field '${field}' is required and must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new PeerRegistryValidationError(`Field '${field}' must be a string when provided.`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * A value the backend hands to docker or a cloud CLI as its own argument (a
 * container, instance, project or location). One that starts with "-" would be
 * read by that CLI as an option rather than a name (`--privileged`,
 * `--zone=...`), so it is refused when the backend is registered.
 */
function refuseOptionShaped<T extends string | undefined>(value: T, field: string): T {
  if (typeof value === 'string' && value.startsWith('-')) {
    throw new PeerRegistryValidationError(
      `Field '${field}' cannot start with "-": the CLI that receives it would read it as an option, not a name.`,
    );
  }
  return value;
}

/** Backend ids name a path segment and a peer, so they keep to a plain, bounded spelling. */
const BACKEND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requireSecretRef(value: unknown, field: string): string {
  const ref = requireString(value, field);
  if (!isValidSecretReference(ref)) {
    throw new PeerRegistryValidationError(
      `Field '${field}' must be a goodvibes://secrets/ reference, not a raw credential.`,
    );
  }
  return ref;
}

function assertDockerHostSafe(value: string | undefined, field: string): void {
  // A dockerHost is accepted in exactly two shapes, mirroring how docker.ts
  // resolves it (docker.ts: `startsWith('goodvibes://') ? resolveRef(...) : raw`):
  //   1. A goodvibes://secrets/ reference, resolved from the credential store.
  //   2. A credential-free local/plain address (unix:// socket, or a bare
  //      tcp/host with no embedded userinfo), used verbatim.
  // Enforcement here must match that resolution so no credential-bearing or
  // unresolvable value slips through to docker.ts.
  if (value === undefined) return;

  // A valid secret ref is always allowed: docker.ts resolves it from the store.
  if (isValidSecretReference(value)) return;

  // A `goodvibes://` value that is NOT a well-formed secret ref would be handed
  // to credentials.resolveRef() and fail opaquely (REMOTE_BACKEND_CREDENTIAL_MISSING)
  //, or, worse, a near-miss could be treated as a literal host. Reject it at
  // registration so the misconfiguration surfaces immediately.
  if (isMalformedGoodVibesSecretReferenceValue(value)) {
    throw new PeerRegistryValidationError(
      `Field '${field}' looks like a goodvibes:// reference but is malformed; use a valid goodvibes://secrets/ reference.`,
    );
  }

  // Embedded userinfo credentials (e.g. tcp://user:pass@host) must never be
  // stored raw, docker.ts would pass them verbatim as DOCKER_HOST.
  if (value.includes('@')) {
    throw new PeerRegistryValidationError(
      `Field '${field}' appears to embed credentials; pass a goodvibes://secrets/ reference instead.`,
    );
  }

  // A remote daemon reached over TLS carries its credentials out-of-band and
  // MUST be referenced through the credential store, never pinned as a raw
  // host string the daemon would use unauthenticated. docker.ts only treats a
  // goodvibes:// value as a secret, so a raw `https://`/`tcp+tls://` endpoint
  // here would bypass credential resolution entirely.
  const lowered = value.toLowerCase();
  if (lowered.startsWith('https://') || lowered.startsWith('tcp+tls://')) {
    throw new PeerRegistryValidationError(
      `Field '${field}' points at a TLS Docker daemon; pass a goodvibes://secrets/ reference instead of a raw URL.`,
    );
  }
}

/** Normalize + validate raw backendConfig into a typed, ref-only BackendConfig. */
export function normalizeBackendConfig(
  backendKind: BackendKind,
  raw: Record<string, unknown>,
): BackendConfig {
  switch (backendKind) {
    case 'docker': {
      const dockerHost = optionalString(raw.dockerHost, 'dockerHost');
      assertDockerHostSafe(dockerHost, 'dockerHost');
      return {
        kind: 'docker',
        containerName: refuseOptionShaped(requireString(raw.containerName, 'containerName'), 'containerName'),
        ...(dockerHost !== undefined ? { dockerHost } : {}),
      };
    }
    case 'ssh': {
      const portValue = raw.sshPort;
      let sshPort: number | undefined;
      if (portValue !== undefined && portValue !== null) {
        const parsed = typeof portValue === 'number' ? portValue : Number(portValue);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
          throw new PeerRegistryValidationError("Field 'sshPort' must be an integer between 1 and 65535.");
        }
        sshPort = parsed;
      }
      return {
        kind: 'ssh',
        sshHost: requireString(raw.sshHost, 'sshHost'),
        sshUser: requireString(raw.sshUser, 'sshUser'),
        identityRef: requireSecretRef(raw.identityRef, 'identityRef'),
        ...(sshPort !== undefined ? { sshPort } : {}),
      };
    }
    case 'cloud-terminal': {
      const provider = requireString(raw.provider, 'provider');
      if (provider !== 'gcp' && provider !== 'aws' && provider !== 'azure') {
        throw new PeerRegistryValidationError("Field 'provider' must be one of 'gcp' | 'aws' | 'azure'.");
      }
      const projectId = refuseOptionShaped(optionalString(raw.projectId, 'projectId'), 'projectId');
      const location = refuseOptionShaped(optionalString(raw.location, 'location'), 'location');
      const instance = refuseOptionShaped(optionalString(raw.instance, 'instance'), 'instance');
      return {
        kind: 'cloud-terminal',
        provider,
        credentialRef: requireSecretRef(raw.credentialRef, 'credentialRef'),
        ...(projectId !== undefined ? { projectId } : {}),
        ...(location !== undefined ? { location } : {}),
        ...(instance !== undefined ? { instance } : {}),
      };
    }
    case 'local-process': {
      const cwd = optionalString(raw.cwd, 'cwd');
      let allowedCommands: string[] | undefined;
      if (raw.allowedCommands !== undefined && raw.allowedCommands !== null) {
        if (!Array.isArray(raw.allowedCommands)) {
          throw new PeerRegistryValidationError("Field 'allowedCommands' must be an array of strings.");
        }
        const list = raw.allowedCommands
          .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
          .filter((entry) => entry.length > 0);
        allowedCommands = list;
      }
      return {
        kind: 'local-process',
        ...(cwd !== undefined ? { cwd } : {}),
        ...(allowedCommands !== undefined ? { allowedCommands } : {}),
      };
    }
    default:
      throw new PeerRegistryValidationError(`Unknown backendKind: ${String(backendKind)}`);
  }
}

// ---------------------------------------------------------------------------
// Peer registry, persisted via HandlerSqliteStore (peer-registry.sqlite)
// ---------------------------------------------------------------------------

const PEER_REGISTRY_FILE = 'peer-registry.sqlite';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS peers (
     peerId TEXT PRIMARY KEY,
     displayName TEXT NOT NULL,
     backendKind TEXT NOT NULL,
     backendConfig TEXT NOT NULL
   )`,
];

interface PeerRow {
  peerId: string;
  displayName: string;
  backendKind: string;
  backendConfig: string;
}

// Typed ReadonlySet<string> (not ReadonlySet<BackendKind>) so isBackendKind
// below can call .has() with a plain string and let the function's own `value
// is BackendKind` signature do the narrowing, instead of casting the set.
const VALID_BACKEND_KINDS: ReadonlySet<string> = new Set<BackendKind>([
  'docker',
  'ssh',
  'cloud-terminal',
  'local-process',
]);

/** True when `value` is one of the four known backend kinds; narrows to BackendKind. */
function isBackendKind(value: string): value is BackendKind {
  return VALID_BACKEND_KINDS.has(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turn a stored row back into a typed PeerRecord. backendConfig is written
 * only by register() through normalizeBackendConfig(), but a row read back
 * from disk is untrusted the same way a fresh registration's raw input is: a
 * hand-edited database file, a row left over from a schema this file no
 * longer writes, or on-disk corruption can all put something here that was
 * never actually normalized. Re-running it through normalizeBackendConfig
 * catches that at the read boundary instead of handing a malformed object to
 * a caller that assumes register()'s guarantees already hold.
 */
function rowToRecord(row: PeerRow): PeerRecord {
  if (!isBackendKind(row.backendKind)) {
    throw new PeerRegistryValidationError(
      `Peer '${row.peerId}' has an unknown backendKind '${row.backendKind}'; the row is corrupt or from an unsupported version.`,
    );
  }
  const backendKind = row.backendKind;

  let raw: unknown;
  try {
    raw = JSON.parse(row.backendConfig);
  } catch {
    throw new PeerRegistryValidationError(
      `Peer '${row.peerId}' has a backendConfig that is not valid JSON; the row is corrupt.`,
    );
  }
  if (!isPlainObject(raw)) {
    throw new PeerRegistryValidationError(
      `Peer '${row.peerId}' has a backendConfig that is not an object; the row is corrupt.`,
    );
  }

  return {
    peerId: row.peerId,
    displayName: row.displayName,
    backendKind,
    backendConfig: normalizeBackendConfig(backendKind, raw),
  };
}

export class PeerRegistry {
  private readonly store: HandlerSqliteStore;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private generation = 0;

  constructor(workingDirectory: string) {
    this.store = new HandlerSqliteStore({
      workingDirectory,
      fileName: PEER_REGISTRY_FILE,
      schema: SCHEMA,
    });
  }

  get dbPath(): string {
    return this.store.dbPath;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    const generation = this.generation;
    const pending = this.store.init().then(() => {
      // Opened on first use. A close that lands while the file is opening must
      // not leave a reopened live store behind.
      if (generation !== this.generation) {
        this.store.close();
        throw new Error('PeerRegistry closed during initialization.');
      }
      this.initialized = true;
    }, (error: unknown) => {
      // Native storage is terminal after close. Preserve the registry's own
      // retired-generation boundary even if its native init rejects first.
      if (generation !== this.generation) throw new Error('PeerRegistry closed during initialization.', { cause: error });
      throw error;
    });
    this.initPromise = pending;
    try {
      await pending;
    } finally {
      if (this.initPromise === pending) this.initPromise = null;
    }
  }

  private requireInit(): void {
    if (!this.initialized) {
      throw new Error('PeerRegistry not initialized: call init() first.');
    }
  }

  /** Register (upsert) a peer. Validates + normalizes backendConfig to refs-only. */
  async register(input: PeerRegistrationInput): Promise<PeerRecord> {
    this.requireInit();
    const peerId = requireString(input.peerId, 'peerId');
    if (!BACKEND_ID_PATTERN.test(peerId)) {
      throw new PeerRegistryValidationError(
        "Field 'peerId' must start with a letter or digit and use only letters, digits, '.', '_', ':' or '-' (at most 128 characters).",
      );
    }
    const displayName = requireString(input.displayName, 'displayName');
    if (!VALID_BACKEND_KINDS.has(input.backendKind)) {
      throw new PeerRegistryValidationError(`Unknown backendKind: ${String(input.backendKind)}`);
    }
    const backendConfig = normalizeBackendConfig(input.backendKind, input.backendConfig ?? {});
    const serialized = JSON.stringify(backendConfig);
    this.store.run(
      `INSERT INTO peers (peerId, displayName, backendKind, backendConfig)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(peerId) DO UPDATE SET
         displayName = excluded.displayName,
         backendKind = excluded.backendKind,
         backendConfig = excluded.backendConfig`,
      [peerId, displayName, input.backendKind, serialized],
    );
    return { peerId, displayName, backendKind: input.backendKind, backendConfig };
  }

  /** Look up a peer by id. Returns null when not registered. */
  get(peerId: string): PeerRecord | null {
    this.requireInit();
    const row = this.store.get<PeerRow>(
      'SELECT peerId, displayName, backendKind, backendConfig FROM peers WHERE peerId = ?',
      [peerId],
    );
    return row ? rowToRecord(row) : null;
  }

  /**
   * Every registered backend (config holds only secret references). A row that
   * no longer reads as a valid registration is named in `unreadable` with the
   * reason, instead of hiding the others or vanishing from the list.
   */
  list(): { readonly backends: PeerRecord[]; readonly unreadable: { readonly peerId: string; readonly reason: string }[] } {
    this.requireInit();
    const rows = this.store.all<PeerRow>(
      'SELECT peerId, displayName, backendKind, backendConfig FROM peers ORDER BY peerId ASC',
    );
    const backends: PeerRecord[] = [];
    const unreadable: { peerId: string; reason: string }[] = [];
    for (const row of rows) {
      try { backends.push(rowToRecord(row)); }
      catch (error) { unreadable.push({ peerId: row.peerId, reason: error instanceof Error ? error.message : String(error) }); }
    }
    return { backends, unreadable };
  }

  /**
   * Remove a peer. Returns true when a row was deleted. Existence is checked
   * without row validation so a corrupt row (which get() rejects) can still
   * be removed.
   */
  async remove(peerId: string): Promise<boolean> {
    this.requireInit();
    const row = this.store.all<{ peerId: string }>(
      'SELECT peerId FROM peers WHERE peerId = ?',
      [peerId],
    );
    const existed = row.length > 0;
    if (existed) {
      this.store.run('DELETE FROM peers WHERE peerId = ?', [peerId]);
    }
    return existed;
  }

  close(): void {
    this.generation += 1;
    this.initialized = false;
    this.store.close();
  }
}

export { PeerRegistryValidationError };
