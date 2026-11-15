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
 * probe leaves a session running or failed; a command exit moves running <-> failed;
 * stop ends it from anywhere. `stopped` is final, so a stopped session refuses
 * commands and a late exit cannot revive or fail it. `planned` is declared in the
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
  /** Shared starts still probing their backend; a second starter joins this one instead of creating a duplicate. */
  private readonly sharedStarting = new Map<SandboxProfile['id'], Promise<SandboxSession>>();
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
      // session (its backend verified at start); only a failed startup probe or
      // a stop makes it unusable. Without this, one failing command would make
      // the next start create a duplicate. A session whose startup probe failed
      // is never handed out, whatever its state became after a later command.
      const existing = [...this.sessions.values()].find((session) => session.profileId === profileId
        && session.startupStatus === 'verified'
        && (session.state === 'running' || session.state === 'failed'));
      if (existing) {
        this.sharedHolders.set(existing.id, (this.sharedHolders.get(existing.id) ?? 1) + 1);
        return existing;
      }
      const starting = this.sharedStarting.get(profileId);
      if (starting) {
        const joined = await starting;
        this.sharedHolders.set(joined.id, (this.sharedHolders.get(joined.id) ?? 1) + 1);
        return joined;
      }
      const pending = this.startNew(profile, label, configManager);
      this.sharedStarting.set(profileId, pending);
      try {
        return await pending;
      } finally {
        this.sharedStarting.delete(profileId);
      }
    }
    return this.startNew(profile, label, configManager);
  }

  private async startNew(profile: SandboxProfile, label: string | undefined, configManager: ConfigManagerLike): Promise<SandboxSession> {
    const config = getSandboxConfigSnapshot(configManager);
    const launchPlan = buildSandboxLaunchPlan(profile, label?.trim() || profile.label, this.workspaceRoot);
    let state: SandboxSession['state'] = 'running';
    let startupStatus: SandboxSession['startupStatus'] = 'verified';
    let startupDetail = launchPlan.summary;
    const startupProbe = await executeSandboxCommand(launchPlan, 'bash', ['-lc', 'printf sandbox-ready'], {
      timeoutMs: 2000,
    });
    if (startupProbe.status !== 0 || !startupProbe.stdout.includes('sandbox-ready')) {
      state = 'failed';
      startupStatus = 'failed';
      startupDetail = (startupProbe.stderr || startupProbe.stdout || 'Sandbox backend startup probe failed.').trim();
    }
    const session: SandboxSession = Object.freeze({
      id: createSandboxSessionId(),
      profileId: profile.id,
      kind: inferKind(profile),
      label: label?.trim() || profile.label,
      shared: inferShared(profile),
      startedAt: Date.now(),
      state,
      backend: config.vmBackend,
      resolvedBackend: launchPlan.backend,
      launchPlan,
      startupStatus,
      startupDetail,
      notes: profile.notes,
    });
    this.sessions.set(session.id, session);
    if (session.shared) this.sharedHolders.set(session.id, 1);
    return session;
  }

  /**
   * Stops a session. A shared session that several starters hold (for example
   * two MCP servers using one profile) is released by one of them and keeps
   * running until the last holder stops it.
   */
  public stop(sessionId: string): SandboxSession | null {
    const existing = this.sessions.get(sessionId);
    if (!existing) return null;
    if (existing.state === 'stopped') return existing;
    const holders = this.sharedHolders.get(sessionId) ?? 1;
    if (holders > 1) {
      this.sharedHolders.set(sessionId, holders - 1);
      return existing;
    }
    this.sharedHolders.delete(sessionId);
    return this.updateSession(sessionId, (session) => ({
      ...session,
      state: 'stopped',
    }));
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
    // A backend that never passed its startup probe stays failed: one command that
    // happens to exit 0 does not verify it, and its startupDetail still explains why.
    const exitState: SandboxSession['state'] = result.status === 0 && session.startupStatus !== 'failed' ? 'running' : 'failed';

    this.updateSession(sessionId, (current) => ({
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
