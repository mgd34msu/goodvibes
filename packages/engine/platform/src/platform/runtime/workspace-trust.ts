import { assertPermissionActive, awaitPermission } from '../permissions/cancellation.js';
/**
 * workspace-trust.ts, per-workspace trust constraint.
 *
 * Autonomous callers use prepareAutonomousConstraint: an explicit restricted
 * choice blocks non-read actions; undecided actions receive per-action Jev
 * judgment without asking a human or persisting a workspace grant. The legacy
 * callback adapter below retains its historical explicit interactive contract.
 *
 * The first time GoodVibes opens a workspace (a cwd / project root it has no
 * prior decision for), that workspace is "undecided": only read-category
 * tools run; the first write, execute, or delegate tool request raises the
 * trust question AT THAT MOMENT, the exact point it has a real consequence,
 * instead of silently failing or being decided by a side effect of the
 * product's own droppings. This is NOT a parallel permission checker, the
 * decision is consulted by the real permission machinery at its final ask
 * layer (the requestPermission callback wired in bootstrap-core.ts), so it
 * composes with, and cannot drift from, the existing PermissionManager layer
 * chain.
 *
 * Trust is the owner's decision about a directory, so it is kept in the
 * owner's own state, never in the directory it judges: one row per directory
 * (keyed by its real path) in the user's workspace register
 * (~/.goodvibes/shared/workspace-registrations.json), shared by every product.
 * A `trust.json` found inside a project, which earlier builds wrote there, is
 * not honored: a checkout could ship one saying "trusted". Such a directory
 * reads as undecided and is asked once more.
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  openWorkspaceRegistrationStore,
  readWorkspaceRegisterSync,
  sharedWorkspaceRegisterPath,
  type WorkspaceRegistrationStore,
} from '../workspace/index.js';
import { normalizeWorkspaceRoot, pathCovers } from '../workspace/registration/resolution.js';
import { logger } from '../utils/logger.js';
import { fileIdentity } from '../security/read-source.js';
import { summarizeError } from '../utils/error-display.js';
import type { PermissionCategory } from '../permissions/index.js';
import type { PermissionRequestHandler } from '../permissions/index.js';

/** How long a request waits on the open trust question before it is refused. */
export interface TrustGateOptions {
  /**
   * Absent: wait until the question is answered (a person is at this screen).
   * Set: a request waits at most this long after the question was raised; once
   * that has passed, every later non-read request is refused at once while the
   * one question stays open for whoever attaches next.
   */
  readonly waitMs?: number | undefined;
}

/**
 * Wrap the permission machinery's final ask callback with the workspace trust
 * gate. This runs inside PermissionManager's own layer chain (it IS the ask
 * layer), so it composes with, and cannot drift from, the real machinery.
 *
 * - Read requests always pass to `ask`, also while the trust question is open.
 * - Trusted workspace: every category passes through to `ask` unchanged.
 * - Restricted workspace with an EXPLICIT prior decision: non-read categories
 *   are denied outright, that IS what "restricted" means.
 * - Undecided workspace: the first non-read request raises the workspace's one
 *   trust question (owned by the manager, so every gate over the same workspace
 *   shares it), and, if the answer is 'trusted', the ORIGINAL request is
 *   forwarded to `ask` so the very thing the user just approved happens.
 *   Requests that arrive while the question is open wait on the same question
 *   (bounded by `options.waitMs` when set) rather than opening a second one.
 */
export function trustGatedAsk(
  manager: Pick<WorkspaceTrustManager, 'isCategoryAllowed' | 'isDecided' | 'trustQuestion'> & { readonly workspaceRoot?: string },
  ask: PermissionRequestHandler,
  requestTrustDecision: () => Promise<WorkspaceTrustLevel>,
  options: TrustGateOptions = {},
): PermissionRequestHandler {
  return async (request, execution) => {
    const signal = execution?.signal;
    assertPermissionActive(signal);
    if (manager.isCategoryAllowed(request.category)) return ask(request, execution);
    if (manager.isDecided()) return { approved: false };
    const question = manager.trustQuestion(requestTrustDecision);
    const where = manager.workspaceRoot ? ` for ${manager.workspaceRoot}` : '';
    const unanswered = {
      approved: false,
      reason: `Workspace trust${where} is undecided and the trust question is still open with nobody answering it. `
        + 'Reads keep working; writes, commands and delegation are refused until it is answered. '
        + 'Answer the workspace trust request from an attached surface (the approvals list), then retry.',
    } as const;
    // A question nobody could answer (no person at this surface, a dismissed
    // prompt) refuses this request and leaves the workspace undecided; it is not
    // a failure of the turn, and the next request asks again.
    const notAnswered = {
      approved: false,
      reason: `Workspace trust${where} is undecided and the trust question was not answered here, so the workspace stays undecided. `
        + 'Reads keep working; writes, commands and delegation are refused until it is trusted '
        + '(/security trust-folder, or answer the workspace-trust prompt of a run started with --answer-permissions).',
    } as const;
    if (options.waitMs === undefined) {
      try {
        await awaitPermission(() => question.answer, signal);
      } catch (error) {
        assertPermissionActive(signal);
        logger.info('workspace trust: the question was not answered; the request is refused', { workspace: manager.workspaceRoot, error: summarizeError(error) });
        return notAnswered;
      }
    } else {
      const remaining = question.openedAt + options.waitMs - Date.now();
      if (remaining <= 0) return unanswered;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let answered: boolean;
      try {
        answered = await awaitPermission(() => Promise.race([
          question.answer.then(() => true),
          new Promise<false>((resolveWait) => { timer = setTimeout(() => resolveWait(false), remaining); }),
        ]), signal).finally(() => clearTimeout(timer));
      } catch (error) {
        assertPermissionActive(signal);
        logger.info('workspace trust: the question was not answered; the request is refused', { workspace: manager.workspaceRoot, error: summarizeError(error) });
        return notAnswered;
      }
      if (!answered) return unanswered;
    }
    assertPermissionActive(signal);
    if (manager.isCategoryAllowed(request.category)) return ask(request, execution);
    return { approved: false };
  };
}

export type WorkspaceTrustLevel = 'trusted' | 'restricted';

/**
 * What a repository brings with it (its hooks file, its MCP server files)
 * waits on the owner's trust of the workspace: until he trusts it, nothing in
 * those files is loaded or started. An undecided workspace is not trusted.
 * Every product reads the same decision (the user's workspace register).
 */
export interface RepositoryTrust {
  /** The workspace's real path. */
  readonly workspaceRoot: string;
  /**
   * Reads the saved decision; later calls cost one stat of the register and
   * read it again only when another process changed it.
   */
  load(): Promise<void>;
  isTrusted(): boolean;
  /**
   * Called each time the workspace's trust level changes: the owner decided in
   * this process, or a read of the register found another process's decision.
   * Returns the unsubscribe.
   */
  onLevelChanged(listener: (level: WorkspaceTrustLevel) => void): () => void;
}

/** The check a loader of repository files (the hooks file, project MCP files) holds them back with. */
export interface RepositoryFileGate {
  /** Reads the saved trust decision; again only when another process changed it. */
  load(): Promise<void>;
  /** True when this file waits on the owner's trust of the workspace. */
  holds(path: string): boolean;
  /** Called each time the workspace's trust level changes. Returns the unsubscribe. */
  onLevelChanged(listener: (level: WorkspaceTrustLevel) => void): () => void;
}

/** The gate over `trust` for the files under its workspace; see {@link heldForRepositoryTrust}. */
export function repositoryFileGate(trust: RepositoryTrust, homeDirectory: string): RepositoryFileGate {
  return {
    load: () => trust.load(),
    holds: (path) => heldForRepositoryTrust(trust, path, homeDirectory),
    onLevelChanged: (listener) => trust.onLevelChanged(listener),
  };
}

/** The words every surface uses when what a repository brings is waiting on the owner's trust. */
export const REPOSITORY_TRUST_NEXT_STEP = 'Run /security trust-folder to turn them on, or leave the workspace untrusted to keep them off.';

/**
 * The one notice a terminal app shows when what the workspace's repository
 * brought is waiting on the owner's trust: its hooks file and the MCP servers
 * its files name. Null when nothing waits (a trusted workspace reads no file).
 */
export async function repositoryTrustNotice(input: {
  readonly trust: Pick<RepositoryTrust, 'isTrusted' | 'load' | 'workspaceRoot'>;
  /** The hooks file the workbench holds back, or null. */
  readonly hooksFileWaiting: string | null;
  /** The MCP servers the registry holds back. */
  readonly heldMcpServers: () => Promise<readonly string[]>;
}): Promise<string | null> {
  await input.trust.load();
  if (input.trust.isTrusted()) return null;
  const servers = await input.heldMcpServers();
  const waiting = [
    ...(input.hooksFileWaiting !== null ? [`its hooks file (${input.hooksFileWaiting}) is not loaded`] : []),
    ...(servers.length > 0 ? [`its MCP ${servers.length === 1 ? 'server' : 'servers'} ${servers.join(', ')} ${servers.length === 1 ? 'is' : 'are'} not started`] : []),
  ];
  if (waiting.length === 0) return null;
  return `[Startup] Hooks and MCP servers from this repository wait on workspace trust: you have not trusted ${input.trust.workspaceRoot}, so ${waiting.join(' and ')}. ${REPOSITORY_TRUST_NEXT_STEP}`;
}

/**
 * True when `path` is a file the repository in `trust.workspaceRoot` could have
 * brought, so it waits on the owner's trust. A workspace that is the owner's
 * home directory holds no repository: files there are his own.
 */
export function heldForRepositoryTrust(trust: Pick<RepositoryTrust, 'workspaceRoot' | 'isTrusted'>, path: string, homeDirectory: string): boolean {
  if (trust.isTrusted()) return false;
  const root = trust.workspaceRoot;
  if (root === canonicalWorkspaceRoot(homeDirectory)) return false;
  // Where the path is written and where it leads: a link in the checkout does not make its file the owner's.
  let real: string;
  try { real = realpathSync(path); } catch { real = resolve(path); }
  return pathCovers(root, normalizeWorkspaceRoot(resolve(path))) || pathCovers(root, real);
}

/** The file earlier builds kept inside the workspace; read only to say it is no longer honored. */
const LEGACY_TRUST_FILE = 'trust.json';

/** The directory's real path, or its absolute path when it does not exist (yet). */
function canonicalWorkspaceRoot(workingDirectory: string): string {
  try { return normalizeWorkspaceRoot(realpathSync(workingDirectory)); }
  catch { return normalizeWorkspaceRoot(resolve(workingDirectory)); }
}

/**
 * detectPriorWorkspaceState, true if <workingDirectory>/.goodvibes already
 * holds GoodVibes RUNTIME state from a prior session. Deliberately keyed on
 * generated state (sessions/checkpoints/state/memory/onboarding marker), not on
 * committed scaffolding like .goodvibes/agents or GOODVIBES.md, so a checked-out
 * template does not read as "previously used". MUST be sampled before any
 * service initializes the workspace this session (bootstrap-core samples it
 * before createRuntimeServices), or this-run scaffolding would look like prior
 * use.
 */
export function detectPriorWorkspaceState(workingDirectory: string, surfaceRoot: string): boolean {
  const root = join(workingDirectory, '.goodvibes');
  if (!existsSync(root)) return false;

  const fileSignals = [
    join(root, 'checkpoints', 'index.json'),
    join(root, surfaceRoot, 'onboarding-checked.json'),
    join(root, 'goodvibes.json'),
  ];
  for (const file of fileSignals) {
    if (existsSync(file)) return true;
  }

  const dirSignals = ['sessions', 'checkpoints', 'state', 'memory'];
  for (const dir of dirSignals) {
    const path = join(root, dir);
    try {
      if (existsSync(path) && statSync(path).isDirectory() && readdirSync(path).length > 0) {
        return true;
      }
    } catch {
      // Unreadable, treat as absent rather than crash the gate.
    }
  }
  return false;
}

export interface WorkspaceTrustPaths {
  /** The workspace being judged; its real path keys the decision. */
  readonly workingDirectory: string;
  resolveProjectPath(...segments: string[]): string;
  /** The user's own state (`~/.goodvibes/...`), where the decision is kept. */
  resolveUserPath(...segments: string[]): string;
}

/** Read-only view of the persisted trust decision, for status/doctor reporting. */
export interface PersistedWorkspaceTrustView {
  /** 'trusted' | 'restricted' when a decision exists; 'undecided' when none is persisted yet. */
  readonly level: WorkspaceTrustLevel | 'undecided';
  /**
   * True when the directory has no decision in the register but carries a
   * `trust.json` an earlier build kept inside it, which is not honored: the
   * owner chooses again.
   */
  readonly legacyIgnored: boolean;
  /**
   * Present when the register could not be read. The level then reads
   * 'undecided' because nothing readable is recorded, which is not the same as
   * nobody ever deciding: a report should say the record is damaged.
   */
  readonly fault?: string | undefined;
}

/**
 * readPersistedWorkspaceTrust, read this directory's decision from the user's
 * workspace register without loading a manager. Reporting surfaces
 * (`status`/`doctor`) use it; it never writes.
 */
export function readPersistedWorkspaceTrust(
  paths: WorkspaceTrustPaths,
  surfaceRoot: string,
): PersistedWorkspaceTrustView {
  const legacyIgnored = (): boolean => existsSync(paths.resolveProjectPath(surfaceRoot, LEGACY_TRUST_FILE));
  const registerPath = sharedWorkspaceRegisterPath(paths);
  const read = readWorkspaceRegisterSync(registerPath);
  if (read.state === 'unreadable') {
    return { level: 'undecided', legacyIgnored: false, fault: `the workspace register ${registerPath} could not be read (${read.reason})` };
  }
  const root = canonicalWorkspaceRoot(paths.workingDirectory);
  const row = read.state === 'ok' ? read.trust.find((entry) => entry.root === root) : undefined;
  return row ? { level: row.level, legacyIgnored: false } : { level: 'undecided', legacyIgnored: legacyIgnored() };
}

export interface WorkspaceTrustManagerOptions {
  readonly shellPaths: WorkspaceTrustPaths;
  /** The owning product's storage scope; only used to notice a `trust.json` earlier builds kept in the workspace. */
  readonly surfaceRoot: string;
  /** Inject a register store (tests); defaults to the process's store for the user's shared register. */
  readonly store?: WorkspaceRegistrationStore | undefined;
}

/** The workspace's one open trust question: raised once, shared by every gate over this workspace. */
export interface WorkspaceTrustQuestion {
  /** Settles with the decision once answered and recorded; rejects when the question could not be answered. */
  readonly answer: Promise<WorkspaceTrustLevel>;
  /** Epoch ms the question was raised. */
  readonly openedAt: number;
}

export class WorkspaceTrustManager {
  private level: WorkspaceTrustLevel | null = null; // null = undecided (new place)
  private loaded = false;
  /** The register file's identity (security/read-source.ts fileIdentity) when it was last read. */
  private registerIdentity: string | null = null;
  private revision = 0;
  private decisionRevision = 0;
  private pendingDecisions = 0;
  /** Why the register could not be read, or null. A damaged record is not a missing one. */
  private loadFault: string | null = null;
  /** True when an earlier build's in-workspace trust.json was found and not honored. */
  private legacyIgnored = false;
  /** True when this process's last answer could not be saved: the register's lack of a row does not withdraw it. */
  private unsavedLevel = false;
  private question: WorkspaceTrustQuestion | null = null;
  private readonly levelListeners = new Set<(level: WorkspaceTrustLevel) => void>();
  /** The directory judged, as its real path: the key of the decision. */
  readonly workspaceRoot: string;
  private readonly legacyFile: string;
  private readonly registerPath: string;
  private readonly store: WorkspaceRegistrationStore;

  constructor(options: WorkspaceTrustManagerOptions) {
    const { shellPaths } = options;
    this.workspaceRoot = canonicalWorkspaceRoot(shellPaths.workingDirectory);
    this.legacyFile = shellPaths.resolveProjectPath(options.surfaceRoot, LEGACY_TRUST_FILE);
    this.registerPath = sharedWorkspaceRegisterPath(shellPaths);
    const daemonStateDir = shellPaths.resolveUserPath();
    this.store = options.store ?? openWorkspaceRegistrationStore({
      path: this.registerPath,
      homeDir: dirname(daemonStateDir),
      daemonStateDir,
    });
  }

  /**
   * Load this directory's decision from the user's register, if one exists. A
   * directory with no decision stays undecided (the gate treats it as
   * restricted, and the first non-read tool request raises the trust
   * question); a `trust.json` inside the directory is noted, never honored.
   *
   * Once loaded, each call costs one stat of the register: when another
   * process changed it (a restriction set in another app), it is read again and
   * a changed level reaches every {@link onLevelChanged} listener.
   */
  async load(): Promise<void> {
    if (this.loaded) {
      if (fileIdentity(this.registerPath) === this.registerIdentity) return;
      this.loaded = false;
    }
    const revision = this.revision;
    const levelBefore = this.getLevel();
    const identity = fileIdentity(this.registerPath);
    let fault: string | null = null;
    const persisted = await this.store.trustDecision(this.workspaceRoot).catch((error: unknown) => {
      fault = `the workspace register ${this.registerPath} could not be read (${summarizeError(error)})`;
      return null;
    });
    if (this.loaded || this.revision !== revision) return;
    // Every completed read states its own outcome: a readable register clears
    // an earlier fault, an unreadable one sets it.
    this.loadFault = fault;
    if (fault !== null) {
      // The register exists but is unusable, so a decision may have been
      // recorded (possibly a restriction). Autonomous callers stay restricted
      // until the owner decides again; a person at the keyboard is simply asked.
      logger.warn('workspace trust: the saved trust decision could not be read; autonomous actions stay restricted until it is replaced', { file: this.registerPath, fault });
    }
    this.registerIdentity = identity;
    if (persisted) {
      // A decision on disk (another process's, a restriction included) takes effect.
      this.level = persisted.level;
      this.unsavedLevel = false;
    } else if (this.unsavedLevel) {
      // This process's answer never reached the register, so its absence there
      // is not a removal by another process: the answer stays for this session.
    } else if (fault === null && this.level !== null && !this.legacyIgnored) {
      // The decision was removed from the register by another process: undecided again.
      this.level = null;
    } else if (fault === null && existsSync(this.legacyFile)) {
      this.legacyIgnored = true;
      logger.info('workspace trust: a trust decision stored inside the workspace is not honored; the owner is asked once more', { file: this.legacyFile });
    }
    this.loaded = true;
    this.revision++;
    if (this.getLevel() !== levelBefore) this.notifyLevelChanged();
  }

  private notifyLevelChanged(): void {
    const level = this.getLevel();
    for (const listener of [...this.levelListeners]) {
      try { listener(level); } catch (error) { logger.warn('workspace trust: a listener for the trust level failed', { workspace: this.workspaceRoot, level, error: summarizeError(error) }); }
    }
  }

  /**
   * The workspace's one trust question: the open one, or a new one raised with
   * `requestTrustDecision`. The answer is recorded before the question settles,
   * so every waiter sees the decision in effect. A question that could not be
   * answered (cancelled, nobody to ask) closes, and the next request asks again.
   */
  trustQuestion(requestTrustDecision: () => Promise<WorkspaceTrustLevel>): WorkspaceTrustQuestion {
    if (this.question) return this.question;
    const answer = (async () => {
      const level = await requestTrustDecision();
      const saved = await this.setLevel(level);
      if (!saved.saved) {
        logger.warn('workspace trust: the answer applies to this session but could not be saved, so it will be asked again next time', { workspace: this.workspaceRoot, fault: saved.fault });
      }
      return level;
    })().finally(() => { this.question = null; });
    // A waiter may have gone; the question's own failure is reported to the ones still waiting.
    answer.catch(() => undefined);
    const question: WorkspaceTrustQuestion = { answer, openedAt: Date.now() };
    this.question = question;
    return question;
  }

  /** True when the directory carries an earlier build's `trust.json`, which is not honored. */
  hasIgnoredLegacyDecision(): boolean {
    return this.legacyIgnored;
  }

  /** A per-action constraint, never a saved grant for an undecided workspace. */
  async prepareAutonomousConstraint(category: PermissionCategory, signal?: AbortSignal): Promise<() => void> {
    if (this.pendingDecisions > 0) throw new Error('Workspace trust decision is pending');
    const decisionRevision = this.decisionRevision;
    // load() sees another process's decision (a downgrade in another app): one
    // stat of the register, read again when it moved.
    await awaitPermission(() => this.load(), signal);
    if (this.decisionRevision !== decisionRevision) throw new Error('Workspace trust changed during autonomous preparation');
    // Dispatch reads the decision in effect now, not the one seen at preparation:
    // the call's own ask may raise the trust question, and its answer must let
    // the call that asked run (or stop it, when the answer was a restriction).
    const assertCurrent = () => {
      assertPermissionActive(signal);
      if (this.pendingDecisions > 0) throw new Error('Workspace trust decision is pending');
      if (this.loadFault !== null && !this.isDecided() && !this.isCategoryAllowed(category)) {
        throw new Error(`Workspace trust record is unreadable (${this.loadFault}), so this workspace is treated as restricted for autonomous work. Choose a trust level to replace it.`);
      }
      if (this.isDecided() && !this.isCategoryAllowed(category)) throw new Error('Explicit restricted workspace forbids this operation');
    };
    assertCurrent();
    return assertCurrent;
  }

  isDecided(): boolean {
    return this.level !== null;
  }

  /** Why the saved decision could not be read, or null when it was read or never existed. */
  getLoadFault(): string | null {
    return this.loadFault;
  }

  /** Undecided workspaces read as 'restricted', the safe default before a choice. */
  getLevel(): WorkspaceTrustLevel {
    return this.level ?? 'restricted';
  }

  isTrusted(): boolean {
    return this.level === 'trusted';
  }

  /**
   * Called each time this workspace's trust level changes (RepositoryTrust):
   * the owner decided in this process, or {@link load} found another process's
   * decision. Returns the unsubscribe.
   */
  onLevelChanged(listener: (level: WorkspaceTrustLevel) => void): () => void {
    this.levelListeners.add(listener);
    return () => { this.levelListeners.delete(listener); };
  }

  /**
   * Record the owner's decision. It takes effect at once for this process; the
   * save to the user's register only spares asking again next time, so a save
   * that fails is reported (`saved: false`) rather than withdrawing the answer.
   */
  async setLevel(level: WorkspaceTrustLevel): Promise<{ readonly saved: boolean; readonly fault?: string | undefined }> {
    ++this.decisionRevision;
    this.revision++;
    const changed = level !== this.getLevel();
    this.level = level;
    this.loaded = true;
    this.legacyIgnored = false;
    this.pendingDecisions++;
    try {
      await this.store.setTrust(this.workspaceRoot, level);
      this.unsavedLevel = false;
      this.loadFault = null;
      // This process's own write: the decision in memory is the one on disk.
      this.registerIdentity = fileIdentity(this.registerPath);
      return { saved: true };
    } catch (error) {
      this.unsavedLevel = true;
      return { saved: false, fault: `the workspace register ${this.registerPath} could not be written (${summarizeError(error)})` };
    } finally {
      this.pendingDecisions--;
      // The decision is in effect for this process either way: what waited on
      // trust starts now, and what a restriction holds back stops now.
      if (changed) this.notifyLevelChanged();
    }
  }

  /**
   * The restriction rule the permission machinery consults. Read tools always
   * run (read-only exploration is the whole point of "restricted"); every other
   * category (write / execute / delegate) is denied until the workspace is
   * trusted.
   */
  isCategoryAllowed(category: PermissionCategory): boolean {
    if (this.isTrusted()) return true;
    return category === 'read';
  }
}
