// ---------------------------------------------------------------------------
// code-index-services.ts, repo source-tree code index wiring.
//
// Constructs a product's repo source-tree code index: CodeIndexStore
// (@goodvibes-jev/engine/platform/platform/state). Extracted into its own module rather than built inline in
// services.ts: services.ts sits at the architecture check's 800-line cap
// (scripts/check-architecture.ts), so any new service gets its own
// construction module and a single wiring call there (mirrors
// createWorkstreamServices's one-function-bundle shape).
//
// Schema-initialized eagerly (mirrors memoryStore: construction + init()
// happen unconditionally so the store is queryable, /codebase status, the
// fleet node, even before any build has ever run). The actual walk/chunk/
// embed build is NEVER auto-triggered by default: the hundreds of existing
// test fixtures (and every headless invocation) construct RuntimeServices
// without asking for a full source-tree walk, and init() alone never runs
// one (mirrors the platform's own RuntimeServices wiring in
// platform/runtime/services.ts, which gates its equivalent scheduleBuild()
// call behind an explicit autoStartCodeIndex option).
//
// REALITY-WINS DIVERGENCE from the platform's own shape: the platform's
// RuntimeServicesOptions exposes autoStartCodeIndex as a constructor-time
// boolean because that call site is a library entrypoint threaded by each
// embedder. createRuntimeServices has no such per-call knob, auto-start is
// decided from a host-local config key instead
// (CODE_INDEX_ENABLED_CONFIG_KEY, default OFF), so every construction path
// (interactive main.ts, the daemon, and every test fixture) shares one
// honest, user-visible on/off switch rather than needing to thread a new
// boolean through every call site. With it off (the default), `/codebase
// build` is the explicit, visible trigger, exactly the shape this design
// asks for.
//
// Shares memoryEmbeddingRegistry with MemoryStore (constructed in
// services.ts) so code + memory retrieval use one embedding provider and one
// dimensionality, per the platform design doc (code-index-store.ts's constructor
// takes the SAME MemoryEmbeddingProviderRegistry instance memory uses).
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import { CodeIndexStore, CodeIndexReindexScheduler } from '../state/index.js';
import type { MemoryEmbeddingProviderRegistry } from '../state/index.js';
import type { ConfigKey, ConfigManager } from '../config/index.js';
import { readBooleanConfig } from './alert-gating.js';

/**
 * Host-local synthetic config key (no GoodVibesConfig field, so not a ConfigKey) that
 * gates the code index's auto-build on construction. Default OFF, see this
 * module's header doc. Surfaced in /config via a synthetic entry
 * (settings-modal-data.ts) exactly like behavior.notifyAfterSeconds.
 */
export const CODE_INDEX_ENABLED_CONFIG_KEY = 'storage.codeIndexEnabled';

/**
 * The bounds every product's code index builds under, passed explicitly to
 * CodeIndexStore so /codebase status and the settings description state them
 * from one place. Every indexed file is chunked and sent to the embedding
 * provider, so a file over the per-file size (generated bundles, lockfiles,
 * data dumps) is skipped and counted as too large, and a build stops adding
 * files at the file and byte totals; the build's skip counts say how many.
 */
export const CODE_INDEX_MAX_FILES = 50_000;
export const CODE_INDEX_MAX_FILE_BYTES = 1024 * 1024;
export const CODE_INDEX_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export interface CodeIndexServicesDeps {
  readonly workingDirectory: string;
  /** Current working directory when the workspace can be swapped at runtime; relative reindex paths resolve against it. */
  readonly getWorkingDirectory?: (() => string) | undefined;
  /** The owning product's storage scope, the `<surfaceRoot>` the index file sits under. */
  readonly surfaceRoot: string;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry;
  /**
   * Memory-governor backpressure (optional): when the governor pauses the
   * 'code-index-reindex' job, the tool-site reindex scheduler stops scheduling
   * new work; the critical tier refuses new reindex work outright via
   * admitExpensiveWork. Absent (most test fixtures) → never paused, always
   * admitted, exactly as before.
   */
  readonly isReindexPaused?: (() => boolean) | undefined;
  readonly admitExpensiveWork?: ((label: string) => { allowed: boolean; reason?: string | undefined }) | undefined;
}

/**
 * Whether code auto-injection / tool-site reindex may run: the SAME
 * storage.codeIndexEnabled switch that gates auto-build. Read live so a runtime
 * /config toggle takes effect without restart. (The separate, default-off
 * `agent-passive-code-injection` feature flag gates injection additionally; this
 * is only the storage-side setting the platform asks embedders to respect.)
 */
export function isCodeInjectionSettingEnabled(configManager: Pick<ConfigManager, 'get'>): boolean {
  return isCodeIndexAutoStartEnabled(configManager);
}

export interface CodeIndexServices {
  readonly codeIndexStore: CodeIndexStore;
  /**
   * Tool-site incremental reindex scheduler, bound to codeIndexStore and
   * gated live on storage.codeIndexEnabled. Threaded into both platform orchestrators (main +
   * agent) so a successful write/edit debounces an incremental reindex, and into the command
   * context so /codebase status can report the last reindex activity honestly.
   */
  readonly codeIndexReindexScheduler: CodeIndexReindexScheduler;
}

/** Absolute path to a product's code-index sqlite file, sibling to memory.sqlite under `.goodvibes/<surfaceRoot>/`. */
export function codeIndexDbPath(workingDirectory: string, surfaceRoot: string): string {
  return join(workingDirectory, '.goodvibes', surfaceRoot, 'code-index.sqlite');
}

/**
 * Whether the code index's initial build should auto-start on construction.
 * Exported so /codebase status and the settings modal read the exact same
 * config key + default this module decides auto-start from.
 */
export function isCodeIndexAutoStartEnabled(configManager: Pick<ConfigManager, 'get'>): boolean {
  return readBooleanConfig(
    (key) => configManager.get(key as ConfigKey),
    CODE_INDEX_ENABLED_CONFIG_KEY,
    false,
  );
}

/**
 * Constructs the CodeIndexStore. Schema-init runs unconditionally
 * (init() never rejects, it degrades to an honest `available: false` +
 * recorded error on failure, mirrored by CodeIndexStats/describeDegradation);
 * once it settles, the initial full build only fires when
 * isCodeIndexAutoStartEnabled() is true, via the SAME fire-and-forget
 * scheduleBuild() an explicit `/codebase build` invocation uses.
 */
export function createCodeIndexServices(deps: CodeIndexServicesDeps): CodeIndexServices {
  const codeIndexStore = new CodeIndexStore(
    deps.workingDirectory,
    codeIndexDbPath(deps.workingDirectory, deps.surfaceRoot),
    deps.memoryEmbeddingRegistry,
    { maxFiles: CODE_INDEX_MAX_FILES, maxFileBytes: CODE_INDEX_MAX_FILE_BYTES, maxTotalBytes: CODE_INDEX_MAX_TOTAL_BYTES },
  );
  // init never rejects; it is async because a failed extension load is read
  // by Jev (sqlite-vec-loader.ts). The build starts once the store is open.
  void codeIndexStore.init().then(() => {
    if (isCodeIndexAutoStartEnabled(deps.configManager)) codeIndexStore.scheduleBuild();
  });
  const codeIndexReindexScheduler = new CodeIndexReindexScheduler({
    target: codeIndexStore,
    workingDirectory: deps.getWorkingDirectory ?? deps.workingDirectory,
    // Honor governor backpressure: a paused code-index reindex job stops
    // scheduling new work until the governor resumes it, and the critical
    // memory tier refuses new reindex work outright (mirrors the platform).
    isEnabled: () => isCodeInjectionSettingEnabled(deps.configManager)
      && !(deps.isReindexPaused?.() ?? false)
      && (deps.admitExpensiveWork?.('code-index reindex').allowed ?? true),
  });
  return { codeIndexStore, codeIndexReindexScheduler };
}
