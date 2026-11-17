/** Per-run passive code source. Receipt provenance never substitutes for live read policy. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  assertContractInputAuthority, authorizeContractInputPath, contractInputAuthoritySourceRoot, contractInputAuthorityFiles,
  contractInputAuthorityTree, registerContractInputCleanup, registerContractInputReadAssertion, withContractInputReadBatch,
  contractInputAuthorityMutable, type ContractInputAuthority,
} from '../contract/input-authority.js';
import { CONTRACT_INPUT_EXCLUSIONS } from '../contract/input-snapshot.js';
import { workingTreeIdentity } from '../contract/tree-identity.js';
import { executePolicyCheck } from '../gate/execute-policy-check.js';
import { rankCodeInjectionSnapshots } from '../state/code-injection-ranking.js';
import type { SkippedCodeHit } from '../state/code-injection-live.js';
import type { AuthorizedIndexBoundary } from '../state/code-index-authorized.js';
import { CodeIndexStore } from '../state/code-index-store.js';
import { MEMORY_VECTOR_DIMS } from '../state/memory-vector-store.js';
import { HASHED_MEMORY_EMBEDDING_PROVIDER, type MemoryEmbeddingProvider, type MemoryEmbeddingProviderRegistry } from '../state/memory-embeddings.js';
import type { ReadAccessFilter } from '../tools/shared/read-access.js';
import type { TurnCodeIndexSource } from './turn-knowledge-injection.js';

const excluded = new Set<string>([...CONTRACT_INPUT_EXCLUSIONS, 'node_modules']);
const fingerprint = (s: BigIntStats): string => `${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
interface Snapshot { readonly path: string; readonly mtimeMs: number; readonly fingerprint: string; readonly content?: string }
interface Generation { readonly files: readonly Snapshot[]; readonly directories: ReadonlyMap<string, string>; readonly id: string }
type CodeStats = ReturnType<TurnCodeIndexSource['stats']>;
type IndexGuard = (boundary: AuthorizedIndexBoundary, path?: string) => Promise<void>;

/**
 * Preparation budget. One input tree is indexed once and the index serves every
 * turn and every context holding that tree, so these bound one preparation,
 * sized for an ordinary repository. A file over the per-file size is left out;
 * exceeding a count or byte total makes the code source unavailable with the cap
 * named, and the run continues without code context.
 */
const MAX_DISCOVERY_ENTRIES = 20_000;
const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 128 * 1_024;
const MAX_SOURCE_BYTES = 32 * 1_024 * 1_024;
const MAX_CHUNKS = 4_096;
const OPERATION_TIMEOUT_MS = 120_000;
/** The deadline of one search, ranking or check against a prepared index. */
const CALL_TIMEOUT_MS = 15_000;
class CodeContextTooLarge extends Error {}
const CHUNK_BUDGET_MESSAGE = 'Authorized code index chunk budget exceeded';

// Retain one original text per mutable file for this run only. Immutable receipt
// files are already compared to their captured input by read authority. These
// strings are private evidence, never content-derived IDs or global cache keys.
let generationSequence = 0;

/**
 * One prepared index per input tree and embedding provider, shared by every
 * context whose input holds that tree. The units of a contract start from the
 * same input tree, so the first one reads and embeds it and the others reuse
 * its index instead of reading up to MAX_FILES files and embedding up to
 * MAX_CHUNKS chunks again before their first request. The key is the receipt's
 * input tree for a captured (immutable) view and the git tree id of the current
 * content for a member's own worktree.
 *
 * The index holds chunk positions and vectors, never text. Each context still
 * authorizes its own files, takes its own generation (file identities under its
 * own root), and reads from its own root every hit it quotes; its checks run on
 * each call into the shared index through `activeGuard`. The index lives while
 * a context holds it: a context releases it when it moves to another tree, is
 * disposed, or its input authority is revoked (registerContractInputCleanup).
 */
interface SharedCodeIndex {
  readonly key: string;
  readonly provider: MemoryEmbeddingProvider;
  readonly store: CodeIndexStore;
  /** The revision every chunk of this index carries; a context holding it takes it as its generation id. */
  readonly revision: string;
  readonly stats: CodeStats;
  /** Aborted when the last holder releases the index; bounds the provider requests the index makes. */
  readonly lifetime: AbortController;
  holders: number;
}
interface SharedSlot {
  readonly ready: Promise<SharedCodeIndex>;
  readonly resolve: (entry: SharedCodeIndex) => void;
  readonly reject: (error: unknown) => void;
  entry?: SharedCodeIndex;
}
const sharedIndexes = new Map<string, SharedSlot>();
/** The checks of the context calling into a shared index right now. */
const activeGuard = new AsyncLocalStorage<IndexGuard>();
const sharedGuard: IndexGuard = async (boundary, path) => {
  const guard = activeGuard.getStore();
  if (!guard) throw new Error('captured code index used outside a guarded call');
  await guard(boundary, path);
};

function createSlot(): SharedSlot {
  let resolve!: (entry: SharedCodeIndex) => void;
  let reject!: (error: unknown) => void;
  const ready = new Promise<SharedCodeIndex>((ok, fail) => { resolve = ok; reject = fail; });
  // A build nobody waits on must not surface as an unhandled rejection.
  ready.catch(() => undefined);
  return { ready, resolve, reject };
}

function releaseShared(entry: SharedCodeIndex): void {
  entry.holders -= 1;
  if (entry.holders > 0) return;
  const slot = sharedIndexes.get(entry.key);
  if (slot?.entry === entry) sharedIndexes.delete(entry.key);
  entry.lifetime.abort();
  entry.store.close();
}

/** The index another context built (or is building) for this key, now held by the caller; undefined when there is none to reuse. */
async function acquireShared(key: string, provider: MemoryEmbeddingProvider, signal: AbortSignal): Promise<SharedCodeIndex | undefined> {
  for (;;) {
    const slot = sharedIndexes.get(key);
    if (!slot) return undefined;
    let entry: SharedCodeIndex;
    try {
      entry = await executePolicyCheck(() => slot.ready, signal);
    } catch (error) {
      signal.throwIfAborted();
      // The tree is over a budget: every context holding it would learn the same.
      if (error instanceof CodeContextTooLarge || (error instanceof Error && error.message === CHUNK_BUDGET_MESSAGE)) throw error;
      if (sharedIndexes.get(key) === slot) sharedIndexes.delete(key);
      continue;
    }
    if (entry.lifetime.signal.aborted) {
      if (sharedIndexes.get(key) === slot) sharedIndexes.delete(key);
      continue;
    }
    if (entry.provider !== provider) return undefined;
    entry.holders += 1;
    return entry;
  }
}

// The authority keeps every assertion registered with it for its whole life and has no way to remove one,
// and a run adds a context per spawn. One assertion per authority runs whichever contexts are still live.
const liveAssertions = new WeakMap<ContractInputAuthority, Set<() => Promise<void>>>();
function registerLiveAssertion(authority: ContractInputAuthority, assertion: () => Promise<void>): () => void {
  let live = liveAssertions.get(authority);
  if (!live) {
    const created = new Set<() => Promise<void>>();
    live = created;
    liveAssertions.set(authority, created);
    registerContractInputReadAssertion(authority, async () => { for (const each of [...created]) await each(); });
  }
  live.add(assertion);
  return () => { live.delete(assertion); };
}
export function createCapturedCodeContext(input: {
  readonly authority: ContractInputAuthority;
  readonly root: string;
  readonly readAccessFilter?: ReadAccessFilter | undefined;
  readonly registry?: MemoryEmbeddingProviderRegistry | undefined;
  readonly signal?: AbortSignal | undefined;
}): TurnCodeIndexSource {
  const { authority, root, readAccessFilter, registry } = input;
  // A captured input cannot change under the run (read authority compares every
  // read with the capture), so its generation is prepared once and kept for
  // every turn. A mutable input is re-proved before its text reaches a provider.
  const immutable = !contractInputAuthorityMutable(authority);
  /** The index this context holds (built here, or shared from another context with the same tree). */
  let shared: SharedCodeIndex | undefined;
  const releaseIndex = (): void => { const held = shared; shared = undefined; if (held) releaseShared(held); };
  let cachedStats: CodeStats | undefined;
  let current: Generation | undefined;
  let assertReadingCurrent: (() => Promise<void>) | undefined;
  let pinnedProvider: MemoryEmbeddingProvider | null = null;
  let operation: AbortController | undefined;
  let disposed = false;
  let unavailable: string | undefined;
  const checkSignal = (): void => { if (disposed) throw new Error('captured code context is closed'); input.signal?.throwIfAborted(); operation?.signal.throwIfAborted(); };
  const checkProvider = (): void => {
    checkSignal();
    if (!pinnedProvider || registry?.getDefaultProviderOrNull() !== pinnedProvider || pinnedProvider.capturedInputAdmission !== 'per-attempt') throw new Error('captured code embedding provider changed');
  };
  const authorize = async (path: string, signal: AbortSignal): Promise<void> => {
    checkSignal();
    if (path === root) {
      await executePolicyCheck(() => assertContractInputAuthority(authority, root, signal), signal);
      if (!readAccessFilter || !(await executePolicyCheck(() => readAccessFilter(contractInputAuthoritySourceRoot(authority)), signal)) ||
          !(await executePolicyCheck(() => readAccessFilter(root), signal))) throw new Error('captured code root is access-restricted');
      await executePolicyCheck(() => assertContractInputAuthority(authority, root, signal), signal);
    } else await executePolicyCheck(() => authorizeContractInputPath(authority, path, readAccessFilter, signal), signal);
    checkProvider();
  };
  /** The identity of a regular, unaliased, single-link file, without reading it. */
  const fileMetadata = (path: string): BigIntStats => {
    checkProvider();
    if (realpathSync(root) !== root || realpathSync(path) !== path) throw new Error('captured code path is redirected');
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('captured code file is unsupported');
    return stat;
  };
  // No async gap between the final alias check and the bounded, no-follow byte open.
  const bytes = (path: string, expected?: string): { content: string; fingerprint: string; mtimeMs: number } => {
    const before = fileMetadata(path);
    const fp = fingerprint(before);
    if (expected !== undefined && fp !== expected) throw new Error('captured code generation changed');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (fingerprint(fstatSync(fd, { bigint: true })) !== fp) throw new Error('captured code file changed before open');
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < buffer.length) { checkSignal(); const count = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count; }
      if (offset !== Number(before.size) || fingerprint(fstatSync(fd, { bigint: true })) !== fp || fingerprint(lstatSync(path, { bigint: true })) !== fp)
        throw new Error('captured code generation changed during read');
      return { content: buffer.subarray(0, offset).toString('utf8'), fingerprint: fp, mtimeMs: Number(before.mtimeMs) };
    } finally { closeSync(fd); }
  };
  /**
   * The generation is still what was indexed. `only` names the files a call is
   * about to send or quote; absent, the whole generation is meant.
   */
  const assertGeneration = async (generation: Generation, signal: AbortSignal, only?: string | readonly string[]): Promise<void> => withContractInputReadBatch(authority, async () => {
    checkProvider();
    await authorize(root, signal);
    const selected = only === undefined ? undefined : new Set<string>(typeof only === 'string' ? [only] : only);
    if (immutable) {
      // Read authority compares every read of a captured input with its capture,
      // so the generation as a whole needs only the root check above. The files a
      // call is about to send or quote are compared with what was indexed.
      if (selected) {
        for (const file of generation.files) {
          if (selected.has(file.path) && fingerprint(lstatSync(join(root, file.path), { bigint: true })) !== file.fingerprint) throw new Error('captured code generation changed');
        }
      }
      checkProvider();
      return;
    }
    for (const [path, fp] of generation.directories) {
      if (fingerprint(lstatSync(path, { bigint: true })) !== fp) throw new Error('captured code directory generation changed');
    }
    for (const file of generation.files) {
      if (selected && !selected.has(file.path)) continue;
      const path = join(root, file.path);
      await authorize(path, signal);
      if (file.content !== undefined && bytes(path, file.fingerprint).content !== file.content) throw new Error('captured code content generation changed');
    }
    // Recheck every metadata identity synchronously after the last yielding policy
    // check. Other member writes cannot silently alter an already-checked file.
    for (const [path, fp] of generation.directories) if (fingerprint(lstatSync(path, { bigint: true })) !== fp) throw new Error('captured code directory generation changed');
    for (const file of generation.files) if ((!selected || selected.has(file.path)) && fingerprint(lstatSync(join(root, file.path), { bigint: true })) !== file.fingerprint) throw new Error('captured code generation changed');
    checkProvider();
  });
  /** This context's checks, for a call into the index it holds. */
  const guardFor = (generation: Generation, signal: AbortSignal): IndexGuard => async (_boundary, path) => {
    signal.throwIfAborted();
    await assertGeneration(generation, signal, path);
  };
  /**
   * The files under this root the index may name, each authorized now. `read`:
   * read each file too (the index is built here); otherwise only its identity is
   * taken (the index was built from the same tree elsewhere).
   */
  const discover = async (signal: AbortSignal, read: boolean): Promise<{ readonly files: Snapshot[]; readonly directories: Map<string, string> }> => {
    const files: Snapshot[] = []; const directories = new Map<string, string>();
    let entries = 0; let sourceBytes = 0;
    const countEntry = (): void => { if (++entries > MAX_DISCOVERY_ENTRIES) throw new CodeContextTooLarge(`more than ${MAX_DISCOVERY_ENTRIES} entries`); };
    // True when the file may be read; a file over the per-file size is left out of the index, not a failure.
    const admitFile = (path: string): boolean => {
      const size = lstatSync(path, { bigint: true }).size;
      if (size > BigInt(MAX_FILE_BYTES)) return false;
      if (files.length >= MAX_FILES) throw new CodeContextTooLarge(`more than ${MAX_FILES} files`);
      if (sourceBytes + Number(size) > MAX_SOURCE_BYTES) throw new CodeContextTooLarge(`more than ${MAX_SOURCE_BYTES} bytes of source`);
      sourceBytes += Number(size);
      return true;
    };
    const take = (path: string, rel: string): void => {
      if (!read) {
        const stat = fileMetadata(path);
        files.push({ path: rel, fingerprint: fingerprint(stat), mtimeMs: Number(stat.mtimeMs) });
        return;
      }
      const got = bytes(path);
      // Binary filtering consumes only the already-authorized bytes.
      if (got.content.includes('\0')) return;
      files.push({ path: rel, fingerprint: got.fingerprint, mtimeMs: got.mtimeMs, ...(immutable ? {} : { content: got.content }) });
    };
    await withContractInputReadBatch(authority, async () => {
      const membership = contractInputAuthorityFiles(authority);
      if (membership) {
        await authorize(root, signal);
        directories.set(root, fingerprint(lstatSync(root, { bigint: true })));
        for (const rel of membership) {
          signal.throwIfAborted();
          if (rel.split('/').some(part => excluded.has(part))) continue;
          countEntry();
          const path = join(root, rel);
          try { await authorize(path, signal); } catch (error) {
            if (error instanceof Error && error.message === 'captured input path is access-restricted') continue;
            throw error;
          }
          if (!admitFile(path)) continue;
          take(path, rel);
          for (let directory = dirname(path); directory !== root; directory = dirname(directory)) {
            await authorize(directory, signal);
            directories.set(directory, fingerprint(lstatSync(directory, { bigint: true })));
          }
        }
      }
      const queue = membership ? [] : [root];
      while (queue.length) {
        const directory = queue.shift()!;
        await authorize(directory, signal);
        const stat = lstatSync(directory, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('captured code directory is redirected');
        directories.set(directory, fingerprint(stat));
        const dir = opendirSync(directory);
        try {
          for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
            checkSignal(); signal.throwIfAborted();
            if (excluded.has(entry.name)) continue;
            countEntry();
            const path = join(directory, entry.name);
            try { await authorize(path, signal); } catch (error) {
              if (error instanceof Error && error.message === 'captured input path is access-restricted') continue;
              throw error;
            }
            if (entry.isDirectory()) { queue.push(path); continue; }
            if (!entry.isFile()) throw new Error('captured code special-file access is unsupported');
            if (!admitFile(path)) continue;
            take(path, relative(root, path));
          }
        } finally { dir.closeSync(); }
      }
    });
    return { files, directories };
  };
  /** The tree this context's index is shared under; undefined when no tree id can be had (not a git work tree). */
  const sharingKey = (provider: MemoryEmbeddingProvider): string | undefined => {
    if (immutable) return `input\0${contractInputAuthorityTree(authority)}\0${provider.id}`;
    let tree: string | null;
    try { tree = workingTreeIdentity(root); } catch { tree = null; }
    return tree === null ? undefined : `tree\0${tree}\0${provider.id}`;
  };
  const unregisterAssertion = registerLiveAssertion(authority, async () => {
    if (current && operation && !disposed) { const selected = current; await bounded(signal => assertGeneration(selected, signal)); }
  });
  // Revoking the input releases the index this context holds, even when the run never reaches dispose().
  const retire = registerContractInputCleanup(authority, () => {
    unregisterAssertion(); assertReadingCurrent = undefined; cachedStats = undefined; disposed = true; operation?.abort(); current = undefined; releaseIndex();
  });
  const bounded = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    checkSignal();
    if (!operation) throw new Error('captured code operation is unavailable');
    const owner = operation;
    const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), owner.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
    return executePolicyCheck(() => work(signal), signal);
  };
  const source: TurnCodeIndexSource = {
    async prepare() {
      input.signal?.throwIfAborted();
      if (disposed) throw new Error('captured code context is closed');
      // The run's captured generation is already indexed: every later turn reuses it.
      if (immutable && current && shared && operation) { assertReadingCurrent = undefined; return; }
      assertReadingCurrent = undefined; current = undefined; cachedStats = undefined; operation?.abort();
      const owner = new AbortController(); operation = owner;
      const deadline = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
      const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), owner.signal, deadline]);
      pinnedProvider = registry?.getDefaultProviderOrNull() ?? null;
      unavailable = undefined;
      if (pinnedProvider && pinnedProvider.id !== HASHED_MEMORY_EMBEDDING_PROVIDER.id && pinnedProvider.capturedInputAdmission !== 'per-attempt') {
        releaseIndex(); unavailable = 'captured code unavailable: embedding provider lacks per-attempt admission'; return;
      }
      if (!registry || !pinnedProvider || pinnedProvider.id === HASHED_MEMORY_EMBEDDING_PROVIDER.id || pinnedProvider.dimensions !== MEMORY_VECTOR_DIMS || (!pinnedProvider.embed && !pinnedProvider.embedSync)) {
        releaseIndex(); unavailable = 'no semantic embedding provider'; return;
      }
      const provider = pinnedProvider;
      let slot: SharedSlot | undefined;
      let built: CodeIndexStore | undefined;
      let lifetime: AbortController | undefined;
      const stopBuild = (): void => { lifetime?.abort(signal.reason); };
      try {
        const key = sharingKey(provider);
        // The index this context already holds for the same tree (a mutable input
        // whose content did not change since the last turn), or one another context
        // built for it: only this root's file identities are taken, nothing is read
        // or embedded again.
        let reused = shared && key !== undefined && shared.key === key && shared.provider === provider && !shared.lifetime.signal.aborted ? shared : undefined;
        if (!reused) {
          releaseIndex();
          if (key !== undefined) { reused = await acquireShared(key, provider, signal); shared = reused; }
        }
        if (reused) {
          const { files, directories } = await discover(signal, false);
          signal.throwIfAborted();
          if (operation !== owner || shared !== reused) throw new Error('captured code operation was replaced');
          cachedStats = reused.stats;
          current = Object.freeze({ files: Object.freeze(files), directories, id: reused.revision });
          return;
        }
        // Built here, and shared under its tree with every context that asks while it is held.
        if (key !== undefined && !sharedIndexes.has(key)) { slot = createSlot(); sharedIndexes.set(key, slot); }
        const { files, directories } = await discover(signal, true);
        if (!Number.isSafeInteger(++generationSequence)) throw new Error('Captured code identity exhausted');
        // Every file was just authorized and read; the generation is guarded
        // again before each file's chunks leave for the provider and once at the end.
        const generation: Generation = Object.freeze({ files: Object.freeze(files), directories, id: `captured-code-${generationSequence}` });
        signal.throwIfAborted();
        if (operation !== owner) throw new Error('captured code operation was replaced');
        const index = new CodeIndexStore(root, ':memory:', registry); built = index;
        await index.init(); checkProvider(); signal.throwIfAborted();
        if (operation !== owner) throw new Error('captured code operation was replaced');
        if (!index.stats().available) {
          unavailable = 'code index unavailable';
          index.close(); built = undefined;
          if (slot) { if (sharedIndexes.get(key!) === slot) sharedIndexes.delete(key!); slot.reject(new Error(unavailable)); slot = undefined; }
          return;
        }
        // The index outlives this build (other contexts may hold it): its provider
        // requests end with the build's signal only while it is being built.
        const life = new AbortController(); lifetime = life;
        signal.addEventListener('abort', stopBuild, { once: true });
        if (signal.aborted) stopBuild();
        const builderGuard = guardFor(generation, signal);
        await activeGuard.run(builderGuard, () => index.prepareAuthorizedSnapshots({ sourceRevision: generation.id, snapshots: files.map(file => ({ path: file.path, mtimeMs: file.mtimeMs, content: '' })), provider, signal: life.signal, maxChunks: MAX_CHUNKS,
          loadSnapshot: async file => {
            const captured = files.find(candidate => candidate.path === file.path)!;
            // A mutable file's retained text is what the guard compares the
            // file with immediately before the provider sees it; an immutable
            // one is read here against its captured fingerprint.
            return { ...file, content: captured.content ?? bytes(join(root, file.path), captured.fingerprint).content };
          },
          guard: sharedGuard }));
        // prepareAuthorizedSnapshots ended with the whole-generation guard.
        const stats: CodeStats = Object.freeze({ ...await activeGuard.run(builderGuard, () => index.statsAuthorized()) });
        signal.throwIfAborted();
        if (operation !== owner) throw new Error('captured code operation was replaced');
        signal.removeEventListener('abort', stopBuild);
        const entry: SharedCodeIndex = { key: key ?? `private\0${generation.id}`, provider, store: index, revision: generation.id, stats, lifetime: life, holders: 1 };
        built = undefined; lifetime = undefined;
        shared = entry;
        if (slot) { slot.entry = entry; slot.resolve(entry); slot = undefined; }
        cachedStats = stats; current = generation;
      } catch (error) {
        signal.removeEventListener('abort', stopBuild);
        lifetime?.abort();
        built?.close();
        if (slot) {
          for (const [key, value] of sharedIndexes) if (value === slot) sharedIndexes.delete(key);
          slot.reject(error);
        }
        if (operation === owner) { current = undefined; cachedStats = undefined; releaseIndex(); }
        // Over budget is a reason to go without code context, not to fail the run. Caller aborts and
        // every authority or generation failure still throw.
        const overBudget = error instanceof CodeContextTooLarge ? error.message
          : error instanceof Error && error.message === CHUNK_BUDGET_MESSAGE ? `more than ${MAX_CHUNKS} chunks`
          : deadline.aborted && !input.signal?.aborted && !owner.signal.aborted ? `preparation exceeded ${OPERATION_TIMEOUT_MS / 1_000} seconds`
          : undefined;
        if (overBudget !== undefined && operation === owner) { unavailable = `captured code unavailable: too large (${overBudget})`; return; }
        throw error;
      }
    },
    async search(query, options) {
      checkSignal();
      const held = shared; const selected = current;
      if (!held || !selected || !operation) return [];
      // The authorized index guards the generation before the query embedding and before returning results.
      return bounded(signal => activeGuard.run(guardFor(selected, signal), async () => {
        if (current !== selected || shared !== held) throw new Error('captured code generation replaced');
        return held.store.searchAuthorized(query, options);
      }));
    },
    async rankForInjection(query, hits) {
      checkSignal();
      const selected = current;
      if (!selected || !operation) throw new Error('captured code generation unavailable');
      return bounded(async signal => {
        // Each hit file is read once here, from this context's own root; the ranking
        // asks assertCurrent once before its request and the caller once more at consumption.
        const snapshots: { hit: (typeof hits)[number]; code: string }[] = [];
        const skipped: SkippedCodeHit[] = [];
        for (const hit of hits) {
          if (hit.chunk.fileRevision !== selected.id) throw new Error('captured code hit is stale');
          const path = join(root, hit.chunk.path);
          const file = selected.files.find(candidate => candidate.path === hit.chunk.path);
          if (!file) {
            // A shared index can name a file this root does not offer: one its read
            // policy keeps out, or one whose content here differs (an ignored file).
            let restricted = false;
            try { await authorize(path, signal); } catch (error) {
              if (!(error instanceof Error && error.message === 'captured input path is access-restricted')) throw error;
              restricted = true;
            }
            skipped.push({ path: hit.chunk.path, absolutePath: path, reason: restricted ? 'restricted' : 'changed' });
            continue;
          }
          // The live read policy still decides each file whose text is about to be quoted.
          await authorize(path, signal);
          const content = bytes(path, file.fingerprint).content;
          if (file.content !== undefined && content !== file.content) throw new Error('captured code hit changed');
          snapshots.push({ hit, code: content });
        }
        const quoted = snapshots.map(snapshot => snapshot.hit.chunk.path);
        const assertCurrent = async () => {
          if (current !== selected) throw new Error('captured code generation replaced');
          // A captured input: only the files about to be quoted are compared again.
          await assertGeneration(selected, signal, immutable ? quoted : undefined);
        };
        const reading = await rankCodeInjectionSnapshots(query, snapshots, { signal, assertCurrent });
        assertReadingCurrent = reading.assertCurrent;
        return skipped.length > 0 ? { ...reading, skipped } : reading;
      });
    },
    stats() {
      if (cachedStats) return cachedStats;
      return { available: false, indexedChunks: 0, semanticRetrievalAvailable: unavailable !== 'no semantic embedding provider', ...(unavailable ? { error: unavailable } : {}) };
    },
    generation: () => current?.id,
    async assertCurrent(expected) {
      if (!current || !operation) { if (expected !== undefined) throw new Error('captured code generation unavailable'); return; }
      if (expected !== undefined && current.id !== expected) throw new Error('captured code generation replaced');
      const selected = current;
      // A ranking's own check covers the generation; without one, check it directly.
      const reading = assertReadingCurrent;
      await bounded(async signal => { if (reading) await reading(); else await assertGeneration(selected, signal); });
    },
    finishTurn() {
      assertReadingCurrent = undefined;
      if (immutable && current) return;
      // A mutable input may change before the next turn, so its generation is taken
      // again then. The index stays held: an unchanged tree is not read or embedded again.
      cachedStats = undefined; current = undefined; const finished = operation; operation = undefined; finished?.abort();
    },
    dispose() { retire(); },
  };
  return source;
}
