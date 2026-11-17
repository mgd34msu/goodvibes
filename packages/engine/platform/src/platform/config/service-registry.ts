import { assertSecurityReadSource, captureSecurityReadBindings, captureSecurityReadFiles } from '../security/read-source.js';
/**
 * ServiceRegistry, named service credential resolution.
 *
 * Reads service configs from the user's own `~/.goodvibes/<surface>/services.json`.
 * Each service entry declares its authType and the SecretsManager key
 * that holds the credential.
 *
 * A project's `.goodvibes/<surface>/services.json` is repository content, so
 * an entry from it is used only when every credential it names is a key in the
 * user's store: no secret reference of any kind (a reference can run a command
 * or read a file) and no `oauth` block (it would replace a provider's sign-in
 * endpoints). Such an entry is skipped with a warning, and an entry of the
 * user's own file always wins over a project entry of the same name.
 *
 * Example services.json:
 * {
 *   "openai": { "name": "openai", "baseUrl": "https://api.openai.com", "authType": "bearer", "tokenKey": "OPENAI_API_KEY" },
 *   "github":  { "name": "github",  "baseUrl": "https://api.github.com",  "authType": "bearer", "tokenKey": "GITHUB_TOKEN" },
 *   "slack":   { "name": "slack", "authType": "bearer", "tokenKey": "SLACK_BOT_TOKEN", "appTokenKey": "SLACK_APP_TOKEN", "tokenRef": { "source": "vaultwarden", "item": "GoodVibes Slack", "field": "password", "server": "https://vault.example.test" } }
 * }
 */

import { readFileSync } from 'fs';
import { SecretsManager, captureSecretsReadSource } from './secrets.js';
import {
  describeSecretRef,
  isSecretRefInput,
  resolveSecretRef,
  type SecretRefInput,
} from './secret-refs.js';
import { looksLikeSecretRef } from './secret-ref-refusal.js';
import type { OAuthProviderConfig } from './subscriptions.js';
import { SubscriptionManager, captureSubscriptionReadSource } from './subscriptions.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServiceConfig {
  /** Human-readable / lookup name. */
  name: string;
  /** Base URL for the service (informational). */
  baseUrl?: string | undefined;
  /** Auth type used by this service. */
  authType: 'bearer' | 'basic' | 'api-key' | 'oauth';
  /** SecretsManager key that holds the primary credential (token or API key). */
  tokenKey: string;
  /** Optional external/local secret reference for the primary credential. */
  tokenRef?: SecretRefInput | undefined;
  /** For basic auth: SecretsManager key that holds the password. */
  passwordKey?: string | undefined;
  /** Optional external/local secret reference for the basic-auth password. */
  passwordRef?: SecretRefInput | undefined;
  /** Optional provider auth-token key for services that expose token + auth-token credentials. */
  authTokenKey?: string | undefined;
  /** Optional external/local secret reference for provider auth-token credentials. */
  authTokenRef?: SecretRefInput | undefined;
  /** For api-key auth: the header name. Defaults to X-API-Key. */
  apiKeyHeader?: string | undefined;
  /** Optional secret key holding a webhook or callback URL for this service. */
  webhookUrlKey?: string | undefined;
  /** Optional external/local secret reference for a webhook or callback URL. */
  webhookUrlRef?: SecretRefInput | undefined;
  /** Optional secret key for inbound request signing/verification. */
  signingSecretKey?: string | undefined;
  /** Optional external/local secret reference for inbound request signing/verification. */
  signingSecretRef?: SecretRefInput | undefined;
  /** Optional public-key secret used for inbound signature verification. */
  publicKeyKey?: string | undefined;
  /** Optional external/local secret reference for inbound public-key verification. */
  publicKeyRef?: SecretRefInput | undefined;
  /** Optional Slack-style app-level token key used by socket/client runtimes. */
  appTokenKey?: string | undefined;
  /** Optional external/local secret reference for app-level socket/client runtimes. */
  appTokenRef?: SecretRefInput | undefined;
  /** Optional provider ID used for subscription token override lookup. */
  providerId?: string | undefined;
  /** OAuth metadata for subscription-backed services. */
  oauth?: OAuthProviderConfig | undefined;
  /** Path under `baseUrl` a connection test requests, for a service whose root does not answer; default the root. */
  testPath?: string | undefined;
}

export type ServiceSecretField =
  | 'primary'
  | 'password'
  | 'authToken'
  | 'webhookUrl'
  | 'signingSecret'
  | 'publicKey'
  | 'appToken';

export interface ServiceInspection {
  readonly config: ServiceConfig;
  readonly hasPrimaryCredential: boolean;
  readonly hasPasswordCredential: boolean;
  readonly hasAuthTokenCredential: boolean;
  readonly hasWebhookUrl: boolean;
  readonly hasSigningSecret: boolean;
  readonly hasPublicKey: boolean;
  readonly hasAppToken: boolean;
}

export interface ServiceConnectionTestResult {
  readonly ok: boolean;
  /**
   * `connected`: the service answered below 400 with the credential.
   * `credential-refused`: it answered 401 or 403. `reached`: it answered with
   * another status. `unreachable`: no answer. `not-tested`: nothing was sent.
   */
  readonly outcome: 'connected' | 'credential-refused' | 'reached' | 'unreachable' | 'not-tested';
  readonly status: number | null;
  readonly testedUrl: string | null;
  readonly error?: string | undefined;
}

/**
 * Where the registry reads from: the user's own file, and optionally a
 * project's file whose entries are admitted only when they name store keys.
 */
export interface ServiceRegistryFiles {
  readonly user: string;
  readonly project?: string | undefined;
}

export interface ServiceRegistryOptions {
  readonly secretsManager: SecretsManager;
  readonly subscriptionManager: SubscriptionManager;
  /** Withhold private provider errors and reference descriptors from resolution logs. */
  readonly diagnosticMode?: 'default' | 'structural' | undefined;
}

interface ServicesFileRead {
  readonly services: Record<string, ServiceConfig>;
  /** Why the file could not be used, or null when it is absent or readable. */
  readonly problem: string | null;
}

const REFERENCE_FIELDS = ['tokenRef', 'passwordRef', 'authTokenRef', 'webhookUrlRef', 'signingSecretRef', 'publicKeyRef', 'appTokenRef'] as const;
const KEY_FIELDS = ['tokenKey', 'passwordKey', 'authTokenKey', 'webhookUrlKey', 'signingSecretKey', 'publicKeyKey', 'appTokenKey'] as const;

/**
 * Why a project file's entry cannot be used, or null when every credential it
 * names is a plain key in the user's store and it carries no `oauth` block.
 */
function projectEntryRefusal(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'is not an object';
  const record = entry as Record<string, unknown>;
  if (record.oauth !== undefined) return 'carries an oauth block, which only your own services file may set';
  if (REFERENCE_FIELDS.some((field) => record[field] !== undefined)) return 'names a secret reference, which only your own services file may use';
  for (const field of KEY_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || isSecretRefInput(value) || looksLikeSecretRef(value)) return `${field} is not a plain key name in your secret store`;
  }
  return null;
}

function readServicesFile(filePath: string): ServicesFileRead {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { services: {}, problem: null };
    logger.error('ServiceRegistry: failed to read services file, treating as empty', { path: filePath });
    return { services: {}, problem: `could not be read (${code ?? 'unknown error'})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.error('ServiceRegistry: services file is not valid JSON, treating as empty', { path: filePath });
    return { services: {}, problem: 'is not valid JSON' };
  }
  // `null`, an array or a scalar parses fine and would make every lookup throw.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.error('ServiceRegistry: services file is not a JSON object, treating as empty', { path: filePath });
    return { services: {}, problem: 'is not a JSON object keyed by service name' };
  }
  return { services: parsed as Record<string, ServiceConfig>, problem: null };
}

// ---------------------------------------------------------------------------
// ServiceRegistry
// ---------------------------------------------------------------------------

const serviceReadSources = new WeakMap<ServiceRegistry, () => () => void>();
const getServiceReadSources = serviceReadSources.get.bind(serviceReadSources);
const setServiceReadSources = serviceReadSources.set.bind(serviceReadSources);

/** Restriction from the original native owner; a replaced instance method cannot issue it. */
export function captureServiceReadSource(owner: ServiceRegistry): () => void {
  const capture = getServiceReadSources(owner);
  assertSecurityReadSource(capture !== undefined);
  return capture();
}

export class ServiceRegistry {
  captureReadSource(): () => void {
    return captureServiceReadSource(this);
  }
  private readonly servicesFilePath: string;
  private readonly projectServicesFilePath: string | undefined;
  private readonly secretsManager: SecretsManager;
  private readonly subscriptionManager: SubscriptionManager;
  private readonly diagnosticMode: 'default' | 'structural';
  private readonly reportedProjectRefusals = new Set<string>();

  /**
   * `files.user` is the user's own services file. A bare path is read as a
   * project file: only its entries that name store keys are used.
   */
  constructor(files: ServiceRegistryFiles | string, options: ServiceRegistryOptions) {
    const resolved: ServiceRegistryFiles = typeof files === 'string' ? { user: '', project: files } : files;
    this.servicesFilePath = resolved.user;
    this.projectServicesFilePath = resolved.project;
    this.secretsManager = options.secretsManager;
    this.subscriptionManager = options.subscriptionManager;
    this.diagnosticMode = options.diagnosticMode ?? 'default';
    setServiceReadSources(this, () => {
      const binding = captureSecurityReadBindings(this, ['servicesFilePath', 'secretsManager', 'subscriptionManager', 'diagnosticMode', 'getAll', 'get', 'inspect', 'resolveSecret', 'resolveConfiguredSecret', 'captureReadSource']);
      const filesCurrent = captureSecurityReadFiles([this.servicesFilePath, this.projectServicesFilePath].filter((path): path is string => Boolean(path)));
      const secretsCurrent = captureSecretsReadSource(this.secretsManager), subscriptionsCurrent = captureSubscriptionReadSource(this.subscriptionManager);
      return () => { binding(); filesCurrent(); secretsCurrent(); subscriptionsCurrent(); binding(); };
    });
  }

  /**
   * Return all registered service configs.
   */
  getAll(): Record<string, ServiceConfig> {
    const own = this.servicesFilePath ? readServicesFile(this.servicesFilePath).services : {};
    if (!this.projectServicesFilePath) return own;
    const merged: Record<string, ServiceConfig> = {};
    for (const [name, entry] of Object.entries(readServicesFile(this.projectServicesFilePath).services)) {
      const refusal = projectEntryRefusal(entry);
      if (refusal === null) { merged[name] = entry; continue; }
      const id = `${name}\0${refusal}`;
      if (!this.reportedProjectRefusals.has(id)) {
        this.reportedProjectRefusals.add(id);
        logger.warn('ServiceRegistry: skipped a service from the project services file', {
          serviceName: name, path: this.projectServicesFilePath, reason: refusal,
          next: 'add the service to your own services file to use it',
        });
      }
    }
    return Object.assign(merged, own);
  }

  /**
   * Why the services file cannot be used right now, or null when it is absent
   * or fine. An unusable file reads as "no services", which looks the same as
   * an unknown service; this is how a status surface tells them apart.
   */
  unreadableReason(): string | null {
    for (const path of [this.servicesFilePath, this.projectServicesFilePath]) {
      if (!path) continue;
      const { problem } = readServicesFile(path);
      if (problem !== null) return `${path} ${problem}`;
    }
    return null;
  }

  /** The user's own services file, where a service is added. */
  get userServicesFilePath(): string {
    return this.servicesFilePath;
  }

  /**
   * Return the config for a named service, or null if not found.
   */
  get(serviceName: string): ServiceConfig | null {
    const all = this.getAll();
    return Object.hasOwn(all, serviceName) ? (all[serviceName] ?? null) : null;
  }

  private async resolveConfiguredSecret(
    serviceName: string,
    field: ServiceSecretField,
    keyOrRef?: string,
    ref?: SecretRefInput,
  ): Promise<string | null> {
    const current = captureSecurityReadBindings(this, ['secretsManager', 'diagnosticMode']);
    const secrets = this.secretsManager;
    const secretsCurrent = captureSecurityReadBindings(secrets, ['get', 'getGlobalHome']);
    const read = secrets.get, home = secrets.getGlobalHome;
    const assertCurrent = () => { current(); secretsCurrent(); };
    assertCurrent();
    const candidate = ref ?? (keyOrRef && isSecretRefInput(keyOrRef) ? keyOrRef : undefined);
    if (candidate) {
      try {
        const resolved = await resolveSecretRef(candidate, {
          resolveLocalSecret: async (key) => { assertCurrent(); const value = await read.call(secrets, key); assertCurrent(); return value; },
          homeDirectory: home.call(secrets),
        });
        assertCurrent(); return resolved.value;
      } catch (error) {
        assertCurrent();
        logger.warn('ServiceRegistry: failed to resolve secret reference', {
          serviceName,
          field,
          ...(this.diagnosticMode === 'structural' ? { reason: 'resolution-failed' }
            : { ref: describeSecretRef(candidate), error: summarizeError(error) }),
        });
        return null;
      }
    }

    assertCurrent();
    const value = keyOrRef ? await read.call(secrets, keyOrRef) : null;
    assertCurrent(); return value;
  }

  /**
   * Resolve auth headers for a named service.
   * Looks up the service config, fetches credential from SecretsManager,
   * and returns the appropriate HTTP headers.
   *
   * Returns null if the service is not registered or credential is unavailable.
   */
  async resolveAuth(serviceName: string): Promise<Record<string, string> | null> {
    const config = this.get(serviceName);
    if (!config) {
      const unreadable = this.unreadableReason();
      if (unreadable) logger.warn('ServiceRegistry: no credentials resolved because the services file is unusable', { serviceName, reason: unreadable });
      else logger.debug('ServiceRegistry: unknown service', { serviceName });
      return null;
    }

    // A subscription token is a bearer token; it must not replace the header an
    // api-key or basic service is configured to send.
    const providerOverride = config.authType === 'bearer' || config.authType === 'oauth'
      ? this.subscriptionManager.getAccessToken(config.providerId ?? serviceName)
      : null;
    if (providerOverride) {
      return { Authorization: `Bearer ${providerOverride}` };
    }

    switch (config.authType) {
      case 'bearer': {
        const token = await this.resolveConfiguredSecret(serviceName, 'primary', config.tokenKey, config.tokenRef);
        if (!token) {
          logger.debug('ServiceRegistry: bearer token not found', { serviceName, key: config.tokenKey });
          return null;
        }
        return { Authorization: `Bearer ${token}` };
      }

      case 'basic': {
        const username = await this.resolveConfiguredSecret(serviceName, 'primary', config.tokenKey, config.tokenRef);
        const password = await this.resolveConfiguredSecret(serviceName, 'password', config.passwordKey, config.passwordRef);
        if (!username) {
          logger.debug('ServiceRegistry: basic username not found', { serviceName, key: config.tokenKey });
          return null;
        }
        const encoded = Buffer.from(`${username}:${password ?? ''}`).toString('base64');
        return { Authorization: `Basic ${encoded}` };
      }

      case 'api-key': {
        const key = await this.resolveConfiguredSecret(serviceName, 'primary', config.tokenKey, config.tokenRef);
        if (!key) {
          logger.debug('ServiceRegistry: api key not found', { serviceName, key: config.tokenKey });
          return null;
        }
        const headerName = config.apiKeyHeader ?? 'X-API-Key';
        return { [headerName]: key };
      }

      case 'oauth': {
        const token = await this.resolveConfiguredSecret(serviceName, 'primary', config.tokenKey, config.tokenRef);
        if (!token) {
          logger.debug('ServiceRegistry: oauth token not found', { serviceName, key: config.tokenKey });
          return null;
        }
        return { Authorization: `Bearer ${token}` };
      }

      default:
        return null;
    }
  }

  async resolveSecret(
    serviceName: string,
    field: ServiceSecretField,
  ): Promise<string | null> {
    const config = this.get(serviceName);
    if (!config) return null;

    switch (field) {
      case 'primary':
        return this.resolveConfiguredSecret(serviceName, field, config.tokenKey, config.tokenRef);
      case 'password':
        return this.resolveConfiguredSecret(serviceName, field, config.passwordKey, config.passwordRef);
      case 'authToken':
        return this.resolveConfiguredSecret(
          serviceName,
          field,
          config.authTokenKey ?? config.passwordKey,
          config.authTokenRef ?? config.passwordRef,
        );
      case 'webhookUrl':
        return this.resolveConfiguredSecret(serviceName, field, config.webhookUrlKey, config.webhookUrlRef);
      case 'signingSecret':
        return this.resolveConfiguredSecret(serviceName, field, config.signingSecretKey, config.signingSecretRef);
      case 'publicKey':
        return this.resolveConfiguredSecret(serviceName, field, config.publicKeyKey, config.publicKeyRef);
      case 'appToken':
        return this.resolveConfiguredSecret(serviceName, field, config.appTokenKey, config.appTokenRef);
    }
  }

  async inspect(serviceName: string): Promise<ServiceInspection | null> {
    const current = captureSecurityReadBindings(this, ['get', 'resolveSecret', 'resolveConfiguredSecret']);
    const get = this.get, resolve = this.resolveSecret;
    current(); const config = get.call(this, serviceName); current();
    if (!config) return null;

    const pending = [
      resolve.call(this, serviceName, 'primary'),
      resolve.call(this, serviceName, 'password'),
      resolve.call(this, serviceName, 'authToken'),
      resolve.call(this, serviceName, 'webhookUrl'),
      resolve.call(this, serviceName, 'signingSecret'),
      resolve.call(this, serviceName, 'publicKey'),
      resolve.call(this, serviceName, 'appToken'),
    ] as const;
    const [
      primary,
      password,
      authToken,
      webhookUrl,
      signingSecret,
      publicKey,
      appToken,
    ] = await Promise.all(pending).catch(async (error: unknown) => {
      await Promise.allSettled(pending);
      throw error;
    });
    current();

    return {
      config,
      hasPrimaryCredential: primary !== null && primary.length > 0,
      hasPasswordCredential: password !== null && password.length > 0,
      hasAuthTokenCredential: authToken !== null && authToken.length > 0,
      hasWebhookUrl: webhookUrl !== null && webhookUrl.length > 0,
      hasSigningSecret: signingSecret !== null && signingSecret.length > 0,
      hasPublicKey: publicKey !== null && publicKey.length > 0,
      hasAppToken: appToken !== null && appToken.length > 0,
    };
  }

  /**
   * Ask the service itself, with the credential: one request to `baseUrl` (or
   * `baseUrl` + `testPath`). Below 400 is connected; 401 and 403 mean the
   * credential was refused; any other status says the service was reached and
   * what it answered.
   */
  async testConnection(serviceName: string): Promise<ServiceConnectionTestResult> {
    const config = this.get(serviceName);
    if (!config) {
      const unreadable = this.unreadableReason();
      return {
        ok: false,
        outcome: 'not-tested',
        status: null,
        testedUrl: null,
        error: unreadable ? `Service list unusable: ${unreadable}` : `Unknown service ${serviceName}; add it to ${this.servicesFilePath || 'your services file'}`,
      };
    }

    const baseUrl = config.baseUrl?.trim().replace(/\/$/, '') ?? '';
    if (!baseUrl) {
      return { ok: false, outcome: 'not-tested', status: null, testedUrl: null, error: `No baseUrl configured for ${serviceName}; nothing was sent` };
    }

    const headers = await this.resolveAuth(serviceName);
    if (!headers) {
      return {
        ok: false,
        outcome: 'not-tested',
        status: null,
        testedUrl: null,
        error: `No ${config.authType} credential could be resolved for ${serviceName}; nothing was sent. Store ${config.tokenKey} with /secrets set`,
      };
    }
    const testPath = config.testPath?.trim();
    const url = testPath ? `${baseUrl}${testPath.startsWith('/') ? '' : '/'}${testPath}` : baseUrl;
    try {
      const response = await instrumentedFetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(5000),
      });
      if (response.status < 400) return { ok: true, outcome: 'connected', status: response.status, testedUrl: url };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, outcome: 'credential-refused', status: response.status, testedUrl: url,
          error: `${serviceName} refused the credential (HTTP ${response.status}); check ${config.tokenKey}` };
      }
      return { ok: false, outcome: 'reached', status: response.status, testedUrl: url,
        error: `${serviceName} was reached and answered HTTP ${response.status}${testPath ? '' : '; if its root does not answer, set testPath on the service'}` };
    } catch (error) {
      const message = summarizeError(error);
      logger.debug('ServiceRegistry: service test failed', { serviceName, url, error: message });
      return { ok: false, outcome: 'unreachable', status: null, testedUrl: url, error: `${serviceName} could not be reached: ${message}` };
    }
  }
}
