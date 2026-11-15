/**
 * sandbox-policy.ts, the sandbox-aware INPUT to the exec permission decision.
 *
 * This is ordinary permission-layer policy, not a new enforcement path: given a
 * command and whether the per-command exec sandbox is active, it decides whether
 * a command that would otherwise prompt ("ask") under prompt mode can auto-allow
 * because it runs entirely inside the OS boundary with no host-access need, or
 * must still surface as an explicit escalation ask that NAMES what it wants
 * (network, host-privilege escalation). A consumer composes this with its existing decision machinery: when
 * the base policy would ask an exec, it consults this to see whether the sandbox
 * turns that ask into an allow.
 *
 * What host access a command needs (network, host privileges) is Jev's reading
 * (`engine.gate.sandbox-needs`, read by readCommandNeeds and passed in). The
 * catastrophic check is the gate's and the exec guard's, and stays in force
 * inside the sandbox: a boundary never buys a catastrophic command an allow.
 * This layer only ever RELAXES an ask to an allow for commands that need no
 * host access; it can never turn a deny into an allow.
 */

import { normalizeCommand, type CommandNeeds } from './normalization/index.js';
// Public clients must obtain the same reading that this policy consumes.
export { readCommandNeeds, type CommandNeeds } from './normalization/index.js';

export type SandboxPolicyEffect = 'allow' | 'ask';

export interface SandboxPolicyDecision {
  /** The resolved effect for this exec under the sandbox-aware policy. */
  readonly effect: SandboxPolicyEffect;
  /** Whether the command would run inside the boundary. */
  readonly sandboxed: boolean;
  /**
   * Named host-access needs when `effect` is 'ask' because of them (e.g.
   * "wants network"). Empty when the command is boundary-safe and auto-allowed,
   * or when the sandbox is inactive (base policy applies).
   */
  readonly escalations: string[];
  /** Human-readable justification for the decision. */
  readonly reason: string;
}

export interface SandboxPolicyInput {
  readonly command: string;
  /**
   * Whether the sandbox is genuinely active: the capability gate
   * is on, `sandbox.enabled` config is true, AND the host can provide a boundary.
   * When false, the base policy applies unchanged.
   */
  readonly sandboxActive: boolean;
  /** Command base names (or `*`) whose network access is re-enabled in the boundary; a command is covered only when every command in it is listed. */
  readonly egressAllowlist: readonly string[];
  /**
   * What the existing permission layer would decide for this exec absent the
   * sandbox (prompt mode → 'ask'). Returned unchanged when the sandbox is
   * inactive, so this policy is purely additive.
   */
  readonly baseEffectWhenNotSandboxed: SandboxPolicyEffect;
  /** What host access the command needs, read by Jev (normalization/classifier.ts readCommandNeeds). */
  readonly needs: CommandNeeds;
}

/**
 * The text inside every `$(...)` and backtick substitution in one word, wherever it sits: the whole
 * word, in the middle of a word, or inside double quotes. Single quotes keep the text literal. An
 * unclosed substitution reads to the end of the word.
 */
function embeddedSubstitutions(word: string): string[] {
  if (word.startsWith("'")) return [];
  const found: string[] = [];
  for (let i = 0; i < word.length; i++) {
    const c = word[i]!;
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      const close = word.indexOf('`', i + 1);
      found.push(word.slice(i + 1, close < 0 ? word.length : close));
      if (close < 0) break;
      i = close;
    } else if (c === '$' && word[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < word.length; j++) {
        if (word[j] === '(') depth++;
        else if (word[j] === ')' && --depth === 0) break;
      }
      found.push(word.slice(i + 2, j));
      i = j;
    }
  }
  return found;
}

/**
 * The substitutions inside the bodies of heredocs whose delimiter word is unquoted: the shell
 * expands `$(...)` and backticks there, while the tokenizer skips the body. A quoted or
 * backslashed delimiter keeps the body literal. A `<<` that is not a heredoc only adds names, which
 * errs toward asking.
 */
function heredocBodySubstitutions(text: string): string[] {
  const found: string[] = [];
  const opener = /<<(?!<)-?[ \t]*([^\s;&|<>()]+)/g;
  for (let m = opener.exec(text); m !== null; m = opener.exec(text)) {
    const delimiter = m[1]!;
    if (/['"\\]/.test(delimiter)) continue;
    const bodyStart = text.indexOf('\n', opener.lastIndex);
    if (bodyStart < 0) continue;
    const lines = text.slice(bodyStart + 1).split('\n');
    const body: string[] = [];
    for (const line of lines) {
      if (line.trim() === delimiter) break;
      body.push(line);
    }
    found.push(...embeddedSubstitutions(body.join('\n')));
  }
  return found;
}

/**
 * The base command names of a shell command, for matching the owner's egress allowlist: every
 * segment (a newline separates commands like `;`) and the commands inside `$(...)` / backtick
 * substitutions. Empty when the command could not be read.
 */
export function commandBaseNames(command: string): string[] {
  const names = new Set<string>();
  const collect = (text: string, depth: number): void => {
    const normalized = normalizeCommand(text);
    for (const seg of normalized.segments) {
      if (seg.command.length > 0) names.add(seg.command);
      if (depth >= 4) continue;
      for (const token of seg.tokens) {
        for (const inner of embeddedSubstitutions(token.value)) collect(inner, depth + 1);
      }
    }
    if (depth < 4) {
      for (const inner of heredocBodySubstitutions(text)) collect(inner, depth + 1);
    }
  };
  try {
    collect(command, 0);
  } catch {
    return [];
  }
  return [...names];
}

/**
 * The command's base names that the owner's egress allowlist does not name. Empty when the list
 * is `*` or names every command. A command too long to read in full is never fully listed.
 */
export function unlistedBaseNames(command: string, egressAllowlist: readonly string[]): string[] {
  if (egressAllowlist.includes('*')) return [];
  const names = commandBaseNames(command);
  if (names.length === 0) return ['(unreadable command)'];
  const unlisted = names.filter((name) => !egressAllowlist.includes(name));
  // `<(cmd)` and `>(cmd)` run cmd too, and the tokenizer does not read inside them.
  if (/[<>]\(/.test(command)) unlisted.push('(process substitution)');
  try {
    if (normalizeCommand(command).truncated === true) unlisted.push('(rest of a command too long to read)');
  } catch { /* unreadable: already named above */ }
  return unlisted;
}

/**
 * Whether the owner's egress allowlist covers the WHOLE command: every command in it is named (or
 * the list is `*`). The network is opened for the entire shell command, so one listed command must
 * not carry an unlisted one with it. The list is the owner's setting; matching its names against
 * the parsed command names carries out that setting and interprets nothing.
 */
export function egressAllowed(command: string, egressAllowlist: readonly string[]): boolean {
  return unlistedBaseNames(command, egressAllowlist).length === 0;
}

/** How long the owner's answer at the approval gate stays usable by the exec that follows it. */
const GATE_APPROVAL_TTL_MS = 60_000;
const gateApprovals = new Map<string, number[]>();

/**
 * Remember that the owner approved `command` at the approval gate with its host-access escalations
 * named on the card, so the exec that runs it next does not ask the same question again.
 */
export function recordGateEscalationApproval(command: string, now: number = Date.now()): void {
  const live = (gateApprovals.get(command) ?? []).filter((at) => now - at < GATE_APPROVAL_TTL_MS);
  live.push(now);
  gateApprovals.set(command, live);
  for (const [key, times] of gateApprovals) {
    if (times.every((at) => now - at >= GATE_APPROVAL_TTL_MS)) gateApprovals.delete(key);
  }
}

/** Use up one recorded gate approval for `command`. False when the owner was not asked at the gate, or the answer is too old. */
export function consumeGateEscalationApproval(command: string, now: number = Date.now()): boolean {
  const live = (gateApprovals.get(command) ?? []).filter((at) => now - at < GATE_APPROVAL_TTL_MS);
  const used = live.shift() !== undefined;
  if (live.length > 0) gateApprovals.set(command, live); else gateApprovals.delete(command);
  return used;
}

/**
 * Decide, for a single exec, whether the active sandbox turns a base "ask" into
 * an "allow", or whether the command still needs a named escalation ask.
 */
export function decideSandboxedExec(input: SandboxPolicyInput): SandboxPolicyDecision {
  if (!input.sandboxActive) {
    return {
      effect: input.baseEffectWhenNotSandboxed,
      sandboxed: false,
      escalations: [],
      reason: 'sandbox not active; base permission policy applies unchanged',
    };
  }

  if (input.needs.provenance === 'classic' || input.needs.needsNetwork === null || input.needs.needsPrivilege === null) return {
    effect: 'ask', sandboxed: true, escalations: [],
    reason: 'Classic did not assess command host-access needs; owner approval is required inside the sandbox',
  };

  const escalations: string[] = [];
  if (input.needs.needsNetwork) {
    const unlisted = unlistedBaseNames(input.command, input.egressAllowlist);
    escalations.push(
      unlisted.length === 0
        ? 'wants network (on egress allowlist, granted inside the boundary once approved)'
        : `wants network (not on egress allowlist: ${unlisted.join(', ')}; denied inside the boundary and approval does not change that; add it to sandbox.egressAllowlist)`,
    );
  }
  if (input.needs.needsPrivilege) {
    escalations.push('wants host privilege escalation (the boundary never grants it: approving lets the command run inside the boundary without root, so it fails where it needs root)');
  }

  if (escalations.length > 0) {
    return {
      effect: 'ask',
      sandboxed: true,
      escalations,
      reason: `runs inside the sandbox boundary but needs host access: ${escalations.join('; ')}`,
    };
  }

  return {
    effect: 'allow',
    sandboxed: true,
    escalations: [],
    reason: 'runs inside the sandbox boundary with no host-access need, auto-allowed',
  };
}
