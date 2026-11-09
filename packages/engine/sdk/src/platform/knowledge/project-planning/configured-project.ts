/** Actual configured-project selection precedes auto-initializing stores.
 * A preparation is private host state, never a deserializable authority token.
 */
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { captureExistingDirectory } from '../../utils/atomic-json-store.js';
import { retainConfiguredWorkspace, type ConfigManager } from '../../config/manager.js';
import { SQLiteStore } from '../../state/sqlite-store.js';
import { KnowledgeStore } from '../store.js';
import { GOODVIBES_AGENT_KNOWLEDGE_DB_FILE, REGULAR_KNOWLEDGE_DB_FILE, type KnowledgeStoreConfig } from '../store-config.js';
import { normalizeSpaceComponent } from '../spaces.js';
import { inspectPersistedPlanningProjects, type PersistedPlanningProjects } from './persisted-projects.js';
import { inspectWorkPlanProjects } from './persisted-work-plan-projects.js';
import { ProjectIdentityRegistry, ProjectIdentityUnavailableError, type RegisteredProjectIdentity } from './project-registry.js';
export interface ConfiguredProjectInspection { readonly registration: 'registered' | 'unregistered'; readonly projectId: string | null }
interface PreparedProject {
  readonly path: string;
  readonly projectId: string;
  readonly binding: RegisteredProjectIdentity;
  readonly source: PersistedPlanningProjects;
  assertCurrent(): void;
}
const NativeMap = Map, apply = Reflect.apply, weakGetMethod = WeakMap.prototype.get, weakSetMethod = WeakMap.prototype.set;
const mapGetMethod = Map.prototype.get, mapSetMethod = Map.prototype.set, mapValuesMethod = Map.prototype.values;
function weakGet<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined { return apply(weakGetMethod, map, [key]) as V | undefined; }
function weakSet<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void { apply(weakSetMethod, map, [key, value]); }
function mapGet<K, V>(map: Map<K, V> | undefined, key: K): V | undefined { return map ? apply(mapGetMethod, map, [key]) as V | undefined : undefined; }
function mapValues<K, V>(map: Map<K, V> | undefined): IterableIterator<V> { return map ? apply(mapValuesMethod, map, []) as IterableIterator<V> : [][Symbol.iterator](); }
const preparations = new WeakMap<ConfigManager, Map<string, PreparedProject>>();
const constructedStores = new WeakMap<KnowledgeStore, PreparedProject>();
const nativeStoreConstructor = KnowledgeStore;
const nativeInit = KnowledgeStore.prototype.init;
/** Exact compatibility for a real old-format selector found in saved metadata.
 * Fresh contexts never derive public labels from their private workspace path.
 */
function previousDefault(workspace: string, candidates: readonly string[]): string | null {
  const resolved = resolve(workspace);
  const prefix = `${normalizeSpaceComponent(basename(resolved) || 'project')}-`;
  if (!candidates.some(id => id.startsWith(prefix) && /^[a-f0-9]{10}$/.test(id.slice(prefix.length)))) return null;
  const previous = `${prefix}${createHash('sha256').update(resolved).digest('hex').slice(0, 10)}`;
  return candidates.includes(previous) ? previous : null;
}
function selectedFile(file: string): void { if (file !== REGULAR_KNOWLEDGE_DB_FILE && file !== GOODVIBES_AGENT_KNOWLEDGE_DB_FILE) throw new ProjectIdentityUnavailableError(); }
/** Readonly inspection is the default. Actual interactive/native context
 * creation explicitly activates once before constructing WorkPlan or ledgers.
 */
export async function prepareConfiguredProjectContext(config: ConfigManager, workingDirectory: string, file = REGULAR_KNOWLEDGE_DB_FILE,
  options: { readonly activate?: boolean } = {}): Promise<ConfiguredProjectInspection> {
  const activate = options.activate === true;
  selectedFile(file); const workspace = retainConfiguredWorkspace(config);
  workspace.assertCurrent(); if (workspace.directory !== resolve(workingDirectory)) throw new ProjectIdentityUnavailableError();
  const physicalWorkspace = captureExistingDirectory(workingDirectory);
  const current = () => { workspace.assertCurrent(); physicalWorkspace.assertCurrent(); };
  current(); const home = config.getHomeDirectory(); current();
  const registry = new ProjectIdentityRegistry(home ? join(home, '.goodvibes', 'project-identities') : join(workspace.configDirectory, 'project-identities'), current);
  let registered = registry.inspect(physicalWorkspace.canonical);
  const paths = new Set([join(workspace.configDirectory, file)]);
  if (!registered) {
    // Actual first-party saved stores may predate the monorepo/shared binding.
    // Inspect only these known product/family paths; no arbitrary SQL or files.
    for (const family of [REGULAR_KNOWLEDGE_DB_FILE, GOODVIBES_AGENT_KNOWLEDGE_DB_FILE]) paths.add(join(workspace.configDirectory, family));
    if (home) for (const surface of ['tui', 'agent', 'daemon']) for (const family of [REGULAR_KNOWLEDGE_DB_FILE, GOODVIBES_AGENT_KNOWLEDGE_DB_FILE]) paths.add(join(home, '.goodvibes', surface, family));
  }
  const sources = new Map<string, PersistedPlanningProjects>();
  for (const path of paths) { const source = await inspectPersistedPlanningProjects(path, current); current(); sources.set(path, source); }
  const selectedPath = join(workspace.configDirectory, file), source = sources.get(selectedPath)!;
  const plans = [join(workspace.configDirectory, 'work-plans')];
  if (home) for (const surface of ['tui', 'agent', 'daemon']) plans.push(join(home, '.goodvibes', surface, 'work-plans'));
  const ownership = [...new Set(plans)].map(path => inspectWorkPlanProjects(path, workspace.directory!));
  const known = new Set(ownership.flatMap(plan => plan.projectIds));
  const old = previousDefault(workingDirectory, [...sources.values()].flatMap(selected => selected.projectIds).concat([...known]));
  if ((registered && old !== null && old !== registered.projectId) || (!registered && old === null && known.size > 1)) throw new ProjectIdentityUnavailableError();
  const previous = old ?? [...known][0] ?? null;
  if (!registered) {
    if (!activate) return Object.freeze({ registration: previous === null ? 'unregistered' : 'registered', projectId: previous });
    const migrationCurrent = () => { current(); for (const selected of sources.values()) selected.assertInitialImage(); for (const plan of ownership) plan.assertCurrent(); };
    registered = await registry.activate(physicalWorkspace.canonical, previous, config.getNativeDataWriter(), migrationCurrent); current();
  }
  if (activate) {
    const binding = registered, prepared = Object.freeze({ path: selectedPath, projectId: binding.projectId, binding, source,
      assertCurrent() { current(); binding.assertCurrent(); } });
    let entries = weakGet(preparations, config); if (!entries) { entries = new NativeMap(); weakSet(preparations, config, entries); }
    const previous = mapGet(entries, file); if (previous && previous.projectId !== prepared.projectId) throw new ProjectIdentityUnavailableError();
    apply(mapSetMethod, entries, [file, prepared]);
  }
  return Object.freeze({ registration: 'registered', projectId: registered.projectId });
}
/** Actual constructor bridge, not an exemption for an arbitrary supplied store.
 * The original image restriction is installed before KnowledgeStore starts init.
 */
export function createConfiguredPlanningStore(config: ConfigManager, file = REGULAR_KNOWLEDGE_DB_FILE,
  options: Pick<KnowledgeStoreConfig, 'nativeDataWriter' | 'family'> = {}): KnowledgeStore {
  selectedFile(file); const prepared = mapGet(weakGet(preparations, config), file); if (!prepared) throw new ProjectIdentityUnavailableError(); prepared.assertCurrent(); prepared.source.assertInitialImage();
  if (Object.getOwnPropertyDescriptor(KnowledgeStore.prototype, 'init')?.value !== nativeInit) throw new ProjectIdentityUnavailableError();
  const store = new nativeStoreConstructor({ ...options, configManager: config, dbFileName: file, beforeInitialRead: () => { prepared.assertCurrent(); prepared.source.assertInitialImage(); } });
  prepared.assertCurrent(); weakSet(constructedStores, store, prepared); return store;
}
/** Used only by the native configured factory. An ID, parsed JSON, borrowed
 * constructor, copied getter or caller-authored options cannot mint this proof.
 */
export function configuredPlanningStoreIdentity(store: KnowledgeStore, config: ConfigManager, workingDirectory: string): { readonly projectId: string; assertCurrent(): void } {
  const prepared = weakGet(constructedStores, store); if (!prepared || ![...mapValues(weakGet(preparations, config))].includes(prepared)) throw new ProjectIdentityUnavailableError();
  const workspace = retainConfiguredWorkspace(config); if (workspace.directory !== resolve(workingDirectory)) throw new ProjectIdentityUnavailableError();
  const slot = Object.getOwnPropertyDescriptor(store, 'sqlite'), path = Object.getOwnPropertyDescriptor(store, 'dbPath');
  if (!slot || !('value' in slot) || !(slot.value instanceof SQLiteStore) || !path || !('value' in path) || path.value !== prepared.path) throw new ProjectIdentityUnavailableError();
  const originalSqlite: unknown = slot.value, originalPath: unknown = path.value;
  const assertCurrent = () => { prepared.assertCurrent(); workspace.assertCurrent();
    if (Object.getOwnPropertyDescriptor(store, 'sqlite')?.value !== originalSqlite || Object.getOwnPropertyDescriptor(store, 'dbPath')?.value !== originalPath) throw new ProjectIdentityUnavailableError(); };
  assertCurrent(); return Object.freeze({ projectId: prepared.projectId, assertCurrent });
}
