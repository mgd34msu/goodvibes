import { join } from 'node:path';
import { requireSurfaceRoot, resolveSurfaceDirectory } from './surface-root.js';
import type { NativeDataWriteOwner } from './native-reader-compatibility.js';
import { createRecoveryPathResolver } from './recovery-path.js';

/**
 * The raw identity a product declares once at startup: which surface it is
 * (`'tui'`, `'agent'`, a future third-party name...) plus the two directories
 * every storage path derives from. `createSessionSurface` turns this into a
 * fully-resolved `SessionSurface`, the declare-once handle every reader and
 * writer in that product threads through instead of re-deriving paths per call.
 */
export interface SurfaceIdentity {
  /** Admitted installation publisher; restricts downgrade before opaque recovery files. */
  readonly nativeDataWriter?: NativeDataWriteOwner | undefined;
  /** Single path segment identifying the product, e.g. 'tui' | 'agent'. Validated by requireSurfaceRoot: throws if omitted, empty, or not a single segment. */
  readonly surfaceRoot: string;
  /** Project root all per-project state (sessions, recovery, checkpoints) is anchored to. */
  readonly workingDirectory: string;
  /** User home directory. Carried on the surface for identity purposes; none of the paths below are derived from it. */
  readonly homeDirectory: string;
}

/**
 * A product's declare-once storage handle. Every path a session-persistence
 * or session-manager call needs is pre-resolved here, at construction, from a
 * single `SurfaceIdentity`, so a writer and a reader that both hold the same
 * `SessionSurface` can never disagree about where a file lives. This replaces
 * the old pattern of passing `surfaceRoot` / `workingDirectory` / `homeDirectory`
 * independently to each call, where an omitted `surfaceRoot` silently fell back
 * to the shared, unscoped `.goodvibes/` directory instead of erroring.
 */
export interface SessionSurface {
  readonly surfaceRoot: string;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** `<workingDirectory>/.goodvibes/<surfaceRoot>/sessions` */
  readonly sessionsDir: string;
  /** `<workingDirectory>/.goodvibes/<surfaceRoot>/sessions/agents` */
  readonly agentJournalsDir: string;
  /** `sessionsDir/last-session.json` */
  readonly lastSessionPointer: string;
  /**
   * `<workingDirectory>/.goodvibes/<surfaceRoot>/recovery`, anchored to
   * `workingDirectory`, NOT `homeDirectory`. A crash-recovery snapshot lives
   * with the project it happened in, so a crash in one project never nags
   * the boot of an unrelated project.
   */
  readonly recoveryDir: string;
  /** `<workingDirectory>/.goodvibes/<surfaceRoot>/state` */
  readonly stateDir: string;
  /** `<workingDirectory>/.goodvibes/shared/checkpoints`: the project's one store, every program's (projectCheckpointsDir). */
  readonly checkpointsDir: string;
  /** Current saved path; safe IDs retain their filename. Opaque suggestions
   * before first publication are local to this owner; the writer coordinates
   * the final path and subsequent lookups use the actual saved header. */
  recoveryFile(sessionId: string): string;
}

function requireNonEmptyDirectory(value: string, source: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${source} must be a non-empty directory path.`);
  }
  return normalized;
}

/**
 * Build a `SessionSurface` from a `SurfaceIdentity`. Throws synchronously,
 * at construction, not on first use, when `surfaceRoot` is omitted, empty, or
 * not a single path segment (delegated to `requireSurfaceRoot`), or when
 * `workingDirectory` / `homeDirectory` is empty. A product calls this exactly
 * once at startup and threads the resulting handle through every reader and
 * writer, so there is no later call site where the scope can be re-guessed,
 * mismatched, or silently resolved to an unscoped path.
 */
export function createSessionSurface(identity: SurfaceIdentity): SessionSurface {
  const surfaceRoot = requireSurfaceRoot(identity.surfaceRoot, 'SurfaceIdentity.surfaceRoot');
  const workingDirectory = requireNonEmptyDirectory(identity.workingDirectory, 'SurfaceIdentity.workingDirectory');
  const homeDirectory = requireNonEmptyDirectory(identity.homeDirectory, 'SurfaceIdentity.homeDirectory');

  const sessionsDir = resolveSurfaceDirectory(workingDirectory, surfaceRoot, 'sessions');
  const recoveryDir = resolveSurfaceDirectory(workingDirectory, surfaceRoot, 'recovery');

  const recoveryFile = createRecoveryPathResolver(recoveryDir, identity.nativeDataWriter);
  return {
    surfaceRoot,
    workingDirectory,
    homeDirectory,
    sessionsDir,
    agentJournalsDir: join(sessionsDir, 'agents'),
    lastSessionPointer: join(sessionsDir, 'last-session.json'),
    recoveryDir,
    stateDir: resolveSurfaceDirectory(workingDirectory, surfaceRoot, 'state'),
    checkpointsDir: projectCheckpointsDir(workingDirectory),
    recoveryFile,
  };
}

/**
 * The ONE checkpoint store of a project, shared by the terminal app, the Agent and the daemon: one history a person
 * sees and restores from in any of them (`<project>/.goodvibes/shared/checkpoints`).
 */
export function projectCheckpointsDir(projectFolder: string): string {
  return join(projectFolder, '.goodvibes', 'shared', 'checkpoints');
}

/**
 * The cross-process lock of a project's one checkpoint store (checkpoint/manager.ts takes it for every change to the
 * store). Moving the file-writes record aside and carrying a subfolder's earlier records take it too, so each runs
 * alone among every program and the daemon working in the project.
 */
export function projectStoreLockPath(projectFolder: string): string {
  return join(projectCheckpointsDir(projectFolder), 'git', '.gv-lock');
}

/**
 * The stores each program kept of its own before the one store (the terminal app's, which the daemon used too, the
 * Agent's, and the unscoped one of the earliest releases), under `folder`: merged into the one store once, in time
 * order, and left exactly as they were for a rollback.
 */
export function formerCheckpointsDirs(folder: string): readonly string[] {
  return [...['tui', 'agent'].map((surface) => resolveSurfaceDirectory(folder, surface, 'checkpoints')), join(folder, '.goodvibes', 'checkpoints')];
}
