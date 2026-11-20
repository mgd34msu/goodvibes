/**
 * The request analysis every gate decision carries: what the call targets and
 * what it does, for the approval card, hooks and events.
 *
 * The structural parts are code: the target, its kind, the surface, the host
 * and the shell parser's command class and catastrophic findings. The risk
 * level, risk family, side effects and blast radius come from Jev's reading
 * of the call (gate/reading.ts) and are attached with withReading. Before a
 * reading exists (a known read-only tool, or a call an explicit owner rule or
 * the boundary decided first) the level is fixed by category: low for a
 * read-only tool, high for anything unread.
 *
 * The old secret-name and token-shape regexes over command text, the
 * sensitive-path regex and the if/else chains that picked a risk band from
 * the command class and host trust tier are gone; the side-effect and
 * risk-family batteries answer those questions.
 */
import { normalizeCommandWithVerdicts } from '../runtime/permissions/normalization/index.js';
import { extractHostname } from '../tools/fetch/trust-tiers.js';
import { RISK_HEADLINES } from '../runtime/permissions/risk-model.js';
import type { GateReading } from '../gate/reading.js';
import { permissionSubject, type PermissionSubject } from './subject.js';
import type {
  PermissionBlastRadius,
  PermissionCategory,
  PermissionRequestAnalysis,
} from './types.js';

function cleanReasons(values: readonly string[], limit = 4): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) deduped.add(trimmed);
    if (deduped.size >= limit) break;
  }
  return Array.from(deduped);
}

/** The risk level before any reading: fixed by category. */
const unreadRisk = (category: PermissionCategory): PermissionRequestAnalysis['riskLevel'] => (category === 'read' ? 'low' : 'high');

/** The subject as the analysis carries it: every value, one per line, for a tool with a known subject. */
const targetOf = (subject: PermissionSubject): string | undefined => (subject.kind === 'generic' ? undefined : subject.values.join('\n'));

function describeExec(subject: PermissionSubject, category: PermissionCategory): PermissionRequestAnalysis {
  const commands = subject.kind === 'command' ? subject.values : [];
  const verdicts = commands.map((command) => normalizeCommandWithVerdicts(command));
  return {
    classification: commands.length > 0 ? 'shell' : 'write',
    riskLevel: unreadRisk(category),
    summary: commands.length > 1 ? `Execute ${commands.length} shell commands` : 'Execute shell command',
    reasons: commands.length > 0
      ? cleanReasons(verdicts.flatMap((verdict) => [
        verdict.denialExplanation ?? '',
        ...verdict.segments.filter((segment) => !segment.allowed).map((segment) => segment.reason),
      ]))
      : ['Shell execution can mutate files, spawn processes, or access the network.'],
    target: targetOf(subject) ?? '',
    targetKind: 'command',
    surface: 'shell',
  };
}

function describeFetch(subject: PermissionSubject, category: PermissionCategory): PermissionRequestAnalysis {
  const urls = subject.kind === 'url' ? subject.values : [];
  const hosts = [...new Set(urls.flatMap((url) => extractHostname(url) ?? []))];
  return {
    classification: 'network',
    riskLevel: unreadRisk(category),
    summary: hosts.length > 0 ? `Fetch remote resource from ${hosts.join(', ')}` : 'Fetch remote resource',
    reasons: hosts.length > 0 ? [`Target host${hosts.length > 1 ? 's' : ''}: ${hosts.join(', ')}`] : [],
    target: targetOf(subject) ?? '',
    targetKind: 'url',
    surface: 'network',
    host: hosts[0],
  };
}

function describePathTool(toolName: string, subject: PermissionSubject, category: PermissionCategory): PermissionRequestAnalysis {
  return {
    classification: category === 'write' ? 'write' : 'read',
    riskLevel: unreadRisk(category),
    summary: category === 'write' ? `Modify local file or project state via ${toolName}` : `Read local project state via ${toolName}`,
    reasons: [],
    target: targetOf(subject),
    targetKind: subject.kind === 'generic' ? 'path' : subject.kind,
    surface: 'filesystem',
  };
}

function describeDelegate(toolName: string, subject: PermissionSubject, category: PermissionCategory): PermissionRequestAnalysis {
  return {
    classification: 'escalation',
    riskLevel: unreadRisk(category),
    summary: `Delegate work through ${toolName}`,
    reasons: [],
    target: targetOf(subject),
    targetKind: 'task',
    surface: 'orchestration',
  };
}

/** The structural analysis of a call, before any reading. */
export function analyzePermissionRequest(
  toolName: string,
  args: Record<string, unknown>,
  category: PermissionCategory,
): PermissionRequestAnalysis {
  const subject = permissionSubject(toolName, args);
  if (toolName === 'exec') return describeExec(subject, category);
  if (toolName === 'fetch') return describeFetch(subject, category);
  if (category === 'write' || category === 'read') return describePathTool(toolName, subject, category);
  if (category === 'delegate') return describeDelegate(toolName, subject, category);
  return {
    classification: category,
    riskLevel: unreadRisk(category),
    summary: `Request permission for ${toolName}`,
    reasons: [],
    target: targetOf(subject),
    targetKind: subject.kind,
    surface: 'shell',
  };
}

const FACT_WORDING = {
  mutates: 'changes state',
  outward: 'reaches outside this machine',
  secrets: 'touches secret or credential material',
  irreversible: 'is hard to undo',
  beyondProject: 'reaches beyond the project',
  weakensSecurity: 'loosens a security boundary',
  obfuscated: 'is written to hide what it does',
} as const;

function blastRadiusOf(reading: GateReading, category: PermissionCategory): PermissionBlastRadius {
  if (reading.weakensSecurity || reading.secrets) return 'platform';
  if (reading.outward || reading.beyondProject) return category === 'delegate' ? 'delegated' : 'external';
  if (category === 'delegate') return 'delegated';
  return reading.mutates ? 'project' : 'local';
}

/** The analysis with Jev's reading attached: risk level, family, side effects and blast radius. */
export function withReading(analysis: PermissionRequestAnalysis, reading: GateReading, category: PermissionCategory): PermissionRequestAnalysis {
  const facts = (Object.keys(FACT_WORDING) as (keyof typeof FACT_WORDING)[]).filter((name) => reading[name]);
  const uncertain = reading.uncertain.length > 0 ? [`Uncertain, taken as true: ${reading.uncertain.map((name) => FACT_WORDING[name]).join(', ')}.`] : [];
  return {
    ...analysis,
    riskLevel: reading.stakes,
    riskFamily: reading.family,
    reasons: cleanReasons([
      `${RISK_HEADLINES[reading.family]}: ${reading.stakes} stakes.`,
      facts.length > 0 ? `This call ${facts.map((name) => FACT_WORDING[name]).join(', ')}.` : 'This call changes nothing and stays on this machine.',
      ...uncertain,
      ...analysis.reasons,
    ], 5),
    sideEffects: facts.map((name) => FACT_WORDING[name]),
    blastRadius: blastRadiusOf(reading, category),
    reading: {
      family: reading.family,
      stakes: reading.stakes,
      facts: { mutates: reading.mutates, outward: reading.outward, secrets: reading.secrets, irreversible: reading.irreversible,
        beyondProject: reading.beyondProject, weakensSecurity: reading.weakensSecurity, obfuscated: reading.obfuscated },
      uncertain: [...reading.uncertain],
    },
  };
}
