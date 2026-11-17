import { existsSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { logger } from '../../utils/logger.js';
import { LspClient } from './client.js';
import { parseCapabilities } from './capabilities.js';
import {
  getBinaryPath,
  installServerBinary,
  isInstallableServer,
  manualInstallHint,
  DEFAULT_INSTALL_TIMEOUT_MS,
} from './binary-downloader.js';
import type { ShellPathService } from '../../runtime/shell-paths.js';
import type { Diagnostic } from './protocol.js';
import { summarizeError } from '../../utils/error-display.js';
import { readDocument, writeDocument } from '../../utils/atomic-json-store.js';

type LspRoots = Pick<ShellPathService, 'workingDirectory' | 'resolveUserPath'>;

const ENGINE_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');

/** A server nobody has asked anything for this long is stopped; the next lookup starts it again. */
const DEFAULT_IDLE_STOP_MS = 10 * 60_000;

/**
 * A server that failed to start is not spawned again on every lookup, but a
 * failure is not kept for the life of the process either: a slow machine or a
 * dependency still installing can fail one start. After this long, or as soon
 * as the server program found on disk changes, the next lookup tries again.
 */
const START_RETRY_AFTER_MS = 60_000;

/** What a start failure was judged against: when, and the program it ran. */
interface StartFailure {
  readonly reason: string;
  readonly at: number;
  /** The located program and its modification time, so a reinstall or upgrade retries at once. */
  readonly program: string;
}

function programStamp(path: string | null): string {
  if (!path) return '';
  try {
    return `${path}@${statSync(path).mtimeMs}`;
  } catch {
    return path;
  }
}

function startRetryStep(command: string): string {
  return `Check that ${command} runs from a terminal; the next lookup after a minute, or after ${command} is reinstalled, tries it again.`;
}

// A server binary inside the opened repository is never chosen: opening a repo
// must not let it pick the program the editor runs. Only the engine install,
// the user's own download directory and PATH are searched.
function bundledCommandPath(command: string): string | null {
  const candidates: string[] = [];
  let current = ENGINE_PACKAGE_ROOT;
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(join(current, 'node_modules', '.bin', command));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (command === 'bash-language-server') {
    // Bun 1.3.14 can omit the optional file: package link from an engine
    // tarball. Its reviewed source and declared runtime leaves still ship.
    // Preserve installed .bin precedence, then use only our embedded copies.
    candidates.push(resolve(ENGINE_PACKAGE_ROOT, '../vendor/bash-language-server/out/cli.js'));
    if (fileURLToPath(import.meta.url).endsWith(join('platform', 'src', 'platform', 'intelligence', 'lsp', 'service.ts'))) {
      candidates.push(resolve(ENGINE_PACKAGE_ROOT, '../../../vendor/bash-language-server/out/cli.js'));
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate a server command: the engine install's node_modules/.bin/ (bundled),
 * then the user download directory, then PATH. Null when it is not installed.
 */
function locateCommand(command: string, userBinaryDir: string): string | null {
  const bundled = bundledCommandPath(command);
  if (bundled) return bundled;
  const downloaded = getBinaryPath(userBinaryDir, command);
  if (existsSync(downloaded)) return downloaded;
  try {
    return Bun.which(command);
  } catch {
    return null;
  }
}

export interface LspServerConfig {
  command: string;
  args: string[];
  initializationOptions?: Record<string, unknown> | undefined;
}

/** Whether a lookup has a server to ask, and if not, why and what to do. */
export type LspClientResolution =
  | { readonly status: 'ok'; readonly client: LspClient }
  | { readonly status: 'no-server' | 'failed'; readonly reason: string; readonly next: readonly string[] };

/** What one explicit install did; remembered so the next missing-server answer can say it. */
export interface LanguageServerInstallOutcome {
  readonly langId: string;
  readonly command: string;
  readonly status: 'installed' | 'already-installed' | 'not-installable' | 'not-configured' | 'failed' | 'timeout';
  readonly reason: string;
  readonly path?: string | undefined;
  readonly at: number;
}

const INSTALL_OUTCOMES_FILE = 'language-server-installs.json';

function serverKey(config: LspServerConfig): string {
  return JSON.stringify([config.command, config.args, config.initializationOptions ?? null]);
}

/**
 * Language servers for one workspace. One process runs per distinct server
 * command (TypeScript, TSX and JavaScript share one), it is stopped after
 * {@link DEFAULT_IDLE_STOP_MS} without a lookup, and a lookup never installs
 * anything: a missing server is answered with the command that installs it.
 */
export class LspService {
  private configs: Map<string, LspServerConfig> = new Map();
  private clients: Map<string, LspClient> = new Map();
  private starting: Map<string, Promise<LspClientResolution>> = new Map();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Start failures, so a server that cannot start is not spawned again on every lookup (see {@link START_RETRY_AFTER_MS}). */
  private readonly startFailures = new Map<string, StartFailure>();
  /** Languages whose missing server was already logged. */
  private readonly missingNoted = new Set<string>();
  private installOutcomes: Map<string, LanguageServerInstallOutcome> | null = null;
  private readonly roots: LspRoots;
  private readonly idleStopMs: number;

  constructor(roots: LspRoots, options: { readonly idleStopMs?: number | undefined } = {}) {
    this.roots = roots;
    this.idleStopMs = options.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
  }

  /** Register a server configuration for a language. */
  registerServer(langId: string, config: LspServerConfig): void {
    this.configs.set(langId, config);
  }

  /** The server configured for a language, if any. */
  serverFor(langId: string): LspServerConfig | undefined {
    return this.configs.get(langId);
  }

  private userBinaryDir(): string {
    return this.roots.resolveUserPath('bin');
  }

  /**
   * The running client for a language, or why there is none. Starts the server
   * when it is installed and not running; never installs it.
   */
  async resolveClient(langId: string): Promise<LspClientResolution> {
    const config = this.configs.get(langId);
    if (!config) {
      return { status: 'no-server', reason: `No language server is configured for ${langId}.`,
        next: [`Set one in your user languages directory (${this.roots.resolveUserPath('languages', `${langId}.json`)}) with an lsp command.`] };
    }
    const key = serverKey(config);
    const existing = this.clients.get(key);
    if (existing?.isRunning) {
      this.touch(key);
      return { status: 'ok', client: existing };
    }
    if (existing) this.clients.delete(key);

    const failure = this.currentStartFailure(key, config);
    if (failure) return { status: 'failed', reason: failure.reason, next: [startRetryStep(config.command)] };

    const inFlight = this.starting.get(key);
    if (inFlight) return inFlight;
    const start = this._startClient(langId, key, config);
    this.starting.set(key, start);
    try {
      return await start;
    } finally {
      this.starting.delete(key);
    }
  }

  /**
   * The start failure that still holds for a server, or undefined. One expires
   * after {@link START_RETRY_AFTER_MS}, or when the program it ran is no longer
   * the one found on disk (reinstalled, upgraded or newly on PATH).
   */
  private currentStartFailure(key: string, config: LspServerConfig): StartFailure | undefined {
    const failure = this.startFailures.get(key);
    if (!failure) return undefined;
    if (Date.now() - failure.at >= START_RETRY_AFTER_MS
      || programStamp(locateCommand(config.command, this.userBinaryDir())) !== failure.program) {
      this.startFailures.delete(key);
      return undefined;
    }
    return failure;
  }

  /** The client for a language when its server is already running; never starts one. */
  runningClient(langId: string): LspClient | null {
    const config = this.configs.get(langId);
    if (!config) return null;
    const key = serverKey(config);
    const client = this.clients.get(key);
    if (!client?.isRunning) return null;
    this.touch(key);
    return client;
  }

  /**
   * Get or start a client for a language.
   * Returns null if no server is configured, installed, or able to start.
   */
  async getClient(langId: string): Promise<LspClient | null> {
    const resolution = await this.resolveClient(langId);
    return resolution.status === 'ok' ? resolution.client : null;
  }

  private async _startClient(langId: string, key: string, config: LspServerConfig): Promise<LspClientResolution> {
    const resolvedCommand = locateCommand(config.command, this.userBinaryDir());
    if (!resolvedCommand) return this._missing(langId, config.command);

    const client = new LspClient(resolvedCommand, config.args);
    try {
      await client.start();
      await this._initializeServer(client, config);
      this.clients.set(key, client);
      this.touch(key);
      logger.info('LspService: started server', { langId, command: config.command });
      return { status: 'ok', client };
    } catch (err) {
      const stderr = client.recentStderr;
      const reason = `The ${config.command} language server did not start: ${summarizeError(err)}${stderr ? ` (${stderr.split('\n').slice(-3).join(' ')})` : ''}`;
      this.startFailures.set(key, { reason, at: Date.now(), program: programStamp(resolvedCommand) });
      logger.error('LspService: failed to start server', { langId, err: summarizeError(err) });
      try {
        await client.stop();
      } catch (stopError) {
        logger.warn('LspService: failed to stop server after startup failure', {
          langId,
          error: summarizeError(stopError),
        });
      }
      return { status: 'failed', reason, next: [startRetryStep(config.command)] };
    }
  }

  private _missing(langId: string, command: string): LspClientResolution {
    if (!this.missingNoted.has(langId)) {
      this.missingNoted.add(langId);
      logger.info('LspService: no language server installed for this language', { langId, command });
    }
    const last = this._installOutcomes().get(command);
    const hint = manualInstallHint(command);
    const next = [
      ...(hint ? [`Install it: ${hint}`] : [`Install ${command} and put it on PATH`]),
      ...(isInstallableServer(command) ? [`Or let GoodVibes install it into ${this.userBinaryDir()}: type /intelligence install ${langId} in goodvibes or goodvibes-agent`] : []),
    ];
    const lastAttempt = last && last.status !== 'installed' && last.status !== 'already-installed'
      ? ` The last install attempt (${new Date(last.at).toISOString()}) did not succeed: ${last.reason}.` : '';
    return { status: 'no-server', reason: `No language server for ${langId}: ${command} is not installed.${lastAttempt}`, next };
  }

  /**
   * Check if a server is available for a language
   * (config exists AND command is installed).
   */
  async isAvailable(langId: string): Promise<boolean> {
    const config = this.configs.get(langId);
    if (!config) return false;
    return locateCommand(config.command, this.userBinaryDir()) !== null;
  }

  /**
   * Install the server for a language into the user's bin directory: the
   * explicit owner action behind `/intelligence install`. Bounded by
   * `timeoutMs` and `signal`; the outcome is remembered in the user directory.
   */
  async installServer(
    langId: string,
    options: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {},
  ): Promise<LanguageServerInstallOutcome> {
    const config = this.configs.get(langId);
    if (!config) {
      return { langId, command: '', status: 'not-configured', reason: `No language server is configured for ${langId}`, at: Date.now() };
    }
    const command = config.command;
    const located = locateCommand(command, this.userBinaryDir());
    let outcome: LanguageServerInstallOutcome;
    if (located) {
      outcome = { langId, command, status: 'already-installed', reason: `${command} is already installed`, path: located, at: Date.now() };
    } else if (!isInstallableServer(command)) {
      const hint = manualInstallHint(command);
      outcome = { langId, command, status: 'not-installable',
        reason: `${command} cannot be installed by GoodVibes${hint ? `; install it with: ${hint}` : ''}`, at: Date.now() };
    } else {
      const result = await installServerBinary(this.userBinaryDir(), command, {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
      });
      outcome = result.ok
        ? { langId, command, status: 'installed', reason: `${command} was installed`, path: result.path, at: Date.now() }
        : { langId, command, status: result.timedOut ? 'timeout' : 'failed', reason: result.reason, at: Date.now() };
    }
    if (outcome.status === 'installed') {
      // A server that failed to start before the install may start now.
      this.startFailures.delete(serverKey(config));
      this.missingNoted.delete(langId);
    }
    this._rememberInstall(outcome);
    return outcome;
  }

  private _installOutcomesPath(): string {
    return this.roots.resolveUserPath(INSTALL_OUTCOMES_FILE);
  }

  private _installOutcomes(): Map<string, LanguageServerInstallOutcome> {
    if (this.installOutcomes) return this.installOutcomes;
    const loaded = new Map<string, LanguageServerInstallOutcome>();
    try {
      const stored = readDocument<LanguageServerInstallOutcome[]>(this._installOutcomesPath(), {
        label: 'intelligence/language-server-installs',
        validate: (parsed) => {
          if (!Array.isArray(parsed)) throw new Error('expected a list of install outcomes');
          return parsed.filter((entry): entry is LanguageServerInstallOutcome => typeof entry === 'object' && entry !== null
            && typeof (entry as { command?: unknown }).command === 'string'
            && typeof (entry as { status?: unknown }).status === 'string'
            && typeof (entry as { reason?: unknown }).reason === 'string'
            && typeof (entry as { at?: unknown }).at === 'number');
        },
        recovery: 'The record of earlier language-server install attempts starts empty; installing still works.',
      });
      for (const entry of stored ?? []) loaded.set(entry.command, entry);
    } catch (err) {
      logger.debug('LspService: install record unreadable', { error: summarizeError(err) });
    }
    this.installOutcomes = loaded;
    return loaded;
  }

  private _rememberInstall(outcome: LanguageServerInstallOutcome): void {
    if (!outcome.command) return;
    const outcomes = this._installOutcomes();
    outcomes.set(outcome.command, outcome);
    try {
      writeDocument(this._installOutcomesPath(), [...outcomes.values()]);
    } catch (err) {
      logger.warn('LspService: could not record the install outcome', { command: outcome.command, error: summarizeError(err) });
    }
  }

  /** Restart the idle clock of a server that was just used. */
  private touch(key: string): void {
    const previous = this.idleTimers.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.idleTimers.delete(key);
      const client = this.clients.get(key);
      this.clients.delete(key);
      if (!client) return;
      logger.debug('LspService: stopping an idle language server', { key });
      client.stop().catch((error: unknown) => {
        logger.warn('LSP server stop failed after idle period', { error: summarizeError(error) });
      });
    }, this.idleStopMs);
    timer.unref?.();
    this.idleTimers.set(key, timer);
  }

  /** Initialize a server with the LSP handshake and record what it can do. */
  private async _initializeServer(client: LspClient, config: LspServerConfig): Promise<void> {
    const result = await client.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.roots.workingDirectory).href,
      ...(config.initializationOptions ? { initializationOptions: config.initializationOptions } : {}),
      capabilities: {
        textDocument: {
          synchronization: { didSave: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          definition: {},
          references: {},
          hover: {},
          rename: { prepareSupport: true },
          publishDiagnostics: { versionSupport: true },
          diagnostic: {},
        },
      },
    });
    client.capabilities = parseCapabilities(result);
    client.notify('initialized', {});
  }

  /**
   * Each configured language and its server's state now: `running`, `failed`
   * (it could not start in the last minute; a later lookup tries again) or
   * `idle` (it starts on the first lookup). Reads only what this service holds.
   */
  languageStates(): ReadonlyMap<string, 'running' | 'failed' | 'idle'> {
    const states = new Map<string, 'running' | 'failed' | 'idle'>();
    for (const [langId, config] of this.configs) {
      const key = serverKey(config);
      const failed = (this.startFailures.get(key)?.at ?? -Infinity) > Date.now() - START_RETRY_AFTER_MS;
      states.set(langId, this.clients.get(key)?.isRunning ? 'running' : failed ? 'failed' : 'idle');
    }
    return states;
  }

  /** The running servers' published diagnostics, keyed by document URI. */
  publishedDiagnostics(): ReadonlyMap<string, readonly Diagnostic[]> {
    const out = new Map<string, readonly Diagnostic[]>();
    for (const client of this.clients.values()) {
      if (!client.isRunning) continue;
      for (const [uri, diagnostics] of client.publishedDiagnostics()) out.set(uri, diagnostics);
    }
    return out;
  }

  /** Stop all running servers. */
  async shutdown(): Promise<void> {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    const stops = Array.from(this.clients.values()).map(c => c.stop().catch((error) => {
      logger.warn('LSP server stop failed during shutdown', { error: summarizeError(error) });
    }));
    await Promise.all(stops);
    this.clients.clear();
    this.starting.clear();
  }
}
