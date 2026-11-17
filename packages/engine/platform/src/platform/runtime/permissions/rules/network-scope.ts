/**
 * Network scope (host/URL) policy rule evaluator with host trust tier classification.
 *
 * NetworkScopeRule matches tool calls that make network requests, restricting
 * or allowing access based on whether the target hostname matches any of the
 * specified host patterns. Supports glob wildcards. Independently testable.
 */

import type {
  NetworkScopeRule,
  EvaluationStep,
} from '../types.js';
import {
  classifyHostTrustTier,
  extractHostname,
  type HostTrustTier,
  type TrustTierConfig,
} from '../../../tools/fetch/trust-tiers.js';
import { hostMatchesGlob } from '../../../tools/fetch/host-utils.js';

/**
 * Re-export host trust tier types from the network scope module for
 * consumers that access trust classification via the permissions layer.
 *
 * The policy panel uses these exports to show host trust classification
 * alongside permission decisions.
 */
export type { HostTrustTier, TrustTierConfig };
export { classifyHostTrustTier, extractHostname };

/** Result returned by evaluateNetworkScopeRule. */
export interface NetworkScopeRuleResult {
  matched: boolean;
  step: EvaluationStep;
}

/**
 * toolMatchesNetworkPattern, Returns true if `toolName` matches the rule's toolPattern.
 */
function toolMatchesNetworkPattern(
  toolName: string,
  toolPattern: string | string[],
): boolean {
  if (Array.isArray(toolPattern)) {
    return toolPattern.some((p) => p === '*' || p === toolName);
  }
  return toolPattern === '*' || toolPattern === toolName;
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443, 'ftp:': 21,
};

/**
 * One host the call would reach, with the port in effect: the explicit one, or
 * the scheme's default so a `ports` restriction also holds for `https://host/`.
 */
function parseHostTarget(raw: string): { host: string; port: number | null } | null {
  // The URL parser is the authority on what reads as a scheme: it also accepts `http:evil.com`, `https:/evil.com`
  // and `http:\\evil.com` as host evil.com, so try the text as written before treating it as a bare host.
  try {
    let parsed: URL | null = null;
    try {
      const direct = new URL(raw.trim());
      if (direct.hostname !== '') parsed = direct;
    } catch { /* no scheme: fall through to a bare host */ }
    parsed ??= new URL(`https://${raw}`);
    const port = parsed.port ? parseInt(parsed.port, 10) : (DEFAULT_PORTS[parsed.protocol] ?? null);
    return { host: parsed.hostname, port };
  } catch {
    // Not a valid URL, validate it looks like a hostname before using it
    // Reject strings with spaces or exceeding max hostname length (RFC 1035: 253 chars)
    if (raw.includes(' ') || raw.length > 253 || raw.length === 0) return null;
    return { host: raw, port: null };
  }
}

/**
 * extractHostTargets, Extracts every hostname (and port) the call names.
 *
 * Checks `url`, `endpoint`, `uri`, `href`, `host` and `hostname`, and the `url`
 * of each entry of a `urls` list (the fetch tool's shape); every one that is
 * present is returned so a rule cannot be sidestepped by naming a second field.
 * A tool that declares where its hosts sit is read from that declaration instead.
 */
function extractHostTargets(args: Record<string, unknown>): Array<{ host: string; port: number | null }> {
  const targets: Array<{ host: string; port: number | null }> = [];
  const urls = Array.isArray(args['urls'])
    ? args['urls'].map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['url'] : entry))
    : [];
  for (const raw of [...['url', 'endpoint', 'uri', 'href'].map((key) => args[key]), ...urls]) {
    if (typeof raw !== 'string') continue;
    const target = parseHostTarget(raw);
    if (target !== null) targets.push(target);
  }
  for (const key of ['host', 'hostname']) {
    if (typeof args[key] === 'string') targets.push({ host: args[key] as string, port: null });
  }
  return targets;
}

/**
 * evaluateNetworkScopeRule, Evaluates a single NetworkScopeRule against a tool call.
 *
 * Returns `matched: true` when:
 *   1. The tool name matches the rule's `toolPattern`, AND
 *   2. A network host is found in the args, AND
 *   3. The hostname matches at least one of the rule's `hostPatterns`, AND
 *   4. If `ports` is specified, the request port is in the allowed set.
 *
 * @param rule     - The NetworkScopeRule to evaluate.
 * @param toolName - Name of the tool being called.
 * @param args     - Arguments passed to the tool.
 */
export function evaluateNetworkScopeRule(
  rule: NetworkScopeRule,
  toolName: string,
  args: Record<string, unknown>,
  /** The URLs or hosts the tool declares this call reaches; read in place of probing argument names. */
  declaredHosts?: readonly string[],
): NetworkScopeRuleResult {
  const toolMatches = toolMatchesNetworkPattern(toolName, rule.toolPattern);

  if (!toolMatches) {
    return {
      matched: false,
      step: {
        layer: 'policy',
        check: `network-scope-rule:${rule.id}`,
        matched: false,
        detail: `tool "${toolName}" does not match pattern "${rule.toolPattern}"`,
      },
    };
  }

  const targets = declaredHosts
    ? declaredHosts.map(parseHostTarget).filter((target): target is { host: string; port: number | null } => target !== null)
    : extractHostTargets(args);
  if (targets.length === 0) {
    // A deny that names this tool, or a tool that declares where its hosts sit,
    // cannot be checked when no host can be read: the call is refused rather
    // than decided as if the rule did not exist.
    const unreadable = rule.effect !== 'allow' && (declaredHosts !== undefined
      || (Array.isArray(rule.toolPattern) ? rule.toolPattern.includes(toolName) : rule.toolPattern === toolName));
    return {
      matched: unreadable,
      step: {
        layer: 'policy',
        check: `network-scope-rule:${rule.id}`,
        matched: unreadable,
        detail: unreadable
          ? `no host could be read from this call, so the ${rule.effect} rule cannot be checked and applies`
          : 'no network host/URL argument found in args',
      },
    };
  }

  const check = `network-scope-rule:${rule.id}`;
  const outcomes = targets.map(({ host, port }) => {
    if (rule.ports !== undefined && rule.ports.length > 0 && port !== null) {
      const portAllowed = rule.ports.includes(0) || rule.ports.includes(port);
      if (!portAllowed) {
        return { matched: false, detail: `port ${port} not in allowed ports [${rule.ports.join(', ')}]` };
      }
    }
    const matchedPattern = rule.hostPatterns.find((p) => hostMatchesGlob(host, p));
    return matchedPattern !== undefined
      ? { matched: true, detail: `host "${host}" matched pattern "${matchedPattern}"` }
      : { matched: false, detail: `host "${host}" did not match any of [${rule.hostPatterns.join(', ')}]` };
  });
  // Same batch semantics as command rules: a deny matches when ANY named host does,
  // an allow only when EVERY named host does.
  const decisive = rule.effect !== 'allow'
    ? (outcomes.find((o) => o.matched) ?? outcomes[0]!)
    : (outcomes.find((o) => !o.matched) ?? outcomes[0]!);
  return { matched: decisive.matched, step: { layer: 'policy', check, matched: decisive.matched, detail: decisive.detail } };
}
