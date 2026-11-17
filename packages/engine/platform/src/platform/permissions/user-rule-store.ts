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
 * Storage: one JSON file per surface in the user's control-plane config dir
 * (shared by every project), atomic writes via PersistentStore; ':memory:' for
 * tests. A rule remembered from a prompt carries the project root it was made
 * in and matches only there; a rule with no project key (written before
 * rules were scoped, or by hand) matches in every project, as it always did.
 *
 * Project-scoped rules are stored under `projectRules`, apart from `rules`.
 * An earlier release reads only `rules` and would apply a project key it does
 * not know about in every project; leaving scoped rules out of `rules` makes
 * it ask again instead.
 *
 * Every change re-reads the file inside a process lock, so a second process
 * (another window on the same config directory) neither brings back a rule
 * this one deleted nor drops one it added. Readers notice a file another
 * process replaced the next time they ask for rules, so a rule revoked in one
 * window stops matching in the others without a restart.
 */

import { readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { PolicyRule } from '../runtime/permissions/types.js';
import { PersistentStore } from '../state/persistent-store.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import { withProcessLock } from '../utils/process-lock.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { revisionSource, type RevisionSource } from '../utils/revision.js';
import { ruleCovers, type RememberTier } from './approval-rules.js';

/** A stored rule plus its provenance. */
export interface StoredUserPermissionRule {
  readonly rule: PolicyRule;
  readonly createdAt: number;
  /** The remember tier that produced this rule. */
  readonly tier: Exclude<RememberTier, 'session'>;
  /** The tool whose ask produced the rule (display context). */
  readonly tool: string;
  /** The project root the rule was remembered in; absent means it applies in every project. */
  readonly project?: string | undefined;
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
  /** Rules scoped to one project; absent when there are none. */
  projectRules?: StoredUserPermissionRule[];
}

function isStoredRule(record: unknown): record is StoredUserPermissionRule {
  return !!record && typeof record === 'object' && !!(record as StoredUserPermissionRule).rule;
}

/** Every well-formed record in a file, scoped ones included, once per rule id. */
function recordsOf(data: UserRuleFile | null): StoredUserPermissionRule[] {
  const out: StoredUserPermissionRule[] = [];
  const seen = new Set<unknown>();
  for (const list of [data?.rules, data?.projectRules]) {
    if (!Array.isArray(list)) continue;
    for (const record of list) {
      if (!isStoredRule(record) || seen.has(record.rule.id)) continue;
      seen.add(record.rule.id);
      out.push(record);
    }
  }
  return out;
}

function fileOf(records: readonly StoredUserPermissionRule[]): UserRuleFile {
  const projectRules = records.filter((record) => record.project !== undefined);
  return {
    version: 1,
    rules: records.filter((record) => record.project === undefined),
    ...(projectRules.length > 0 ? { projectRules } : {}),
  };
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
    readonly byProject: Map<string, { readonly committed: readonly PolicyRule[]; readonly remembered: readonly PolicyRule[] }>;
  } | null = null;
  readonly #revisionSource = revisionSource('permission rules', () => { this.refreshFromDisk(); return this.#changeRevision; });
  /** Whole mutations run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.store = new PersistentStore<UserRuleFile>(filePath);
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
      const data = await this.store.load();
      if (data && (Array.isArray(data.rules) || Array.isArray(data.projectRules))) {
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
    // While the directory is watched, nothing to take in until it reports a change.
    if (this.#diskWatcher && !this.#diskDirty) return;
    this.#diskDirty = false;
    const signature = this.signatureOfFile();
    if (signature === this.diskSignature) return;
    this.diskSignature = signature;
    if (signature === 'absent') { this.adoptDisk([]); return; }
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf-8')) as UserRuleFile | null;
      if (data && (Array.isArray(data.rules) || Array.isArray(data.projectRules))) this.adoptDisk(recordsOf(data));
    } catch (error) {
      logger.warn('user permission rule store changed on disk but could not be read; keeping the rules already loaded', { error: summarizeError(error) });
    }
  }

  /**
   * Another process's write is noticed by a watch on the rules file's
   * directory, so a permission check does not `stat` the file each time.
   * Where the directory cannot be watched every read stats the file instead.
   * The watch never keeps the process alive.
   */
  #diskWatcher: FSWatcher | null | undefined;
  #diskDirty = true;
  #watchDisk(): void {
    if (this.#diskWatcher !== undefined) return;
    this.#diskWatcher = null;
    if (this.store.lockPath === null) return;
    const name = basename(this.filePath);
    try {
      const watcher = watch(dirname(this.filePath), { persistent: false }, (_event, changed) => {
        if (!changed || String(changed) === name) this.#diskDirty = true;
      });
      watcher.on('error', () => {
        try { watcher.close(); } catch { /* already closed */ }
        if (this.#diskWatcher === watcher) this.#diskWatcher = null;
        this.#diskDirty = true;
      });
      (watcher as FSWatcher & { unref?: () => void }).unref?.();
      this.#diskWatcher = watcher;
    } catch { /* not watchable: every read stats the file */ }
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

  /** All stored rules, including ones remembered during this process, newest first. */
  list(): readonly StoredUserPermissionRule[] {
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
   * process's write once (one `stat`), with the publication revision they
   * stand under. Both lists are frozen and shared until a rule changes.
   */
  evaluationRules(project?: string | null): { readonly committed: readonly PolicyRule[]; readonly remembered: readonly PolicyRule[]; readonly revision: number } {
    this.refreshFromDisk();
    return { ...this.compiledFor(project), revision: this.publicationRevision };
  }

  private compiledFor(project: string | null | undefined): { readonly committed: readonly PolicyRule[]; readonly remembered: readonly PolicyRule[] } {
    let compiled = this.#compiled;
    if (!compiled || compiled.records !== this.records || compiled.remembered !== this.remembered) {
      compiled = { records: this.records, remembered: this.remembered, byProject: new Map() };
      this.#compiled = compiled;
    }
    const key = project === undefined ? '\0every' : project === null ? '\0none' : project;
    let lists = compiled.byProject.get(key);
    if (!lists) {
      const applies = (record: StoredUserPermissionRule) => project === undefined || appliesIn(record, project);
      lists = Object.freeze({
        committed: Object.freeze(this.records.filter(applies).map(ruleForEvaluation)),
        remembered: Object.freeze(this.remembered.filter(applies).map(ruleForEvaluation)),
      });
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
  }

  /**
   * Keep a rule from an owner's answer: written to disk before it is matched,
   * so it survives a restart, without changing rules() or the publication
   * revision that admitted calls are bound to. Refuses while the file is
   * unreadable, so a write never replaces rules it could not load.
   */
  async remember(record: StoredUserPermissionRule): Promise<void> {
    await this.awaitReady();
    await this.mutate((disk) => {
      // A rule already stored for every project, or for this one, that decides
      // everything the answer does: nothing new to keep.
      if (disk.some((other) => other.rule.id !== record.rule.id && (other.project === undefined || other.project === record.project)
        && ruleCovers(other.rule, record.rule))) return null;
      // Rules of this project the answer now covers go: the list stays one rule per decision the owner made.
      const covered = new Set(disk.filter((other) => other.rule.id !== record.rule.id && other.project === record.project
        && ruleCovers(record.rule, other.rule)).map((other) => other.rule.id));
      const next = [...disk.filter((existing) => existing.rule.id !== record.rule.id && !covered.has(existing.rule.id)), record];
      // adoptDisk keeps the written record, as a remembered rule.
      return { next, covered, publish: () => undefined };
    });
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
  } | null): Promise<void> {
    return this.writes.run(async () => {
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
    const ids = new Set(written.map((record) => record.rule.id));
    const committed = this.records.filter((record) => ids.has(record.rule.id));
    const known = new Set([...committed, ...this.remembered].map((record) => record.rule.id));
    const remembered = [
      ...this.remembered.filter((record) => ids.has(record.rule.id)),
      ...written.filter((record) => !known.has(record.rule.id)),
    ];
    const dropped = this.records.some((record) => !ids.has(record.rule.id) && !covered?.has(record.rule.id));
    if (dropped) this.publicationRevision++;
    // Every call follows a write, this process's or another's.
    this.#changeRevision++;
    this.records = committed;
    this.remembered = remembered;
    return dropped;
  }
}
