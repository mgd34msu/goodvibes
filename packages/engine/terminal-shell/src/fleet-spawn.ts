/**
 * fleet-spawn.ts, the "new agent" key of the Your agents panel in both
 * terminal programs: 'n' lists the third-party coding agents the daemon
 * discovered (acp.agents.list, read-only), you pick one, then a working
 * directory from the known candidates (the current directory and the
 * registered workspaces, never a typed path), and acp.sessions.create hosts it
 * as a long-lived daemon session. The new agent shows up on the next fleet
 * reading and opens, steers and stops like any other.
 *
 * A structured failure ({binary, stage, message}) is said in plain words,
 * never a hung row: the daemon bounds the handshake and returns a failed
 * record.
 *
 * The controller owns the panel's input while a pick is open; the panel draws
 * spawnView(). Each program builds the gateway over its own daemon
 * resolution: the terminal app over its operator endpoint, the Agent over its
 * daemon verb caller (createVerbSpawnGateway).
 */

import type { OperatorMethodOutput } from '@goodvibes-jev/engine/platform';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';

/** One discovered third-party ACP agent (acp.agents.list). */
export type AcpDiscoveredAgent = OperatorMethodOutput<'acp.agents.list'>['agents'][number];
/** acp.sessions.create output, the hosted record and whether it started. */
export type AcpSpawnResult = OperatorMethodOutput<'acp.sessions.create'>;
/** One registered workspace root (workspaces.registrations.list). */
export type AcpWorkspaceRegistration = OperatorMethodOutput<'workspaces.registrations.list'>['workspaces'][number];

/** A working-directory candidate offered in the picker: a known directory, never retyped. */
export interface AcpDirCandidate {
  readonly path: string;
  /** A short label (a workspace label, or "current directory"). */
  readonly label: string;
}

/** The daemon calls the flow makes. */
export interface AcpSpawnGateway {
  /** Discovered third-party agents (read-only; empty is an honest absence). */
  listAgents(): Promise<readonly AcpDiscoveredAgent[]>;
  /** The registered workspace roots, the known-directory candidates. */
  listWorkspaces(): Promise<readonly AcpWorkspaceRegistration[]>;
  /** Host a discovered agent in a directory as a long-lived daemon session. */
  createSession(input: { readonly agentId: string; readonly cwd: string }): Promise<AcpSpawnResult>;
}

export type AcpSpawnGatewayResolution =
  | { readonly available: true; readonly gateway: AcpSpawnGateway }
  | { readonly available: false; readonly reason: string };

/** The gateway over a daemon verb caller (the Agent's connected host). Refuses with the probe's reason when no daemon answers. */
export function createVerbSpawnGateway(verbs: DaemonVerbCaller): AcpSpawnGatewayResolution {
  const reach = verbs.probe();
  if (!reach.available) return { available: false, reason: reach.reason };
  return {
    available: true,
    gateway: {
      listAgents: async () => (await verbs.invoke<OperatorMethodOutput<'acp.agents.list'>>('acp.agents.list', {})).agents,
      listWorkspaces: async () => (await verbs.invoke<OperatorMethodOutput<'workspaces.registrations.list'>>('workspaces.registrations.list', {})).workspaces,
      createSession: (input) => verbs.invoke<AcpSpawnResult>('acp.sessions.create', input),
    },
  };
}

export interface FleetSpawnDeps {
  /** Resolve a live gateway per action (a daemon that comes up mid-session is seen). */
  readonly resolveGateway: () => AcpSpawnGatewayResolution;
  /** The current working directory, always a candidate (labelled "current directory"). */
  readonly currentDirectory: () => string;
  /** Say a result or an error when the panel is not open to show it. */
  readonly notify: (message: string) => void;
  /** Repaint when the controller's own state changes. */
  readonly markDirty: () => void;
}

interface AgentStep {
  readonly step: 'agent';
  readonly agents: readonly AcpDiscoveredAgent[];
  index: number;
}
interface DirStep {
  readonly step: 'dir';
  readonly agent: AcpDiscoveredAgent;
  readonly candidates: readonly AcpDirCandidate[];
  index: number;
}
type SpawnMode = AgentStep | DirStep | null;

/** The spawn picker, as data. */
export interface FleetSpawnView {
  readonly step: 'agent' | 'dir';
  readonly title: string;
  readonly intro: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly detail: string; readonly selected: boolean }>;
  /** A create round trip is in flight. */
  readonly creating: boolean;
}

export class FleetSpawn {
  private mode: SpawnMode = null;
  private creating = false;
  private generation = 0;
  private reading = false;
  /** While the panel is open its status line takes the flow's messages, so they are seen where 'n' was pressed. */
  private sink: ((message: string) => void) | null = null;

  public constructor(private readonly deps: FleetSpawnDeps) {}

  /** Route the flow's messages to the open panel's status line (null: back to notify). */
  public reportTo(sink: ((message: string) => void) | null): void {
    this.sink = sink;
  }

  private report(message: string): void {
    if (this.sink === null) { this.deps.notify(message); return; }
    this.sink(message);
    this.deps.markDirty();
  }

  /** True while the picker owns the panel's view and input. */
  public spawnModeActive(): boolean {
    return this.mode !== null;
  }

  /** Begin: list the discovered agents. None found is said, and no picker opens. */
  public async begin(): Promise<void> {
    if (this.mode !== null || this.creating || this.reading) return;
    const generation = ++this.generation;
    const gateway = this.requireGateway();
    if (!gateway) return;
    this.reading = true;
    try {
      const agents = await gateway.listAgents();
      if (generation !== this.generation) return;
      if (agents.length === 0) {
        this.report('No coding agents found to host (Claude Code, Codex, opencode). Install one on your PATH to host it here.');
        return;
      }
      this.mode = { step: 'agent', agents, index: 0 };
      this.deps.markDirty();
    } catch (err) {
      if (generation === this.generation) this.report(`Couldn't list the coding agents: ${summarizeError(err)}`);
    } finally {
      if (generation === this.generation) this.reading = false;
    }
  }

  /** Release the panel; pending reads may settle but cannot reopen the flow. */
  public cancel(): void {
    this.generation++;
    this.reading = false;
    this.mode = null;
  }

  /** Input while the picker is open. Takes every key. */
  public handleSpawnInput(key: string): boolean {
    if (!this.mode) return true;
    if (key === 'escape' || key === 'esc') { this.cancel(); this.deps.markDirty(); return true; }
    if (this.creating || this.reading) return true;
    const list = this.mode.step === 'agent' ? this.mode.agents : this.mode.candidates;
    if (key === 'up' || key === 'k') { this.mode.index = (this.mode.index - 1 + list.length) % list.length; this.deps.markDirty(); return true; }
    if (key === 'down' || key === 'j') { this.mode.index = (this.mode.index + 1) % list.length; this.deps.markDirty(); return true; }
    if (key === 'enter' || key === 'return') { void this.advance(); return true; }
    return true;
  }

  private async advance(): Promise<void> {
    if (!this.mode || this.reading) return;
    if (this.mode.step === 'agent') {
      const agent = this.mode.agents[this.mode.index];
      if (!agent) return;
      const generation = this.generation;
      this.reading = true;
      try {
        const candidates = await this.resolveDirCandidates();
        if (generation !== this.generation) return;
        this.mode = { step: 'dir', agent, candidates, index: 0 };
        this.deps.markDirty();
      } finally {
        if (generation === this.generation) this.reading = false;
      }
      return;
    }
    const cwd = this.mode.candidates[this.mode.index]?.path;
    const agentId = this.mode.agent.id;
    if (!cwd) return;
    await this.createSession(agentId, cwd);
  }

  /** The current directory first, then the registered workspaces (deduplicated). */
  private async resolveDirCandidates(): Promise<AcpDirCandidate[]> {
    const current = this.deps.currentDirectory();
    const candidates: AcpDirCandidate[] = [{ path: current, label: 'current directory' }];
    const gateway = this.requireGateway();
    if (gateway) {
      try {
        for (const ws of await gateway.listWorkspaces()) {
          if (ws.root === current) continue;
          candidates.push({ path: ws.root, label: ws.label ?? 'workspace' });
        }
      } catch {
        // The current directory is still offered when the workspaces cannot be read.
      }
    }
    return candidates;
  }

  private async createSession(agentId: string, cwd: string): Promise<void> {
    const gateway = this.requireGateway();
    if (!gateway) { this.mode = null; this.deps.markDirty(); return; }
    const generation = this.generation;
    this.creating = true;
    this.deps.markDirty();
    try {
      const result = await gateway.createSession({ agentId, cwd });
      const hosted = result.hosted;
      if (hosted.error) {
        this.report(`Couldn't start ${hosted.title || agentId} (${hosted.error.binary}, ${hosted.error.stage} step): ${hosted.error.message}`);
      } else {
        this.report(`Started ${hosted.title || agentId} in ${cwd}. It is listed here; open, steer and stop it like any agent.`);
      }
    } catch (err) {
      this.report(`Couldn't start the agent: ${summarizeError(err)}`);
    } finally {
      this.creating = false;
      if (generation === this.generation) {
        this.mode = null;
        this.deps.markDirty();
      }
    }
  }

  /** The picker as data, or null when it is not open. */
  public spawnView(): FleetSpawnView | null {
    if (!this.mode) return null;
    if (this.creating) return { step: this.mode.step, title: 'Starting the agent…', intro: '', options: [], creating: true };
    if (this.mode.step === 'agent') {
      const index = this.mode.index;
      return {
        step: 'agent',
        title: 'New agent',
        intro: 'Host a coding agent here: choose one, then the folder it works in.',
        options: this.mode.agents.map((agent, i) => ({ label: agent.title, detail: agent.binaryPath, selected: i === index })),
        creating: false,
      };
    }
    const index = this.mode.index;
    return {
      step: 'dir',
      title: this.mode.agent.title,
      intro: `Which folder ${this.mode.agent.title} works in:`,
      options: this.mode.candidates.map((cand, i) => ({ label: cand.label, detail: cand.path, selected: i === index })),
      creating: false,
    };
  }

  private requireGateway(): AcpSpawnGateway | null {
    const resolution = this.deps.resolveGateway();
    if (!resolution.available) { this.report(resolution.reason); return null; }
    return resolution.gateway;
  }
}
