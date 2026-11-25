/** Actual configured-project selection precedes auto-initializing stores.
 * A preparation is private host state, never a deserializable authority token.
 */
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { DAEMON_STATE_SURFACE_ROOT } from '../../daemon/lifecycle-marker.js';
import { captureExistingDirectory } from '../../utils/atomic-json-store.js';
import { retainConfiguredWorkspace, type ConfigManager } from '../../config/manager.js';
import { KnowledgeStore } from '../store.js';
import { GOODVIBES_AGENT_KNOWLEDGE_DB_FILE, REGULAR_KNOWLEDGE_DB_FILE, type KnowledgeStoreConfig } from '../store-config.js';
import { normalizeSpaceComponent } from '../spaces.js';
import { inspectPersistedPlanningProjects, type PersistedPlanningProjects } from './persisted-projects.js';
import { ProjectIdentityRegistry, ProjectIdentityUnavailableError, projectIdentityConflict, type RegisteredProjectIdentity } from './project-registry.js';
export interface ConfiguredProjectInspection { readonly registration: 'registered' | 'unregistered'; readonly projectId: string | null }
interface PreparedProject {
  readonly path: string;
  readonly projectId: string;
  readonly binding: RegisteredProjectIdentity;
  readonly source: PersistedPlanningProjects;
  assertCurrent(): void;
}
const preparations = new WeakMap<ConfigManager, Map<string, PreparedProject>>();
const constructedStores = new WeakMap<KnowledgeStore, PreparedProject>();
/** Exact compatibility for a real old-format selector found in saved metadata.
 * Fresh contexts never derive public labels from their private workspace path.
 */
function previousDefault(workspace: string, candidates: readonly string[], associatedProjectId?: string): string | null {
  const resolved = resolve(workspace);
  const prefix = `${normalizeSpaceComponent(basename(resolved) || 'project')}-`;
  const oldCandidates = [...new Set(candidates.filter(id => id.startsWith(prefix) && /^[a-f0-9]{10}$/.test(id.slice(prefix.length))))];
  if (oldCandidates.length === 0) return null;
  // An actual native workspace binding or exact saved projectRoot association
  // already identifies this sole old selector. No checksum is needed to rediscover
  // the same association. Distinct unassociated labels still need the deployed
  // recipe below to distinguish a real conflict from a same-basename workspace.
  if (associatedProjectId !== undefined && oldCandidates.length === 1 && oldCandidates[0] === associatedProjectId) return associatedProjectId;
  const previous = `${prefix}${createHash('sha256').update(resolved).digest('hex').slice(0, 10)}`;
  return candidates.includes(previous) ? previous : null;
}
function selectedFile(file: string): void { if (file !== REGULAR_KNOWLEDGE_DB_FILE && file !== GOODVIBES_AGENT_KNOWLEDGE_DB_FILE) throw new ProjectIdentityUnavailableError(); }
/** Readonly inspection is the default. Actual interactive/native context
 * creation explicitly activates once before constructing WorkPlan or ledgers.
 */
export async function prepareConfiguredProjectContext(config: ConfigManager, workingDirectory: string, file = REGULAR_KNOWLEDGE_DB_FILE,
  options: {
    readonly activate?: boolean;
    /**
     * The project's one knowledge store is the daemon's, in the daemon's state folder beside this program's own
     * (`~/.goodvibes/tui/`): a program whose own folder is elsewhere (the Agent's `~/.goodvibes/agent/`) opens that
     * file, as the terminal app and the daemon do, and keeps no knowledge file of its own.
     */
    readonly inDaemonStateFolder?: boolean;
  } = {}): Promise<ConfiguredProjectInspection> {
  const activate = options.activate === true;
  selectedFile(file); const workspace = retainConfiguredWorkspace(config);
  const storeDirectory = options.inDaemonStateFolder === true ? join(dirname(workspace.configDirectory), DAEMON_STATE_SURFACE_ROOT) : workspace.configDirectory;
  workspace.assertCurrent(); if (workspace.directory !== resolve(workingDirectory)) throw new ProjectIdentityUnavailableError();
  const physicalWorkspace = captureExistingDirectory(workingDirectory);
  const current = () => { workspace.assertCurrent(); physicalWorkspace.assertCurrent(); };
  current(); const home = config.getHomeDirectory(); current();
  const registry = new ProjectIdentityRegistry(home ? join(home, '.goodvibes', 'project-identities') : join(workspace.configDirectory, 'project-identities'), current);
  let registered = registry.inspect(physicalWorkspace.canonical);
  const paths = new Set([join(storeDirectory, file)]);
  if (!registered) {
    // Actual first-party saved stores may predate the monorepo/shared binding.
    // Inspect only these known product/family paths; no arbitrary SQL or files.
    for (const family of [REGULAR_KNOWLEDGE_DB_FILE, GOODVIBES_AGENT_KNOWLEDGE_DB_FILE]) paths.add(join(workspace.configDirectory, family));
    if (home) for (const surface of ['tui', 'agent', 'daemon']) for (const family of [REGULAR_KNOWLEDGE_DB_FILE, GOODVIBES_AGENT_KNOWLEDGE_DB_FILE]) paths.add(join(home, '.goodvibes', surface, family));
  }
  const sources = new Map<string, PersistedPlanningProjects>();
  for (const path of paths) { const source = await inspectPersistedPlanningProjects(path, current); current(); sources.set(path, source); }
  const selectedPath = join(storeDirectory, file), source = sources.get(selectedPath)!;
  // Work-plan files of earlier builds are not read: the work plan is task rows in the knowledge store.
  const originalSourcesCurrent = () => {
    current(); registered?.assertCurrent();
    for (const selected of sources.values()) selected.assertInitialImage();
  };
  originalSourcesCurrent();
  const associatedProjectId = registered?.projectId;
  const old = previousDefault(workingDirectory, [...sources.values()].flatMap(selected => selected.projectIds), associatedProjectId);
  if (registered && old !== null && old !== registered.projectId) {
    // A true conflict: the saved work names this folder one project, its identity record another. Both are named, nothing changes.
    const store = [...sources.entries()].find(([, selected]) => selected.projectIds.includes(old))?.[0] ?? 'a saved knowledge store';
    throw projectIdentityConflict(physicalWorkspace.canonical, { id: old, where: store }, { id: registered.projectId, where: registered.file },
      `To keep the work saved in ${store}, move ${registered.file} out of ${dirname(registered.file)} and start again: the folder is then given the identity its saved work has.`);
  }
  const previous = old;
  if (!registered) {
    if (!activate) { originalSourcesCurrent(); return Object.freeze({ registration: previous === null ? 'unregistered' : 'registered', projectId: previous }); }
    registered = await registry.activate(physicalWorkspace.canonical, previous, config.getNativeDataWriter(), originalSourcesCurrent); current();
  }
  if (activate) {
    const binding = registered, prepared = Object.freeze({ path: selectedPath, projectId: binding.projectId, binding, source,
      assertCurrent() { current(); binding.assertCurrent(); } });
    let entries = preparations.get(config); if (!entries) { entries = new Map(); preparations.set(config, entries); }
    const previous = entries.get(file); if (previous && previous.projectId !== prepared.projectId) throw new ProjectIdentityUnavailableError();
    entries.set(file, prepared);
  }
  originalSourcesCurrent();
  return Object.freeze({ registration: 'registered', projectId: registered.projectId });
}
/**
 * The identity of a project folder that is not this configuration's own: the daemon keeps Work per project, and a
 * program's project is named by its folder. The folder's registered identity (the one its own program registered, or
 * a new one registered now, once) in the same home register, so the program and the daemon name it alike.
 */
export async function projectIdentityOfFolder(config: ConfigManager, folder: string): Promise<string> {
  const physical = captureExistingDirectory(folder);
  const current = () => { physical.assertCurrent(); };
  const home = config.getHomeDirectory();
  if (!home) throw new ProjectIdentityUnavailableError('This daemon has no home folder, so a project\'s identity cannot be kept.');
  const registry = new ProjectIdentityRegistry(join(home, '.goodvibes', 'project-identities'), current);
  const registered = registry.inspect(physical.canonical) ?? await registry.activate(physical.canonical, null, config.getNativeDataWriter(), current);
  return registered.projectId;
}

function requirePreparedProject(config: ConfigManager, file: string): PreparedProject {
  selectedFile(file); const prepared = preparations.get(config)?.get(file); if (!prepared) throw new ProjectIdentityUnavailableError(); prepared.assertCurrent(); prepared.source.assertInitialImage();
  return prepared;
}

/** Fail before a runtime graph starts resources. Preparation remains explicit
 * and asynchronous; this assertion cannot activate or reconstruct a project. */
export function assertConfiguredProjectContextReady(config: ConfigManager, workingDirectory: string, file = REGULAR_KNOWLEDGE_DB_FILE): void {
  const prepared = requirePreparedProject(config, file);
  const workspace = retainConfiguredWorkspace(config);
  workspace.assertCurrent();
  if (workspace.directory !== resolve(workingDirectory)) throw new ProjectIdentityUnavailableError();
  prepared.assertCurrent();
}

/** Actual constructor bridge, not an exemption for an arbitrary supplied store.
 * The original image restriction is installed before KnowledgeStore starts init.
 */
export function createConfiguredPlanningStore(config: ConfigManager, file = REGULAR_KNOWLEDGE_DB_FILE,
  options: Pick<KnowledgeStoreConfig, 'nativeDataWriter' | 'family'> = {}): KnowledgeStore {
  const prepared = requirePreparedProject(config, file);
  // The prepared path, which is the daemon's state folder for a program that opens the daemon's one store.
  const store = new KnowledgeStore({ family: file === GOODVIBES_AGENT_KNOWLEDGE_DB_FILE ? 'agent' : 'wiki', ...options, configManager: config, dbFileName: file, dbPath: prepared.path, beforeInitialRead: () => { prepared.assertCurrent(); prepared.source.assertInitialImage(); } });
  prepared.assertCurrent(); constructedStores.set(store, prepared); return store;
}
/**
 * The one identity check, at composition: the store was built by
 * createConfiguredPlanningStore for this configuration's prepared project, at
 * that project's path, for this workspace. The project id comes from there.
 */
export function configuredPlanningStoreIdentity(store: KnowledgeStore, config: ConfigManager, workingDirectory: string): { readonly projectId: string } {
  const prepared = constructedStores.get(store);
  if (!prepared || ![...(preparations.get(config)?.values() ?? [])].includes(prepared)) throw new ProjectIdentityUnavailableError();
  const workspace = retainConfiguredWorkspace(config);
  if (workspace.directory !== resolve(workingDirectory) || store.storagePath !== prepared.path) throw new ProjectIdentityUnavailableError();
  prepared.assertCurrent();
  return Object.freeze({ projectId: prepared.projectId });
}
