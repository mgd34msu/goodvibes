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
import { normalizeWorkspaceRoot } from '../workspace/registration/resolution.js';
import { logger } from '../utils/logger.js';
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
    if (options.waitMs === undefined) {
      await awaitPermission(() => question.answer, signal);
    } else {
      const remaining = question.openedAt + options.waitMs - Date.now();
      if (remaining <= 0) return unanswered;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answered = await awaitPermission(() => Promise.race([
        question.answer.then(() => true),
        new Promise<false>((resolveWait) => { timer = setTimeout(() => resolveWait(false), remaining); }),
      ]), signal).finally(() => clearTimeout(timer));
      if (!answered) return unanswered;
    }
    assertPermissionActive(signal);
    if (manager.isCategoryAllowed(request.category)) return ask(request, execution);
    return { approved: false };
  };
}

export type WorkspaceTrustLevel = 'trusted' | 'restricted';

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
  private revision = 0;
  private decisionRevision = 0;
  private pendingDecisions = 0;
  /** Why the register could not be read, or null. A damaged record is not a missing one. */
  private loadFault: string | null = null;
  /** True when an earlier build's in-workspace trust.json was found and not honored. */
  private legacyIgnored = false;
  private question: WorkspaceTrustQuestion | null = null;
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
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    const revision = this.revision;
    let fault: string | null = null;
    const persisted = await this.store.trustDecision(this.workspaceRoot).catch((error: unknown) => {
      fault = `the workspace register ${this.registerPath} could not be read (${summarizeError(error)})`;
      return null;
    });
    if (this.loaded || this.revision !== revision) return;
    if (fault !== null) {
      // The register exists but is unusable, so a decision may have been
      // recorded (possibly a restriction). Autonomous callers stay restricted
      // until the owner decides again; a person at the keyboard is simply asked.
      this.loadFault = fault;
      logger.warn('workspace trust: the saved trust decision could not be read; autonomous actions stay restricted until it is replaced', { file: this.registerPath, fault });
    }
    if (persisted) {
      this.level = persisted.level;
    } else if (fault === null && existsSync(this.legacyFile)) {
      this.legacyIgnored = true;
      logger.info('workspace trust: a trust decision stored inside the workspace is not honored; the owner is asked once more', { file: this.legacyFile });
    }
    this.loaded = true;
    this.revision++;
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
    await awaitPermission(() => this.load(), signal);
    if (this.decisionRevision !== decisionRevision) throw new Error('Workspace trust changed during autonomous preparation');
    const revision = this.revision;
    const assertCurrent = () => {
      assertPermissionActive(signal);
      if (this.pendingDecisions > 0) throw new Error('Workspace trust decision is pending');
      if (this.revision !== revision) throw new Error('Workspace trust changed before autonomous dispatch');
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
   * Record the owner's decision. It takes effect at once for this process; the
   * save to the user's register only spares asking again next time, so a save
   * that fails is reported (`saved: false`) rather than withdrawing the answer.
   */
  async setLevel(level: WorkspaceTrustLevel): Promise<{ readonly saved: boolean; readonly fault?: string | undefined }> {
    ++this.decisionRevision;
    this.revision++;
    this.level = level;
    this.loaded = true;
    this.legacyIgnored = false;
    this.pendingDecisions++;
    try {
      await this.store.setTrust(this.workspaceRoot, level);
      this.loadFault = null;
      return { saved: true };
    } catch (error) {
      return { saved: false, fault: `the workspace register ${this.registerPath} could not be written (${summarizeError(error)})` };
    } finally {
      this.pendingDecisions--;
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
