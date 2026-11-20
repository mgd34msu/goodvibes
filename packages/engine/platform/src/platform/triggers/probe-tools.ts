/**
 * probe-tools.ts, the host a `platform-tool` probe calls its tool through.
 *
 * A condition trigger may measure with one of the platform's own tools (a
 * `read`, a `find`, a `state` read...) instead of a command. The tools live in
 * the tool registries the process builds for its sessions, so each registry
 * that offers the `trigger` tool attaches itself here, with the session it
 * belongs to. A check runs the probe's call on the registry of the session
 * that made the trigger when it is attached, else on any attached registry
 * that has the tool.
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

/** What a probe needs from a tool registry. */
export type ProbeToolRegistry = Pick<ToolRegistry, 'list' | 'execute' | 'previewDecision'>;

interface AttachedRegistry {
  readonly registry: ProbeToolRegistry;
  readonly session?: (() => string | undefined) | undefined;
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

export class ProbeToolHost {
  private readonly attached = new Set<AttachedRegistry>();

  /** A registry whose tools probes may call; returns the detach. */
  attach(registry: ProbeToolRegistry, session?: () => string | undefined): () => void {
    const entry: AttachedRegistry = { registry, ...(session ? { session } : {}) };
    this.attached.add(entry);
    return () => { this.attached.delete(entry); };
  }

  /**
   * The registry and tool a probe from this owner runs on: the owner
   * session's own registry, and only that one. A trigger with no owner session
   * runs only on a registry that belongs to no session. Never another
   * session's tools, which would run with that session's grants.
   */
  private find(name: string, ownerSessionId: string | undefined): { readonly registry: ProbeToolRegistry; readonly tool: Tool } | undefined {
    for (const entry of this.attached) {
      let owner: string | undefined;
      try { owner = entry.session?.(); } catch { continue; }
      if (owner !== ownerSessionId) continue;
      const tool = entry.registry.list().find((candidate) => candidate.definition.name === name);
      if (tool) return { registry: entry.registry, tool };
    }
    return undefined;
  }

  /** Why this probe cannot run here, in a sentence with the next step; undefined when it can. */
  refusal(name: string, input: Readonly<Record<string, TriggerValue>>, ownerSessionId?: string): string | undefined {
    if (name === 'trigger') return 'A trigger probe cannot call the trigger tool itself. Probe with a tool that reads, such as read, find or state.';
    const found = this.find(name, ownerSessionId);
    if (!found) {
      return this.attached.size === 0
        ? `Platform-tool probes run on the tools of an open session, and none is open in this process now; use an http, file or command probe, or create the trigger from a session.`
        : ownerSessionId === undefined
          ? `This trigger belongs to no session, and only a session's own tools run its platform-tool probe. Create the trigger from the session whose "${name}" it should call, or use an http, file or command probe.`
          : `Session ${ownerSessionId} is not open in this process or has no tool named "${name}"; a probe runs only on its own session's tools. List the tools the session offers and probe with one of them.`;
    }
    if (!probeCallOnlyReads(found.tool, input as Record<string, unknown>)) {
      return `"${name}" with this input does not only read, and a probe runs unattended, so it may call only a tool that reads (read, find, inspect, a state read...). Probe with such a tool, or use a command probe.`;
    }
    return undefined;
  }

  /** Runs the probe's call within its budget and returns the tool's output. */
  async call(name: string, input: Readonly<Record<string, TriggerValue>>, timeoutMs: number, ownerSessionId?: string): Promise<TriggerValue> {
    const refused = this.refusal(name, input, ownerSessionId);
    if (refused) throw new Error(refused);
    const { registry } = this.find(name, ownerSessionId)!;
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
