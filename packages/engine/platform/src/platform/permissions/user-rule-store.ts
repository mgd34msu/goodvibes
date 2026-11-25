/**
 * Durable user-origin permission rules, approval decisions that persist.
 *
 * A "remember" decision with a generalizing tier (exact command / command
 * class / path scope / whole tool) writes a PolicyRule with origin 'user'
 * here. PermissionManager consults these rules live before ever prompting
 * (without copying them into its session-only map), and evaluateRuntimePolicy
 * folds them into the layered evaluator when the policy engine flag is on,
 * user rules are evaluated ahead of managed rules there.
 *
 * Storage: one JSON file for the owner, shared by every program and every
 * project (ownerPermissionRulesPath), atomic writes via PersistentStore; ':memory:' for
 * tests. A rule remembered from a prompt carries the project root it was made
 * in and matches only there; a rule with no project key (written by hand)
 * matches in every project.
 *
 * Every rule is written to `rules`, its project key with it.
 *
 * Every change re-reads the file inside a process lock, so a second process
 * (another window on the same config directory) neither brings back a rule
 * this one deleted nor drops one it added. Readers notice a file another
 * process replaced the next time they ask for rules, so a rule revoked in one
 * window stops matching in the others without a restart.
 */

import { isDeepStrictEqual } from 'node:util';
import { existsSync, readFileSync, rmSync, statSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PolicyRule } from '../runtime/permissions/types.js';
import { PersistentStore } from '../state/persistent-store.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import { withProcessLock } from '../utils/process-lock.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { revisionSource, type RevisionSource } from '../utils/revision.js';
import { compileRules, ruleCovers, type CompiledRules, type RememberTier } from './approval-rules.js';
import { contentDigest } from '../utils/target-ref.js';
import { noteCarriedForward } from '../state/carried-forward.js';
import { noteListChanged } from '../runtime/list-changes.js';

/** One project's rules for evaluation: the committed and remembered lists, and both compiled for matching. */
export interface CompiledProjectRules {
  readonly committed: readonly PolicyRule[];
  readonly remembered: readonly PolicyRule[];
  /** committed then remembered, compiled once; matched by the gate without copying either list. */
  readonly lookup: CompiledRules;
}

/** A stored rule plus its provenance. */
export interface StoredUserPermissionRule {
  readonly rule: PolicyRule;
  readonly createdAt: number;
  /**
   * The remember tier that produced this rule, or the kind the owner added
   * directly (`/permissions add`): one of those tiers, or `never-run` for a
   * "never run commands matching" rule.
   */
  readonly tier: Exclude<RememberTier, 'session'> | 'never-run';
  /** The tool whose ask produced the rule (display context). */
  readonly tool: string;
  /** The project root the rule was remembered in; absent means it applies in every project. */
  readonly project?: string | undefined;
}

/**
 * Longest a watched rules file goes without a stat: a change another process
 * made reaches this one within this bound even if the directory watch goes quiet.
 */
const USER_RULE_STALENESS_MS = 2_000;

/**
 * The one file the owner's permission rules live in: `~/.goodvibes/shared/permission-rules.json`
 * under the home every program resolves (`GOODVIBES_HOME` moves it). The terminal app, the
 * Agent and the daemon all read and write it, so a rule added, remembered or removed in one
 * holds in the others without a restart; a rule remembered in a project keeps its project key
 * and matches only there. A configuration with no home directory keeps its rules beside its
 * own settings.
 */
export function ownerPermissionRulesPath(config: { getHomeDirectory(): string | null; getControlPlaneConfigDir(): string }): string {
  const home = config.getHomeDirectory();
  return home ? join(home, '.goodvibes', 'shared', 'permission-rules.json') : join(config.getControlPlaneConfigDir(), 'permission-rules.json');
}

/**
 * Where 3.3.1 and earlier kept the rules: each program's own control-plane
 * config directory, `~/.goodvibes/tui` (the terminal app and the daemon) and
 * `~/.goodvibes/agent`. Read once, by the first program that finds the shared
 * file missing (UserPermissionRuleStore).
 */
export function previousOwnerPermissionRuleFiles(config: { getHomeDirectory(): string | null }): readonly string[] {
  const home = config.getHomeDirectory();
  return home ? ['tui', 'agent'].map((surface) => join(home, '.goodvibes', surface, 'permission-rules.json')) : [];
}

/** The identity a rule's project key is compared by: the resolved project root path. */
export function projectIdentity(root: string): string {
  return resolve(root);
}

function appliesIn(record: StoredUserPermissionRule, project: string | null | undefined): boolean {
  if (record.project === undefined) return true;
  return typeof project === 'string' && project.length > 0 && projectIdentity(project) === record.project;
}

interface UserRuleFile extends Record<string, unknown> {
  version: 1;
  rules: StoredUserPermissionRule[];
}

function isStoredRule(record: unknown): record is StoredUserPermissionRule {
  return !!record && typeof record === 'object' && !!(record as StoredUserPermissionRule).rule;
}

/** Every well-formed record in a file, scoped ones included, once per rule id. */
function recordsOf(data: UserRuleFile | null): StoredUserPermissionRule[] {
  const out: StoredUserPermissionRule[] = [];
  const seen = new Set<unknown>();
  if (!Array.isArray(data?.rules)) return out;
  for (const record of data.rules) {
    if (!isStoredRule(record) || seen.has(record.rule.id)) continue;
    seen.add(record.rule.id);
    out.push(record);
  }
  return out;
}

function fileOf(records: readonly StoredUserPermissionRule[]): UserRuleFile {
  return { version: 1, rules: [...records] };
}

/** Preserve the bare-token behavior of stored, explicitly class-scoped rules. */
function ruleForEvaluation(record: StoredUserPermissionRule): PolicyRule {
  const { rule, tier } = record;
  if (tier !== 'command-class' || rule.type !== 'prefix' || rule.exactCommandMatch !== undefined) return rule;
  const classes = rule.exactCommands;
  const prefixes = rule.commandPrefixes;
  // The old class builder emitted exactly this shape. A missing/invalid tier,
  // arbitrary exact payload, or unknown match option does not gain breadth.
  if (!Array.isArray(classes) || classes.length === 0 || !Array.isArray(prefixes)
    || prefixes.length !== classes.length || new Set(classes).size !== classes.length
    || new Set(prefixes).size !== prefixes.length || !classes.every((command) =>
      typeof command === 'string' && command.length > 0 && !/\s/.test(command)
      && command === command.toLowerCase() && prefixes.includes(`${command} `))) return rule;
  return { ...rule, exactCommandMatch: 'command-class' };
}

/** One load attempt; its failure stays with it, so a retry never answers for an older attempt. */
interface RuleLoadOutcome {
  failure?: { readonly error: unknown };
}
interface RuleLoad extends RuleLoadOutcome {
  readonly promise: Promise<void>;
}

export class UserPermissionRuleStore {
  private readonly store: PersistentStore<UserRuleFile>;
  private readonly filePath: string;
  private records: StoredUserPermissionRule[] = [];
  /**
   * Rules remembered from an owner's answer during this process: on disk with
   * the committed records, but kept out of rules() and the publication
   * revision, so recording one never invalidates a call already admitted.
   * The permission manager matches them live; a restart loads them as records.
   */
  private remembered: StoredUserPermissionRule[] = [];
  private load: RuleLoad | undefined;
  /** What the file looked like when this process last read or wrote it; null until the first load succeeds. */
  private diskSignature: string | null = null;
  private publicationRevision = 0;
  /**
   * Moves on every change to what rules() or rememberedRules() return: a load,
   * an add, a remembered rule, a delete, and another process's write. Unlike
   * the publication revision it also covers remembered rules.
   */
  #changeRevision = 0;
  /**
   * The evaluation lists per project, built from the record arrays they were
   * made from. Every change replaces `records` or `remembered` (never edits
   * them in place), so an identity compare says whether a list is current and
   * a check does not filter and convert every rule again.
   */
  #compiled: {
    readonly records: readonly StoredUserPermissionRule[];
    readonly remembered: readonly StoredUserPermissionRule[];
    readonly byProject: Map<string, CompiledProjectRules>;
  } | null = null;
  readonly #revisionSource = revisionSource('permission rules', () => { this.refreshFromDisk(); return this.#changeRevision; });
  /** Whole mutations run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  readonly #previousFiles: readonly string[];

  constructor(filePath: string, options: { readonly previousFiles?: readonly string[] | undefined } = {}) {
    this.filePath = filePath;
    this.store = new PersistentStore<UserRuleFile>(filePath);
    this.#previousFiles = options.previousFiles ?? [];
  }

  /** One shared initial load, retaining the legacy logged, empty-rule fallback. */
  init(): Promise<void> {
    // Publish the load before entering it, including reentrant callers.
    return (this.load ??= this.startLoad()).promise;
  }

  /**
   * Authoritative readiness cannot turn the legacy unavailable-store fallback
   * into permission. A failed load is retried here, so a transient read error
   * or a repaired file recovers without a restart; while it still fails, the
   * refusal names the file to fix.
   */
  async awaitReady(): Promise<void> {
    await this.init();
    let attempt = this.load!;
    if (attempt.failure) {
      // Concurrent callers share one retry; none can read an older attempt's result as success.
      if (this.load === attempt) this.load = this.startLoad();
      attempt = this.load!;
      await attempt.promise;
    }
    if (attempt.failure) {
      throw new Error(`Permission rules file ${this.filePath} could not be read (${summarizeError(attempt.failure.error)}). `
        + 'Fix the file, or remove it to start with no remembered rules; tool calls are refused until it loads.', { cause: attempt.failure.error });
    }
  }

  private startLoad(): RuleLoad {
    const outcome: RuleLoadOutcome = {};
    return Object.assign(outcome, { promise: Promise.resolve().then(() => this.loadInitialRules(outcome)) });
  }

  private async loadInitialRules(attempt: RuleLoadOutcome): Promise<void> {
    try {
      let data = await this.store.load();
      if (data === null && this.#previousFiles.length > 0 && this.store.lockPath !== null) data = await this.#carryForwardPreviousFiles();
      if (data && Array.isArray(data.rules)) {
        this.records = recordsOf(data);
      }
    } catch (error) {
      // A corrupt store must not silently grant or deny anything, start
      // empty (every ask prompts again) and say so.
      logger.warn('user permission rule store unreadable; starting with no durable rules', {
        error: summarizeError(error),
      });
      this.records = [];
      // Keep init's legacy resolution, but retain failure for authoritative
      // readiness, which retries; a failed load never publishes an empty one.
      attempt.failure = { error };
      return;
    }
    this.diskSignature = this.signatureOfFile();
    this.publicationRevision++;
    this.#changeRevision++;
  }

  /**
   * 3.3.1 kept each program's rules in a file of its own
   * (previousOwnerPermissionRuleFiles). While the shared file does not exist,
   * the rules of those files are written to it, once per rule id, and only
   * then are the old files removed, so this runs once. With no old file
   * there it costs one stat per old path and writes nothing. An old file that
   * cannot be read is left in place and named.
   */
  async #carryForwardPreviousFiles(): Promise<UserRuleFile | null> {
    if (!this.#previousFiles.some((file) => existsSync(file))) return null;
    return withProcessLock(`${this.filePath}.writer.sqlite`, async () => {
      const current = await this.store.load();
      if (current !== null) return current;
      const carried: string[] = [];
      const rules: StoredUserPermissionRule[] = [];
      for (const file of this.#previousFiles) {
        let data: UserRuleFile | null;
        try {
          data = JSON.parse(readFileSync(file, 'utf-8')) as UserRuleFile | null;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn('Permission rules saved by an earlier version could not be read and were left in place', { file, error: summarizeError(error) });
          }
          continue;
        }
        carried.push(file);
        rules.push(...recordsOf(data));
      }
      const next = fileOf(recordsOf(fileOf(rules)));
      await this.store.persist(next, { durable: true });
      for (const file of carried) rmSync(file, { force: true });
      noteCarriedForward('remembered permission rule', next.rules.length);
      logger.info('Permission rules saved by an earlier version were carried into the shared rules file', { from: carried, to: this.filePath, rules: next.rules.length });
      return next;
    });
  }

  private signatureOfFile(): string {
    try {
      const stat = statSync(this.filePath);
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return 'absent';
    }
  }

  /**
   * Take in a file another process replaced. A file this process cannot read
   * leaves what is in memory alone: an unreadable file neither grants nor
   * revokes anything, and the next write refuses until it is fixed.
   */
  private refreshFromDisk(): void {
    if (this.diskSignature === null) return;
    this.#watchDisk();
    // While a watch that has delivered events covers the directory, nothing to
    // take in until it reports a change, or until the last stat is older than
    // the staleness bound (a watch can go quiet: network and 9p mounts, missed events).
    const now = Date.now();
    if (this.#diskWatcher && this.#watchDelivers && !this.#diskDirty
      && now - this.#lastDiskStatAt < USER_RULE_STALENESS_MS) return;
    this.#diskDirty = false;
    this.#lastDiskStatAt = now;
    const signature = this.signatureOfFile();
    if (signature === this.diskSignature) return;
    if (signature === 'absent') { this.diskSignature = signature; this.adoptDisk([]); return; }
    // The new signature is taken only once the file was read, so a read that
    // failed is tried again at the next check instead of being skipped as seen.
    let problem: string;
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf-8')) as UserRuleFile | null;
      if (data && Array.isArray(data.rules)) {
        this.adoptDisk(recordsOf(data));
        this.diskSignature = signature;
        this.#unreadSignature = null;
        return;
      }
      problem = 'it holds no "rules" list';
    } catch (error) {
      problem = summarizeError(error);
    }
    this.#diskDirty = true;
    if (this.#unreadSignature !== signature) {
      this.#unreadSignature = signature;
      logger.warn('user permission rule store changed on disk but could not be read; keeping the rules already loaded until it can be', { error: problem });
    }
  }

  /** The file version last found unreadable, so its warning is logged once while each check retries it. */
  #unreadSignature: string | null = null;

  /**
   * Another process's write is noticed by a watch on the rules file's
   * directory, so a permission check does not `stat` the file each time.
   * Where the directory cannot be watched every read stats the file instead.
   * The watch never keeps the process alive.
   *
   * Any event in the directory marks the file for one stat: a quick atomic
   * write (temporary file, then rename) is reported as one event naming the
   * temporary file, so an event filtered to the rules file's own name would
   * miss another process's change, a revoked rule included, for good.
   *
   * `fs.watch` can open and then deliver nothing (network and 9p mounts, a
   * Windows drive under WSL). Until the watch has delivered one event (this
   * process's own write produces one) every read stats the file; after that a
   * read stats at most once per staleness bound when no event arrived.
   */
  #diskWatcher: FSWatcher | null | undefined;
  #diskDirty = true;
  #watchDelivers = false;
  #lastDiskStatAt = 0;
  #watchDisk(): void {
    if (this.#diskWatcher !== undefined) return;
    this.#diskWatcher = null;
    if (this.store.lockPath === null) return;
    try {
      const watcher = watch(dirname(this.filePath), { persistent: false }, () => {
        this.#diskDirty = true;
        this.#watchDelivers = true;
        this.#wakeHeard();
      });
      watcher.on('error', () => {
        try { watcher.close(); } catch { /* already closed */ }
        if (this.#diskWatcher === watcher) this.#diskWatcher = null;
        this.#diskDirty = true;
        this.#wakeHeard();
      });
      (watcher as FSWatcher & { unref?: () => void }).unref?.();
      this.#diskWatcher = watcher;
    } catch { /* not watchable: every read stats the file */ }
  }

  #heardWaiters: (() => void)[] = [];

  #wakeHeard(): void {
    if (this.#heardWaiters.length === 0) return;
    const waiters = this.#heardWaiters;
    this.#heardWaiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * Resolves once the next read takes in what is on disk now: at once when
   * that read stats the file anyway (a change already reported and not yet
   * taken in, no watch, or a watch that has not delivered yet), else at the
   * directory watch's next report. For a caller that knows another process
   * wrote and wants this store to have heard it; nothing polls.
   */
  diskChangeHeard(): Promise<void> {
    this.#watchDisk();
    if (this.#diskDirty || !this.#diskWatcher || !this.#watchDelivers) return Promise.resolve();
    return new Promise<void>((resolve) => { this.#heardWaiters.push(resolve); });
  }

  /**
   * Release the directory watch. It is not opened again: after close every
   * read stats the file, as where the directory cannot be watched, and a
   * caller waiting to hear a change is answered at once.
   */
  close(): void {
    const watcher = this.#diskWatcher;
    this.#diskWatcher = null;
    if (watcher) {
      try { watcher.close(); } catch { /* already closed */ }
    }
    this.#diskDirty = true;
    this.#wakeHeard();
  }

  /** Monotonic committed-publication identity, including same-value replacements. */
  getPublicationRevision(): number { return this.publicationRevision; }

  /**
   * The publication revision after taking in another process's write (one
   * stat). Rules remembered from an answer do not move it, so the answer never
   * invalidates the call it admitted; a deletion or a foreign change does.
   */
  committedRevision(): number {
    this.refreshFromDisk();
    return this.publicationRevision;
  }

  /** Every rule change as a revision source. Reading it takes in another process's write first (one stat). */
  get revisionSource(): RevisionSource { return this.#revisionSource; }

  /**
   * All stored rules, including ones remembered during this process, newest
   * first, after taking in another program's change (the one file is shared).
   */
  list(): readonly StoredUserPermissionRule[] {
    this.refreshFromDisk();
    return [...this.records, ...this.remembered].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Just the committed PolicyRules, for evaluation (insertion order). With a
   * project, rules remembered in another project are left out; without one,
   * every rule is returned.
   */
  rules(project?: string | null): readonly PolicyRule[] {
    this.refreshFromDisk();
    return this.compiledFor(project).committed;
  }

  /** Rules remembered from an owner's answer during this process, matched after rules(). */
  rememberedRules(project?: string | null): readonly PolicyRule[] {
    this.refreshFromDisk();
    return this.compiledFor(project).remembered;
  }

  /**
   * rules() and rememberedRules() for one check, after taking in another
   * process's write once (one `stat`, none while the directory watch is quiet),
   * with the publication revision they stand under, and `lookup`: both lists
   * compiled for matching, committed first. All are frozen and shared by
   * reference until a rule changes.
   */
  evaluationRules(project?: string | null): CompiledProjectRules & { readonly revision: number } {
    this.refreshFromDisk();
    return { ...this.compiledFor(project), revision: this.publicationRevision };
  }

  private compiledFor(project: string | null | undefined): CompiledProjectRules {
    let compiled = this.#compiled;
    if (!compiled || compiled.records !== this.records || compiled.remembered !== this.remembered) {
      compiled = { records: this.records, remembered: this.remembered, byProject: new Map() };
      this.#compiled = compiled;
    }
    const key = project === undefined ? '\0every' : project === null ? '\0none' : project;
    let lists = compiled.byProject.get(key);
    if (!lists) {
      const applies = (record: StoredUserPermissionRule) => project === undefined || appliesIn(record, project);
      const committed = Object.freeze(this.records.filter(applies).map(ruleForEvaluation));
      const remembered = Object.freeze(this.remembered.filter(applies).map(ruleForEvaluation));
      lists = Object.freeze({ committed, remembered, lookup: compileRules([...committed, ...remembered]) });
      compiled.byProject.set(key, lists);
    }
    return lists;
  }

  /** Publish a rule only after persistence succeeds; reject without changing state on failure. */
  async add(record: StoredUserPermissionRule): Promise<void> {
    await this.awaitReady();
    await this.mutate((disk) => {
      const next = [...disk.filter((existing) => existing.rule.id !== record.rule.id), record];
      return { next, publish: () => {
        this.remembered = this.remembered.filter((r) => r.rule.id !== record.rule.id);
        this.records = [...this.records.filter((r) => r.rule.id !== record.rule.id), record];
        this.publicationRevision++;
      } };
    });
    noteListChanged({ list: 'safety', change: 'created', id: record.rule.id });
  }

  /**
   * Keep a rule from an owner's answer: written to disk before it is matched,
   * so it survives a restart, without changing rules() or the publication
   * revision that admitted calls are bound to. Refuses while the file is
   * unreadable, so a write never replaces rules it could not load.
   */
  async remember(record: StoredUserPermissionRule): Promise<void> {
    await this.awaitReady();
    // A rule already stored for every project, or for this one, that decides
    // everything the answer does (the same rule kept under another id among
    // them): nothing new to keep.
    const kept = (rules: readonly StoredUserPermissionRule[]): boolean => rules.some((other) => other.rule.id !== record.rule.id
      && (other.project === undefined || other.project === record.project)
      && (ruleCovers(other.rule, record.rule) || isDeepStrictEqual({ ...other.rule, id: record.rule.id }, record.rule)));
    // Held here and unchanged on disk since (the approval broker keeps an answer's rule before the gate that asked
    // gets the answer): nothing to read or write.
    const keptHere = (): boolean => this.diskSignature !== null && this.diskSignature === this.signatureOfFile()
      && kept([...this.records, ...this.remembered]);
    await this.mutate((disk) => {
      if (kept(disk)) return null;
      // Rules of this project the answer now covers go: the list stays one rule per decision the owner made.
      const covered = new Set(disk.filter((other) => other.rule.id !== record.rule.id && other.project === record.project
        && ruleCovers(record.rule, other.rule)).map((other) => other.rule.id));
      const next = [...disk.filter((existing) => existing.rule.id !== record.rule.id && !covered.has(existing.rule.id)), record];
      // adoptDisk keeps the written record, as a remembered rule.
      return { next, covered, publish: () => undefined };
    }, keptHere);
    noteListChanged({ list: 'safety', change: 'changed', id: record.rule.id });
  }

  /**
   * Delete by rule id. Returns whether a committed rule was removed.
   * A failed write rejects and leaves the rule present, so revocation can be retried.
   * Refuses while the file is unreadable: a rule that could not be loaded is
   * not "not found".
   */
  async delete(ruleId: string): Promise<boolean> {
    await this.awaitReady();
    let removed = false;
    await this.mutate((disk) => {
      const next = disk.filter((record) => record.rule.id !== ruleId);
      const inMemory = this.records.some((record) => record.rule.id === ruleId)
        || this.remembered.some((record) => record.rule.id === ruleId);
      if (next.length === disk.length && !inMemory) return null;
      return { next, publish: (revisionMoved) => { if (!revisionMoved) this.publicationRevision++; removed = true; } };
    });
    if (removed) noteListChanged({ list: 'safety', change: 'deleted', id: ruleId });
    return removed;
  }

  /**
   * One whole change: take the file's advisory lock, read what is on disk now,
   * let `change` build the next file from that, write it, then publish to live
   * readers. Starting from the disk instead of this process's memory is what
   * keeps another process's deletions deleted and its additions kept. A rule
   * that is gone from the disk was deleted elsewhere: it stops matching here
   * (and, if it was committed, the publication revision moves so calls admitted
   * under it are refused); a rule another process added is matched live like
   * one remembered here.
   *
   * The whole read-modify-write-publish runs in the mutation queue, so each
   * change starts from the last commit even after a failure, and a failed
   * write never installs an uncommitted grant or removes a denial.
   */
  private mutate(change: (disk: StoredUserPermissionRule[]) => {
    next: StoredUserPermissionRule[];
    /** Rules dropped because the new one decides the same calls the same way; their removal grants or revokes nothing. */
    covered?: ReadonlySet<string>;
    publish: (revisionMoved: boolean) => void;
  } | null, unchanged?: () => boolean): Promise<void> {
    return this.writes.run(async () => {
      // Checked in the queue, after every earlier change landed.
      if (unchanged?.()) return;
      const update = async () => {
        const disk = recordsOf(await this.store.load());
        const planned = change(disk);
        if (!planned) return;
        await this.store.persist(fileOf(planned.next));
        this.diskSignature = this.signatureOfFile();
        const bumped = this.adoptDisk(planned.next, planned.covered);
        planned.publish(bumped);
      };
      // ':memory:' has no file another process could write.
      if (this.store.lockPath === null) await update();
      else await withProcessLock(`${this.filePath}.writer.sqlite`, update);
    });
  }

  /** Bring live readers in line with a file this process just wrote. */
  private adoptDisk(written: readonly StoredUserPermissionRule[], covered?: ReadonlySet<string>): boolean {
    // A rule is the same rule only when its id AND its content match the disk:
    // a rule another process changed in place under the same id is taken from
    // the disk, and the one held here stops matching (as a deleted one does).
    const onDisk = new Map(written.map((record) => [record.rule.id, contentDigest(record)]));
    const unchanged = (record: StoredUserPermissionRule): boolean => onDisk.get(record.rule.id) === contentDigest(record);
    const committed = this.records.filter(unchanged);
    const keptRemembered = this.remembered.filter(unchanged);
    const known = new Set([...committed, ...keptRemembered].map((record) => record.rule.id));
    const remembered = [
      ...keptRemembered,
      ...written.filter((record) => !known.has(record.rule.id)),
    ];
    const dropped = this.records.some((record) => !unchanged(record) && !covered?.has(record.rule.id));
    if (dropped) this.publicationRevision++;
    // Every call follows a write, this process's or another's.
    this.#changeRevision++;
    this.records = committed;
    this.remembered = remembered;
    return dropped;
  }
}
