import { readFileSync } from 'node:fs';
import { writeJsonFileAtomic } from '../../utils/atomic-json-store.js';
import { randomUUID } from 'node:crypto';
import { buildSandboxLaunchPlan, executeSandboxCommand, resolveSandboxCommandPlan, type SandboxCommandResult } from './backend.js';
import { getSandboxConfigSnapshot, listSandboxProfiles, renderSandboxReview, type ConfigManagerLike } from './manager.js';
import { defineLifecycle } from '../../utils/lifecycle-machine.js';
import type {
  SandboxProfile,
  SandboxSession,
  SandboxSessionArtifact,
  SandboxSessionKind,
  SandboxSessionState,
} from './types.js';

/**
 * The sandbox session lifecycle, from the moves this registry makes: a start
 * leaves a session running; a command exit moves running <-> failed; stop ends
 * it from anywhere. `stopped` is final, so a stopped session refuses commands
 * and a late exit cannot revive or fail it. `planned` is declared in the
 * session type but never assigned by this registry.
 */
export const sandboxSessionLifecycle = defineLifecycle<SandboxSessionState>('sandbox session', {
  planned: ['running', 'failed', 'stopped'],
  running: ['failed', 'stopped'],
  failed: ['running', 'stopped'],
  stopped: [],
});

function createSandboxSessionId(): string {
  return `sandbox_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function inferShared(profile: SandboxProfile): boolean {
  return profile.isolation === 'shared';
}

function inferKind(profile: SandboxProfile): SandboxSessionKind {
  return profile.kind;
}

export class SandboxSessionRegistry {
  private readonly sessions = new Map<string, SandboxSession>();
  /** How many starters hold each shared session; it stops only when the last one lets go. */
  private readonly sharedHolders = new Map<string, number>();
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  private updateSession(sessionId: string, updater: (session: SandboxSession) => SandboxSession): SandboxSession {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      throw new Error(`Unknown sandbox session: ${sessionId}`);
    }
    const next = Object.freeze(updater(existing));
    this.sessions.set(sessionId, next);
    return next;
  }

  /** The actual workspace target used to build this registry’s process plans. */
  public getWorkspaceRoot(): string { return this.workspaceRoot; }

  public list(): SandboxSession[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  public async start(profileId: SandboxProfile['id'], label: string | undefined, configManager: ConfigManagerLike): Promise<SandboxSession> {
    const profile = listSandboxProfiles(configManager).find((entry) => entry.id === profileId);
    if (!profile) {
      throw new Error(`Unknown sandbox profile: ${profileId}`);
    }
    if (inferShared(profile)) {
      // A shared session whose last command exited non-zero is still the shared
      // session; only a stop ends it. Without this, one failing command would
      // make the next start create a duplicate.
      const existing = [...this.sessions.values()].find((session) => session.profileId === profileId
        && (session.state === 'running' || session.state === 'failed'));
      if (existing) {
        this.sharedHolders.set(existing.id, (this.sharedHolders.get(existing.id) ?? 1) + 1);
        return existing;
      }
    }
    return this.startNew(profile, label, configManager);
  }

  /**
   * Records the session and its launch plan; nothing is spawned here. The only
   * backend runs commands on the host, so there is no boundary to verify at
   * start and the session reports `planned`. Whether a process actually starts
   * is reported by whoever spawns it (an MCP connect, or `execute`). A backend
   * that isolates must throw from here when it cannot start, so no caller
   * continues with a session it must not use.
   */
  private startNew(profile: SandboxProfile, label: string | undefined, configManager: ConfigManagerLike): SandboxSession {
    const config = getSandboxConfigSnapshot(configManager);
    const launchPlan = buildSandboxLaunchPlan(profile, label?.trim() || profile.label, this.workspaceRoot);
    const session: SandboxSession = Object.freeze({
      id: createSandboxSessionId(),
      profileId: profile.id,
      kind: inferKind(profile),
      label: label?.trim() || profile.label,
      shared: inferShared(profile),
      startedAt: Date.now(),
      state: 'running',
      backend: config.vmBackend,
      resolvedBackend: launchPlan.backend,
      launchPlan,
      startupStatus: 'planned',
      startupDetail: launchPlan.summary,
      notes: profile.notes,
    });
    this.sessions.set(session.id, session);
    if (session.shared) this.sharedHolders.set(session.id, 1);
    return session;
  }

  /**
   * Stops a session. A shared session that several starters hold (for example
   * two MCP servers using one profile) is released by one of them and keeps
   * running until the last holder stops it. The last release removes the session
   * from the registry and returns its final, stopped record; a later stop or
   * command for that id finds nothing.
   */
  public stop(sessionId: string): SandboxSession | null {
    const existing = this.sessions.get(sessionId);
    if (!existing) return null;
    const holders = this.sharedHolders.get(sessionId) ?? 1;
    if (existing.state !== 'stopped' && holders > 1) {
      this.sharedHolders.set(sessionId, holders - 1);
      return existing;
    }
    this.sharedHolders.delete(sessionId);
    this.sessions.delete(sessionId);
    const stopped: SandboxSession = { ...existing, state: 'stopped' };
    return Object.freeze(stopped);
  }

  public get(sessionId: string): SandboxSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  public async execute(
    sessionId: string,
    command: string,
    args: readonly string[],
    options: {
      readonly cwd?: string | undefined;
      readonly env?: NodeJS.ProcessEnv | undefined;
      readonly inheritHostEnv?: boolean | undefined;
      readonly timeoutMs?: number | undefined;
      readonly input?: string | undefined;
    } = {},
  ): Promise<SandboxCommandResult> {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Unknown sandbox session: ${sessionId}`);
    }
    if (!session.launchPlan) {
      throw new Error(`Sandbox session ${sessionId} does not have a launch plan.`);
    }

    if (session.state === 'stopped') {
      const refusal = sandboxSessionLifecycle.check('stopped', 'running');
      throw new Error(`Sandbox session ${sessionId} cannot run commands: ${refusal.ok ? 'session is stopped' : refusal.reason}`);
    }

    const resolvedPlan = resolveSandboxCommandPlan(command, args);
    const result = await executeSandboxCommand(session.launchPlan, command, args, options);
    const stdoutPreview = (result.stdout || '').trim().slice(0, 200);
    const stderrPreview = (result.stderr || '').trim().slice(0, 200);
    const exitState: SandboxSession['state'] = result.status === 0 ? 'running' : 'failed';

    // A session stopped while the command ran is gone from the registry; its result is still returned.
    if (this.sessions.has(sessionId)) this.updateSession(sessionId, (current) => ({
      ...current,
      // A session stopped while the command ran stays stopped; a late exit cannot revive or fail it.
      state: current.state === exitState || sandboxSessionLifecycle.can(current.state, exitState) ? exitState : current.state,
      lastRunAt: Date.now(),
      lastCommandSummary: resolvedPlan.summary,
      lastExitStatus: result.status,
      lastStdoutPreview: stdoutPreview || undefined,
      lastStderrPreview: stderrPreview || undefined,
      executionCount: (current.executionCount ?? 0) + 1,
    }));

    return result;
  }

  public exportArtifact(sessionId: string, targetPath: string, configManager: ConfigManagerLike): SandboxSessionArtifact {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Unknown sandbox session: ${sessionId}`);
    }
    const artifact: SandboxSessionArtifact = {
      version: 1,
      exportedAt: Date.now(),
      session,
      reviewText: renderSandboxReview(configManager),
    };
    writeJsonFileAtomic(targetPath, artifact);
    return artifact;
  }

  public inspectArtifact(targetPath: string): SandboxSessionArtifact {
    const parsed: unknown = JSON.parse(readFileSync(targetPath, 'utf-8'));
    const record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
    const session = record && typeof record.session === 'object' && record.session !== null ? record.session as Record<string, unknown> : null;
    if (!record || record.version !== 1 || !session || typeof session.id !== 'string' || typeof record.reviewText !== 'string') {
      throw new Error(`${targetPath} is not a sandbox session artifact (expected version 1 with a session and review text).`);
    }
    return parsed as SandboxSessionArtifact;
  }
}
