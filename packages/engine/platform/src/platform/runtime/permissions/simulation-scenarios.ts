import type { PermissionSimulator } from './simulation.js';
import { readCallClassification } from '../../gate/reading.js';
import { resolve } from 'node:path';
import type { DivergenceType, PermissionDecision, PolicyRule, SimulationMode } from './types.js';

export interface PolicySimulationScenario {
  id: string;
  label: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface PolicySimulationScenarioResult {
  scenario: PolicySimulationScenario;
  actualDecision: PermissionDecision;
  simulatedDecision: PermissionDecision;
  authoritativeDecision: PermissionDecision;
  diverged: boolean;
  divergenceType?: DivergenceType | undefined;
}

export interface PolicySimulationSummary {
  simulatedAt: string;
  mode: SimulationMode;
  totalScenarios: number;
  divergentScenarios: number;
  allowedByActual: number;
  allowedBySimulated: number;
  results: PolicySimulationScenarioResult[];
}

/** Where a candidate's evidence comes from: the project the owner works in, and the rules whose targets deserve a probe. */
export interface PolicySimulationScenarioSource {
  /** The real project root; the canned file scenarios are placed under it. Default `/workspace`. */
  readonly projectRoot?: string | undefined;
  /** The rules (current and candidate) whose own path, host and command targets are probed. */
  readonly rules?: readonly PolicyRule[] | undefined;
}

const MAX_RULE_SCENARIOS = 64;

/** A tool name a rule applies to, or the fallback when the rule covers every tool. */
function toolFor(rule: PolicyRule, fallback: string): string {
  const patterns = 'toolPattern' in rule ? (Array.isArray(rule.toolPattern) ? rule.toolPattern : [rule.toolPattern]) : [];
  return patterns.find((pattern) => pattern !== '*') ?? fallback;
}

/** A concrete path that matches the pattern (wildcards become a literal segment). */
function probePath(pattern: string, projectRoot: string): string {
  const absolute = pattern.startsWith('/') ? pattern : resolve(projectRoot, pattern);
  if (!/[*?]/.test(absolute)) return `${absolute.replace(/\/+$/, '')}/probe.txt`;
  return absolute.replace(/\*+/g, 'probe').replace(/\?/g, 'x');
}

function ruleScenarios(rules: readonly PolicyRule[], projectRoot: string): PolicySimulationScenario[] {
  const scenarios: PolicySimulationScenario[] = [];
  // The candidate's rules come last in the list; probe them first, and probe a target a current rule
  // already names once, so a revised bundle's new rule is never crowded out by the rules it repeats.
  const seen = new Set<string>();
  const fresh = (kind: string, tool: string, target: string): boolean => {
    const key = `${kind}\u0000${tool}\u0000${target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  for (const rule of [...rules].reverse()) {
    if (rule.type === 'path-scope') {
      for (const pattern of rule.pathPatterns) {
        if (!fresh('path', toolFor(rule, 'write'), probePath(pattern, projectRoot))) continue;
        scenarios.push({ id: `rule-${rule.id}-path-${scenarios.length}`, label: `Rule ${rule.id}: path ${pattern}`, toolName: toolFor(rule, 'write'), args: { path: probePath(pattern, projectRoot), content: 'probe' } });
      }
    } else if (rule.type === 'network-scope') {
      for (const pattern of rule.hostPatterns) {
        const host = pattern === '*' ? 'probe.example.com' : pattern.replace(/\*+/g, 'probe');
        if (!fresh('host', toolFor(rule, 'fetch'), host)) continue;
        scenarios.push({ id: `rule-${rule.id}-host-${scenarios.length}`, label: `Rule ${rule.id}: host ${pattern}`, toolName: toolFor(rule, 'fetch'), args: { url: `https://${host}/` } });
      }
    } else if (rule.type === 'prefix') {
      for (const command of [...(rule.exactCommands ?? []), ...(rule.commandPrefixes ?? [])]) {
        if (!fresh('command', toolFor(rule, 'exec'), command)) continue;
        scenarios.push({ id: `rule-${rule.id}-command-${scenarios.length}`, label: `Rule ${rule.id}: command ${command}`, toolName: toolFor(rule, 'exec'), args: { command } });
      }
    }
    if (scenarios.length >= MAX_RULE_SCENARIOS) break;
  }
  return scenarios.slice(0, MAX_RULE_SCENARIOS);
}

/**
 * The evidence set a candidate is simulated against: eight canned calls placed under the real project
 * root, plus one probe for each path, host and command the supplied rules name, so a bundle about the
 * project's own files and commands is exercised by calls that fall inside it.
 */
export function buildDefaultPolicySimulationScenarios(source: PolicySimulationScenarioSource = {}): PolicySimulationScenario[] {
  const root = (source.projectRoot ?? '/workspace').replace(/\/+$/, '') || '/';
  const base: PolicySimulationScenario[] = [
    { id: 'read-project-file', label: 'Read project file', toolName: 'read', args: { path: `${root}/README.md` } },
    { id: 'write-project-file', label: 'Write project file', toolName: 'write', args: { path: `${root}/out.txt`, content: 'hello' } },
    { id: 'edit-config', label: 'Edit shell config', toolName: 'edit', args: { path: '/home/user/.bashrc', old_string: 'foo', new_string: 'bar' } },
    { id: 'exec-safe', label: 'Run safe shell command', toolName: 'exec', args: { command: 'git status' } },
    { id: 'exec-network', label: 'Run networked shell command', toolName: 'exec', args: { command: 'curl https://example.com' } },
    { id: 'fetch-remote', label: 'Fetch remote resource', toolName: 'fetch', args: { url: 'https://docs.example.com/reference' } },
    { id: 'spawn-agent', label: 'Delegate a worker', toolName: 'agent', args: { mode: 'spawn', task: 'Inspect repository' } },
    { id: 'mcp-docs', label: 'Call MCP docs search', toolName: 'mcp', args: { server: 'docs', tool: 'search_docs', query: 'runtime hooks' } },
  ];
  return [...base, ...ruleScenarios(source.rules ?? [], root)];
}

/**
 * Runs each scenario, plus a probe for each target the rules name, through both policy sets.
 * What each call does is read by Jev first (all scenarios in parallel), the same reading the gate makes
 * before its policy layer; a JudgmentError propagates.
 */
export async function runPolicySimulationScenarios(
  simulator: PermissionSimulator,
  scenarios: PolicySimulationScenario[] = buildDefaultPolicySimulationScenarios({ projectRoot: simulator.getPolicySources().projectRoot }),
): Promise<PolicySimulationSummary> {
  // The canned calls say little about a bundle written for this project, so the run also probes the
  // paths, hosts and commands the rules themselves name, under the real project root.
  const sources = simulator.getPolicySources();
  const probes = ruleScenarios(sources.rules, (sources.projectRoot ?? '/workspace').replace(/\/+$/, '') || '/')
    .filter((probe) => !scenarios.some((scenario) => scenario.id === probe.id));
  scenarios = [...scenarios, ...probes];
  const classifications = await Promise.all(scenarios.map((scenario) => readCallClassification(scenario.toolName, scenario.args, 'engine.gate.policy-simulation')));
  const results = await Promise.all(scenarios.map(async (scenario, index) => {
    const result = await simulator.evaluateAsync(scenario.toolName, scenario.args, classifications[index]!);
    return {
      scenario,
      actualDecision: result.actualDecision,
      simulatedDecision: result.simulatedDecision,
      authoritativeDecision: result.authoritativeDecision,
      diverged: result.diverged,
      ...(result.divergenceType !== undefined ? { divergenceType: result.divergenceType } : {}),
    };
  }));

  return {
    simulatedAt: new Date().toISOString(),
    mode: simulator.getSimulationMode(),
    totalScenarios: results.length,
    divergentScenarios: results.filter((result) => result.diverged).length,
    allowedByActual: results.filter((result) => result.actualDecision.allowed).length,
    allowedBySimulated: results.filter((result) => result.simulatedDecision.allowed).length,
    results,
  };
}
