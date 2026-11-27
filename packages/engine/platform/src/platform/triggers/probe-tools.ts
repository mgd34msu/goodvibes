/**
 * probe-tools.ts, the host a `platform-tool` probe calls its tool through.
 *
 * A condition trigger may measure with one of the platform's own tools (a
 * `read`, a `find`, a `state` read...) instead of a command. The tools live in
 * the tool registries the process builds for its sessions, so each registry
 * that offers the `trigger` tool attaches itself here, with the session it
 * belongs to. A check runs the probe's call on the registry of the session
 * that made the trigger when it is attached, else on any attached registry
 * that has the tool. A trigger with no session (made by a web chat, a route) runs on its own project's registry, which
 * it opens itself through the host's one turn environment builder when none is open (`setProjectOpener`).
 *
 * A probe runs unattended, so only a call that only reads runs, decided from
 * the tool's own declaration (no model request): its category and read modes,
 * or the tool's own read-only statement, and never a tool the owner decides.
 * When the registry has a permission owner, the call must also be one that
 * owner allows as a fact (a standing rule or the mode), so the owner's read
 * rules hold for a probe as for any call.
 */

import { randomUUID } from 'node:crypto';
import { readModeCategory, toolCategoryOf, type Tool } from '../types/tools.js';
import type { ToolRegistry } from '../tools/registry.js';
import { ProbeTimeoutError } from './probes.js';
import type { TriggerValue } from './types.js';
import { projectIdentityOf } from '../workspace/project-identity.js';

/** What a probe needs from a tool registry. */
export type ProbeToolRegistry = Pick<ToolRegistry, 'list' | 'execute' | 'previewDecision'>;

interface AttachedRegistry {
  readonly registry: ProbeToolRegistry;
  readonly session?: (() => string | undefined) | undefined;
  /** The project the registry's tools work in (its folder's project identity). */
  readonly project?: string | undefined;
}

/** Whether two folders are the same project (workspace/project-identity.ts, by real path). */
function sameProject(a: string, b: string): boolean {
  return projectIdentityOf(a) === projectIdentityOf(b);
}

/** Whether this call of the tool only reads, from the tool's own declaration. */
export function probeCallOnlyReads(tool: Pick<Tool, 'definition' | 'callReadsOnly'>, args: Record<string, unknown>): boolean {
  const definition = tool.definition;
  if (definition.dangerous === true || definition.sideEffects?.includes('exec')) return false;
  if (tool.callReadsOnly) {
    try { if (tool.callReadsOnly(args) === true) return true; } catch { /* says nothing */ }
  }
  const category = toolCategoryOf(definition);
  if (category !== 'read') return false;
  return definition.readModes === undefined || readModeCategory(definition.readModes, args, category) === 'read';
}

/**
 * Opens a project's tools for one probe (the host's one turn environment builder, in the process's own context): the
 * registry it builds attaches here with its folder; `release` lets it go when the probe is done.
 */
export type ProbeProjectToolOpener = (project: string) => { readonly release: () => Promise<void> };

export class ProbeToolHost {
  private readonly attached = new Set<AttachedRegistry>();
  private opener: ProbeProjectToolOpener | undefined;

  /**
   * How a trigger with no session opens its own project's tools when none are open in this process (after a restart,
   * before any turn there): set by the host that builds turn environments.
   */
  setProjectOpener(open: ProbeProjectToolOpener | undefined): void {
    this.opener = open;
  }

  /**
   * Runs `fn` with the trigger's own project's tools open: already open, as they are; else, for a trigger with no
   * session whose project is known, opened by the host's opener for `fn` and let go after it.
   */
  private async withProjectTools<T>(name: string, ownerSessionId: string | undefined, project: string | undefined, fn: () => Promise<T> | T): Promise<T> {
    const open = this.opener;
    if (open === undefined || ownerSessionId !== undefined || project === undefined || this.find(name, ownerSessionId, project)) return fn();
    let opened: { readonly release: () => Promise<void> } | undefined;
    try { opened = open(project); } catch { /* not a project this host may open: refused below as before */ }
    try { return await fn(); } finally { await opened?.release().catch(() => { /* let go with the host */ }); }
  }

  /** `refusal`, with the trigger's own project's tools opened first when none are open (a trigger made by a route). */
  refusalOpening(name: string, input: Readonly<Record<string, TriggerValue>>, ownerSessionId?: string, project?: string): Promise<string | undefined> {
    return this.withProjectTools(name, ownerSessionId, project, () => this.refusal(name, input, ownerSessionId, project));
  }

  /** A registry whose tools probes may call, with its session and project; returns the detach. */
  attach(registry: ProbeToolRegistry, session?: () => string | undefined, project?: string): () => void {
    const entry: AttachedRegistry = { registry, ...(session ? { session } : {}), ...(project ? { project } : {}) };
    this.attached.add(entry);
    return () => { this.attached.delete(entry); };
  }

  /**
   * The registry and tool a probe from this owner runs on: the owner session's own registry, and only that one. A
   * trigger with no owner session (made by a host's turn that serves many conversations: the daemon's web chat, a
   * capability) runs only on a registry of no session whose project is the trigger's own project. Never another
   * session's or another project's tools, which would read that project's files under its rules.
   */
  private find(name: string, ownerSessionId: string | undefined, project: string | undefined): { readonly registry: ProbeToolRegistry; readonly tool: Tool } | undefined {
    for (const entry of this.attached) {
      let owner: string | undefined;
      try { owner = entry.session?.(); } catch { continue; }
      if (owner !== ownerSessionId) continue;
      // A trigger's project, where both are known, is its registry's; with no session it must be known for both.
      if (project !== undefined && entry.project !== undefined && !sameProject(project, entry.project)) continue;
      if (ownerSessionId === undefined && (project === undefined || entry.project === undefined)) continue;
      const tool = entry.registry.list().find((candidate) => candidate.definition.name === name);
      if (tool) return { registry: entry.registry, tool };
    }
    return undefined;
  }

  /** Why this probe cannot run here, in a sentence with the next step; undefined when it can. */
  refusal(name: string, input: Readonly<Record<string, TriggerValue>>, ownerSessionId?: string, project?: string): string | undefined {
    if (name === 'trigger') return 'A trigger probe cannot call the trigger tool itself. Probe with a tool that reads, such as read, find or state.';
    const found = this.find(name, ownerSessionId, project);
    if (!found) {
      return this.attached.size === 0
        ? `Platform-tool probes run on the tools of an open session, and none is open in this process now; use an http, file or command probe, or create the trigger from a session.`
        : ownerSessionId === undefined
          ? `This trigger's project (${project ?? 'none named'}) has no tools open in this process with one named "${name}", and a probe runs only on its own project's tools. Make the trigger from a conversation in that project, or use an http, file or command probe.`
          : `Session ${ownerSessionId} is not open in this process or has no tool named "${name}"; a probe runs only on its own session's tools. List the tools the session offers and probe with one of them.`;
    }
    if (!probeCallOnlyReads(found.tool, input as Record<string, unknown>)) {
      return `"${name}" with this input does not only read, and a probe runs unattended, so it may call only a tool that reads (read, find, inspect, a state read...). Probe with such a tool, or use a command probe.`;
    }
    return undefined;
  }

  /** Runs the probe's call within its budget and returns the tool's output. */
  call(name: string, input: Readonly<Record<string, TriggerValue>>, timeoutMs: number, ownerSessionId?: string, project?: string): Promise<TriggerValue> {
    // A trigger with no session opens its own project's tools itself when none are open (after a restart, nobody has
    // worked there yet), for this check only.
    return this.withProjectTools(name, ownerSessionId, project, () => this.callOpen(name, input, timeoutMs, ownerSessionId, project));
  }

  private async callOpen(name: string, input: Readonly<Record<string, TriggerValue>>, timeoutMs: number, ownerSessionId?: string, project?: string): Promise<TriggerValue> {
    const refused = this.refusal(name, input, ownerSessionId, project);
    if (refused) throw new Error(refused);
    const { registry } = this.find(name, ownerSessionId, project)!;
    const args = structuredClone(input) as Record<string, unknown>;
    const controller = new AbortController();
    const preview = await registry.previewDecision(name, args, controller.signal);
    if (preview !== undefined && !(preview.decided.kind === 'fact' && preview.decided.allow)) {
      throw new Error(`The owner's rules do not let "${name}" run with this input without being asked, and a probe runs unattended. Allow it with a standing rule, or probe with another tool or a command.`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ProbeTimeoutError('platform-tool', timeoutMs)); }, timeoutMs);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([registry.execute(`trigger-probe-${randomUUID()}`, name, args, { signal: controller.signal }), expired]);
      if (!result.success) throw new Error(`The probe's ${name} call failed: ${result.error ?? 'no reason given'}`);
      return result.output ?? null;
    } finally {
      clearTimeout(timer);
    }
  }
}
