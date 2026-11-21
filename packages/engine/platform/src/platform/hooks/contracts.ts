import { matchesEventPath, patternsOverlap } from './matcher.js';
import type { HookCategory, HookEventPath, HookPattern, HookPhase } from './types.js';

export type HookExecutionMode = 'blocking' | 'non_blocking' | 'background';
export type HookAuthority = 'intercept' | 'observe' | 'defer' | 'chain';

export interface HookPointContract {
  pattern: HookPattern;
  description: string;
  authority: HookAuthority;
  executionMode: HookExecutionMode;
  canDeny: boolean;
  canMutateInput: boolean;
  canInjectContext: boolean;
  failurePolicy: 'fail_open' | 'fail_closed' | 'log_only';
}

const CONTRACTS: HookPointContract[] = [
  {
    pattern: 'Pre:tool:*',
    description: 'Intercept a tool call before admission, in every permission mode (yolo included) and for a tool run inside another tool: deny it (`decision: "deny"`), put it to the owner (`decision: "ask"`, with `reason` shown to him; held for him in just-vibes), rewrite its arguments (`updatedInput`), or add a note the model reads with its result (`additionalContext`). `decision: "allow"` has no effect: the gate still decides. A hook that fails (error, timeout, non-zero exit) refuses the call.',
    authority: 'intercept',
    executionMode: 'blocking',
    canDeny: true,
    canMutateInput: true,
    canInjectContext: true,
    failurePolicy: 'fail_closed',
  },
  {
    pattern: 'Post:tool:*',
    description: 'Observe a successful tool execution. Runs beside the turn; the next call does not wait for it.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Fail:tool:*',
    description: 'Observe a failed tool execution. Runs beside the turn; the next call does not wait for it.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Post:file:*',
    description: 'Observe file mutations or file-oriented tool success. Runs beside the turn; the next call does not wait for it.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Fail:file:*',
    description: 'Observe file-related failures. Runs beside the turn; the next call does not wait for it.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Pre:git:*',
    description: 'Intercept a git commit, push, pull, merge, checkout, stash or worktree change that GoodVibes itself makes (its own git service), before it runs. A git command the model runs through the exec tool raises Pre:tool:exec instead.',
    authority: 'intercept',
    executionMode: 'blocking',
    canDeny: true,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'fail_open',
  },
  {
    pattern: 'Post:git:*',
    description: 'Observe a successful git commit, push, pull, merge, checkout, stash or worktree change.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Fail:git:*',
    description: 'Observe a failed git operation.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Pre:llm:chat',
    description: 'Intercept outbound LLM chat requests.',
    authority: 'intercept',
    executionMode: 'blocking',
    canDeny: true,
    canMutateInput: false,
    canInjectContext: true,
    failurePolicy: 'fail_open',
  },
  {
    pattern: 'Post:llm:chat',
    description: 'Observe successful LLM responses.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Fail:llm:chat',
    description: 'Observe failed LLM requests.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Pre:mcp:call',
    description: 'Intercept an MCP tool call before invocation.',
    authority: 'intercept',
    executionMode: 'blocking',
    canDeny: true,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'fail_open',
  },
  {
    pattern: 'Post:mcp:call',
    description: 'Observe a successful MCP tool call.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Fail:mcp:call',
    description: 'Observe a failed MCP tool call.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Pre:compact:*',
    description: 'Intercept compaction before it mutates runtime context.',
    authority: 'intercept',
    executionMode: 'blocking',
    canDeny: true,
    canMutateInput: false,
    canInjectContext: true,
    failurePolicy: 'fail_open',
  },
  {
    pattern: 'Post:compact:*',
    description: 'Observe successful compaction.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Fail:compact:*',
    description: 'Observe compaction failures.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Lifecycle:session:*',
    description: 'Observe session lifecycle changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Lifecycle:agent:*',
    description: 'Observe agent lifecycle changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Lifecycle:contract:*',
    description: 'Observe contract lifecycle changes: created, planned, checked, nudged, escalated, passed, failed, cancelled.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Lifecycle:communication:*',
    description: 'Observe structured communication delivery and blocked-route lifecycle changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Change:contract:*',
    description: 'Observe the spawn guard refusing an agent spawn (recursion limits, a unit trying to spawn).',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Change:communication:*',
    description: 'Observe communication routing changes, policy blocks, and message flow anomalies.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Pre:permission:request',
    description: 'Observe a permission escalation before the shell prompt resolves it.',
    authority: 'observe',
    executionMode: 'blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'fail_open',
  },
  {
    pattern: 'Post:permission:decision',
    description: 'Observe the final permission decision for a tool or transport action.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Fail:permission:request',
    description: 'Observe permission prompt failures and resolution errors.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Lifecycle:mcp:*',
    description: 'Observe MCP server lifecycle changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Lifecycle:transport:*',
    description: 'Observe ACP, daemon, and remote transport lifecycle changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Change:config:*',
    description: 'Observe configuration changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Change:file:*',
    description: 'Observe project files changed outside the write and edit tools (Change:file:external; payload filePath and change: changed or deleted).',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Change:budget:*',
    description: 'Observe budget threshold changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'log_only',
  },
  {
    pattern: '*:webhook:*',
    description: 'Answer a webhook delivered to the daemon; the phase and event name come from the sender, and the decision, reason and error go back in the reply.',
    authority: 'intercept',
    executionMode: 'blocking',
    canDeny: true,
    canMutateInput: false,
    canInjectContext: false,
    failurePolicy: 'fail_open',
  },
];

function specificityScore(pattern: string): number {
  return pattern.split(':').reduce((score, segment) => score + (segment === '*' ? 0 : 1), 0);
}

export function listHookPointContracts(): HookPointContract[] {
  return [...CONTRACTS];
}

export function getHookPointContract(path: HookEventPath): HookPointContract | null {
  let best: HookPointContract | null = null;
  let bestScore = -1;
  for (const contract of CONTRACTS) {
    if (!matchesEventPath(contract.pattern, path)) continue;
    const score = specificityScore(contract.pattern);
    if (score > bestScore) {
      best = contract;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Whether the caller waits for the hooks at this point: only `blocking` points
 * hold the work they guard. A point with no contract waits when it is a Pre point.
 */
export function hookPointBlocks(path: HookEventPath): boolean {
  const contract = getHookPointContract(path);
  return contract ? contract.executionMode === 'blocking' : path.startsWith('Pre:');
}

/**
 * Why a hooks-file key can never fire, or null when it can: it must be
 * Phase:Category:Specific and overlap at least one registered hook point.
 * Segments compare exactly, so `pre:tool:exec` is refused rather than kept
 * as a hook that never runs.
 */
export function hookPatternProblem(pattern: string): string | null {
  if (pattern.split(':').length !== 3) {
    return `"${pattern}" is not a recognized hook event point: a key has exactly three parts, Phase:Category:Specific`;
  }
  if (CONTRACTS.some((contract) => patternsOverlap(pattern, contract.pattern))) return null;
  return `"${pattern}" is not a recognized hook event point: no registered hook point matches it (phases are Pre, Post, Fail, Change and Lifecycle, and case matters); /hooks contracts lists them`;
}

/**
 * Whether a hooks-file key reaches a point that waits for its hooks to deny,
 * ask or rewrite the call. A background (`async`) hook's answer is never read,
 * so it cannot guard such a point.
 */
export function patternReachesDecisionPoint(pattern: string): boolean {
  return CONTRACTS.some((contract) => contract.executionMode === 'blocking'
    && (contract.canDeny || contract.canMutateInput)
    && patternsOverlap(pattern, contract.pattern));
}

export function parseHookPath(path: HookEventPath): {
  phase: HookPhase;
  category: HookCategory;
  specific: string;
} {
  const [phase, category, ...specificParts] = path.split(':');
  return {
    phase: phase as HookPhase,
    category: category as HookCategory,
    specific: specificParts.join(':'),
  };
}
