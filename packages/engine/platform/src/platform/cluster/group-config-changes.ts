/** Event-driven production replication. The queue contains only finite policy
 * paths and original owner guards, never credential values or config bodies.
 */
import { ConfigReplicationPrivacyError, isSecretBearingConfigKey } from './config-replication-privacy.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { listReplicatedConfigPaths, replicatedSecretKeys } from './config-replication-policy.js';
import type { ReplicatedConfigStore, ReplicatedSecretStore } from './config-replication.js';
import type { ClusterLogger } from './types.js';
type ChangeKind = 'config' | 'secret';
interface Change { readonly kind: ChangeKind; readonly path: string; readonly seed: boolean; readonly assertCurrent: () => void }
interface Owner { readonly revision: number; readonly generation: number; readonly master: boolean }
interface ChangeHost {
  readonly config: ReplicatedConfigStore | undefined;
  readonly secrets: ReplicatedSecretStore;
  readonly logger: ClusterLogger;
  owner(): Owner | null;
  capture(): () => void;
  apply(change: Change): Promise<void>;
  retireLocal?(path: string): void;
}
export class GroupConfigChangeRetiredError extends Error {
  constructor() { super('Original local replicated change retired'); this.name = 'GroupConfigChangeRetiredError'; }
}
export class GroupConfigChanges {
  private readonly origin = new AsyncLocalStorage<{ readonly kind: ChangeKind; readonly key: string; active: boolean }>();
  private readonly pending = new Map<string, Change>();
  private unsubscribers: Array<() => void> = [];
  private active = false;
  private suspended = false;
  private task: Promise<void> | null = null;
  private seeded: Owner | null = null;
  private readonly originalConfig: ReplicatedConfigStore | undefined;
  private readonly originalSecrets: ReplicatedSecretStore;
  constructor(private readonly host: ChangeHost) { this.originalConfig = host.config; this.originalSecrets = host.secrets; }
  assertStoresCurrent(config: ReplicatedConfigStore | undefined, secrets: ReplicatedSecretStore): void {
    if (config !== this.originalConfig || secrets !== this.originalSecrets) throw new GroupConfigChangeRetiredError();
  }
  private remoteConfig(key: string, work: () => void): void {
    const source = { kind: 'config' as const, key, active: true };
    this.origin.run(source, () => { try { work(); } finally { source.active = false; } });
  }
  private remoteSecret(key: string, work: () => Promise<void>): Promise<void> {
    const source = { kind: 'secret' as const, key, active: true };
    return this.origin.run(source, async () => { try { await work(); } finally { source.active = false; } });
  }
  configStore(): ReplicatedConfigStore | undefined {
    const store = this.originalConfig; if (!store) return undefined;
    return { get: path => store.get(path), set: (path, value) => this.remoteConfig(path, () => store.set(path, value)),
      ...(store.reset ? { reset: (path: string) => this.remoteConfig(path, () => store.reset!(path)) } : {}) };
  }
  secretStore(): ReplicatedSecretStore {
    const store = this.originalSecrets;
    return { get: key => store.get(key), set: (key, value) => this.remoteSecret(key, () => store.set(key, value)),
      delete: key => this.remoteSecret(key, () => store.delete(key)) };
  }
  start(): void {
    if (this.active) return; this.active = true; this.suspended = false;
    try {
      const config = this.originalConfig;
      if (config?.subscribe) for (const path of listReplicatedConfigPaths()) this.unsubscribers.push(config.subscribe(path, () => this.changed('config', path, path)));
      if (this.originalSecrets.onDidChange) this.unsubscribers.push(this.originalSecrets.onDidChange(key => {
        const path = replicatedSecretKeys().get(key); if (path !== undefined) this.changed('secret', path, key);
      }));
      this.refresh();
    } catch (error) { this.stop(); throw error; }
  }
  stop(): void {
    this.active = false; this.suspended = true; this.pending.clear(); this.seeded = null;
    const unsubscribe = this.unsubscribers; this.unsubscribers = [];
    for (const release of unsubscribe) { try { release(); } catch { this.host.logger.warn('cluster: a change subscription could not be released'); } }
  }
  suspend(): void { this.suspended = true; this.pending.clear(); this.seeded = null; }
  resume(): void { if (!this.active) return; this.suspended = false; this.refresh(); }
  async join(): Promise<void> { while (this.task) await this.task; }
  /** Housekeeping retries failed metadata under its original owner and detects
   * a real master transition. It never polls credential values each tick.
   */
  refresh(): void {
    if (!this.active || this.suspended) return;
    const owner = this.host.owner();
    if (!owner) { this.seeded = null; this.pending.clear(); return; }
    if (!this.seeded || this.seeded.revision !== owner.revision || this.seeded.generation !== owner.generation || this.seeded.master !== owner.master) {
      this.seeded = owner;
      if (owner.master) for (const path of replicatedSecretKeys().values()) this.enqueue('secret', path, true);
    }
    this.kick();
  }
  private changed(kind: ChangeKind, path: string, key: string): void {
    const source = this.origin.getStore();
    if (isSecretBearingConfigKey(path)) this.pending.delete(`${kind === 'config' ? 'secret' : 'config'}:${path}`);
    if (source?.active && source.kind === kind && source.key === key) { this.pending.delete(`${kind}:${path}`); return; }
    this.host.retireLocal?.(path);
    this.enqueue(kind, path, false); this.kick();
  }
  private enqueue(kind: ChangeKind, path: string, seed: boolean): void {
    if (!this.active || this.suspended || !this.host.owner()) return;
    let original: () => void; try { original = this.host.capture(); } catch { return; }
    const key = `${kind}:${path}`, previous = this.pending.get(key);
    // A startup seed must never replace an already queued explicit change.
    if (!seed || !previous) {
      const change: Change = { kind, path, seed, assertCurrent: () => { original(); if (this.pending.get(key) !== change) throw new GroupConfigChangeRetiredError(); } };
      this.pending.set(key, change);
    }
  }
  private kick(): void {
    if (this.task || !this.active || this.suspended || this.pending.size === 0) return;
    // Publish task ownership before any store or transport callback can run.
    const work = Promise.resolve().then(() => this.flush()); this.task = work;
    void work.then(() => { if (this.task === work) this.task = null; }, () => { if (this.task === work) this.task = null; });
  }
  private async flush(): Promise<void> {
    while (this.active && !this.suspended && this.pending.size > 0) {
      const [key, change] = this.pending.entries().next().value!;
      try { change.assertCurrent(); } catch { if (this.pending.get(key) === change) this.pending.delete(key); continue; }
      try { await this.host.apply(change); change.assertCurrent(); }
      catch (error) {
        if (error instanceof ConfigReplicationPrivacyError) { if (this.pending.get(key) === change) this.pending.delete(key); continue; }
        try { change.assertCurrent(); } catch { if (this.pending.get(key) === change) this.pending.delete(key); continue; }
        this.host.logger.warn('cluster: a local replicated change is awaiting retry', { path: change.path, kind: change.kind });
        return; // bounded retry belongs to housekeeping, never a hot loop
      }
      if (this.pending.get(key) === change) this.pending.delete(key);
    }
  }
}
