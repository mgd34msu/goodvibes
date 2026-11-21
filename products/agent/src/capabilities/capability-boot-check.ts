import { logger } from '@goodvibes/engine/platform/platform/utils';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { registerBuiltinCapabilities } from './builtin-capabilities.ts';
import { resolveCapabilityIndex } from './capability-index.ts';
import { installCapabilityResolver, refreshCapabilityIndex } from './capability-snapshot.ts';
import type { McpServerPosture, ProbeContext } from './capability-probe-runner.ts';
import type { CapabilityIndexReport } from '@goodvibes/engine/terminal-shell/agent-turn/capability-types';

/**
 * The boot-time capability check.
 *
 * It answers "what can this agent do right now" before the first turn, without
 * doing any of it: no message sent, no browser opened, no page fetched, no
 * money spent. Every check is a read (see capability-probe-runner.ts), so this
 * is safe to run on every startup.
 *
 * Anything it finds configured-but-unreported is a defect in the index, and it
 * is logged plainly here as well as carried into the model's context. The
 * failure this replaces was silent: the agent said no, and nothing anywhere
 * recorded that the ingredients for a yes were sitting on disk.
 */

export interface CapabilityBootCheckInput {
  readonly toolRegistry: ToolRegistry;
  readonly homeDirectory: string;
  readonly workingDirectory: string;
  /** Answers whether a config key holds a value. Never returns the value. */
  readonly configValuePresent: ProbeContext['configValuePresent'];
  /** Answers whether a secret-store entry holds a value. Never returns the value. */
  readonly secretPresent?: ProbeContext['secretPresent'];
  /** Reads the MCP posture (and why it could not be read) now; called on every resolution, so a server that connects or drops mid-session is seen. */
  readonly mcpServers?: () => McpServerPosture;
  /**
   * Reads the qualified names (`mcp:<server>:<tool>`) of the MCP tools offered now; called on every resolution.
   * The MCP API lists tools only asynchronously, so the Agent's wiring supplies none and an
   * `mcp-tool-available` probe reports unsatisfied; no built-in capability declares one.
   */
  readonly mcpToolNames?: () => Iterable<string>;
  /** Operator method ids the daemon serves, from the static operator contract. */
  readonly servedOperatorMethodIds?: Iterable<string>;
}

export function buildProbeContext(input: CapabilityBootCheckInput): ProbeContext {
  let registeredToolNames: ReadonlySet<string>;
  try {
    registeredToolNames = new Set(input.toolRegistry.getToolDefinitions().map((tool) => tool.name));
  } catch {
    registeredToolNames = new Set();
  }
  const mcp = input.mcpServers?.();
  return {
    registeredToolNames,
    mcpServers: mcp?.servers ?? [],
    ...(mcp?.unreadable ? { mcpServersUnreadable: mcp.unreadable } : {}),
    mcpToolNames: new Set(input.mcpToolNames?.() ?? []),
    servedOperatorMethodIds: new Set(input.servedOperatorMethodIds ?? []),
    configValuePresent: input.configValuePresent,
    ...(input.secretPresent ? { secretPresent: input.secretPresent } : {}),
  };
}

export function runCapabilityBootCheck(input: CapabilityBootCheckInput): CapabilityIndexReport {
  registerBuiltinCapabilities({
    homeDirectory: input.homeDirectory,
    workingDirectory: input.workingDirectory,
  });
  // Registered tools, MCP posture, config and secrets are read live on each
  // resolution; served methods come from the static operator contract.
  installCapabilityResolver(() => resolveCapabilityIndex(buildProbeContext(input), { homeDirectory: input.homeDirectory }));
  const report = refreshCapabilityIndex()!;

  for (const disagreement of report.disagreements) {
    // Loud on purpose. A capability the agent will refuse while its service is
    // configured is a defect, and it gets said out loud rather than swallowed.
    logger.warn('capability index disagreement: configured but not usable', {
      capability: disagreement.capabilityId,
      reportedState: disagreement.reportedState,
      evidence: disagreement.evidence.join('; '),
      fix: disagreement.fix,
    });
  }
  return report;
}
