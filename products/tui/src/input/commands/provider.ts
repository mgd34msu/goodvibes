/**
 * /provider-opt command handler.
 *
 * Implements the Provider Optimizer commands:
 *
 *   /provider-opt optimizer on|off  , Enable or disable the provider optimizer
 *   /provider-opt route auto|manual , Set optimizer routing mode
 *   /provider-opt explain-route     , Print current route explanation
 *   /provider-opt pin <provider:model>, Pin routing to a specific provider/model
 *   /provider-opt fallback test     , Simulate the fallback chain
 *
 * When the optimizer is disabled, commands report its status and
 * explain-route still works (reads current model capabilities).
 * Enabling the optimizer persists the change to config so it survives restart.
 */

import type { SlashCommand, CommandContext } from '../command-registry.ts';
import type { RouteExplanation } from '@goodvibes-jev/engine/platform/platform/providers';
import type { FallbackTestResult, FallbackTransition } from '@goodvibes-jev/engine/platform/platform/providers';
import type { ProviderApiModelRecord } from '@goodvibes-jev/engine/platform/platform/providers';
import { requireProviderApi } from './runtime-services.ts';
import { featureEnablementWrite } from '@goodvibes-jev/engine/terminal-shell';

const PROVIDER_OPTIMIZER_FLAG = 'provider-optimizer';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtBool(value: boolean): string {
  return value ? 'yes' : 'no';
}

function fmtTs(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}

function requireProviderOptimizer(context: CommandContext, out: string[]) {
  if (!context.provider.providerOptimizer) {
    out.push('[provider] Provider optimizer is not wired into this runtime.');
    return null;
  }
  return context.provider.providerOptimizer;
}

function fmtExplanation(expl: RouteExplanation, out: string[]): void {
  const status = expl.accepted ? '[accepted]' : '[rejected]';
  out.push(`  ${status} ${expl.providerId}/${expl.modelId}`);
  out.push(`    ${expl.summary}`);
  if (!expl.accepted && expl.rejections.length > 0) {
    out.push('    Unmet requirements:');
    for (const r of expl.rejections) {
      out.push(
        `      - ${r.code}: ${r.reason} (actual=${r.actual}, required=${r.required})`,
      );
    }
  }
  if (expl.accepted) {
    const c = expl.capability;
    out.push(
      `    Capabilities: streaming=${fmtBool(c.streaming)}, tools=${fmtBool(c.toolCalling)}, ` +
      `parallel=${fmtBool(c.parallelTools)}, json=${fmtBool(c.jsonMode)}, ` +
      `reasoning=${fmtBool(c.reasoningControls)}`,
    );
    out.push(
      `    Context=${c.maxContextTokens.toLocaleString()} tokens, ` +
      `output=${c.maxOutputTokens.toLocaleString()} tokens, ` +
      `timeout=${c.timeoutMs}ms, caching=${c.caching}`,
    );
  }
}

// ---------------------------------------------------------------------------
// /provider-opt optimizer on|off
// ---------------------------------------------------------------------------

function handleOptimizerToggle(
  args: string[],
  context: CommandContext,
  out: string[],
): void {
  const optimizer = requireProviderOptimizer(context, out);
  if (!optimizer) return;
  const sub = args[0];

  if (sub !== 'on' && sub !== 'off') {
    out.push('[provider] Usage: /provider-opt optimizer on|off');
    out.push(`  Current state: optimizer is ${optimizer.enabled ? 'enabled' : 'disabled'}`);
    out.push('  "on"  — activates intelligent failover and auto-routing');
    out.push('  "off" — disables optimizer; provider selection is manual only');
    return;
  }

  const enable = sub === 'on';
  const wasEnabled = optimizer.enabled;

  // provider.optimizerMode owns the optimizer's state (off = disabled;
  // manual/auto/pinned = active); the provider stack applies the write to the
  // live optimizer, and it survives restart.
  const write = featureEnablementWrite(PROVIDER_OPTIMIZER_FLAG, enable);
  if (write && enable !== wasEnabled) context.platform.configManager.setDynamic(write.key, write.value);

  if (enable && !wasEnabled) {
    out.push('[provider] Optimizer enabled.');
    out.push('  Intelligent failover is now active: on a request error the optimizer');
    out.push('  will attempt the next viable provider and surface a transcript notice');
    out.push('  naming the from→to transition and reason before retrying.');
    out.push('  Use "/provider-opt route auto" to enable fully automatic routing.');
  } else if (!enable && wasEnabled) {
    out.push('[provider] Optimizer disabled.');
    out.push('  Provider selection returns to manual-only mode. No automatic failover.');
    out.push('  Pinned targets and fallback log are preserved; re-enable to resume.');
  } else {
    out.push(`[provider] Optimizer already ${enable ? 'enabled' : 'disabled'}; no change.`);
  }
}

// ---------------------------------------------------------------------------
// /provider-opt route auto|manual
// ---------------------------------------------------------------------------

function handleRoute(
  args: string[],
  context: CommandContext,
  out: string[],
): void {
  const optimizer = requireProviderOptimizer(context, out);
  if (!optimizer) return;
  const sub = args[0];

  if (sub !== 'auto' && sub !== 'manual') {
    out.push('[provider] Usage: /provider-opt route auto|manual');
    out.push(`  Current mode: ${optimizer.mode} (optimizer ${optimizer.enabled ? 'on' : 'off'})`);
    return;
  }

  const wasEnabled = optimizer.enabled;
  // provider.optimizerMode owns the mode; the provider stack applies the write
  // to the live optimizer. A routing mode is an active optimizer, so choosing
  // one while it is off turns it on.
  context.platform.configManager.setDynamic('provider.optimizerMode', sub);
  out.push(`[provider] Routing mode → ${optimizer.mode} (saved: survives restart)`);
  if (!wasEnabled && optimizer.enabled) out.push('  The optimizer was off and is now on. Turn it off with: /provider-opt optimizer off');

  if (sub === 'auto') {
    out.push(
      '  Auto mode: optimizer selects the best capable provider for each request profile.',
    );
  } else {
    out.push(
      '  Manual mode: optimizer is advisory only; provider selection is caller-driven.',
    );
  }
}

// ---------------------------------------------------------------------------
// /provider-opt explain-route
// ---------------------------------------------------------------------------

async function handleExplainRoute(
  _args: string[],
  context: CommandContext,
  out: string[],
): Promise<void> {
  const optimizer = requireProviderOptimizer(context, out);
  if (!optimizer) return;
  const providerApi = requireProviderApi(context);

  let currentModel: ProviderApiModelRecord;
  try {
    currentModel = await providerApi.getCurrentModel();
  } catch {
    out.push('[provider] No current model selected.');
    return;
  }

  out.push(
    `[provider] Route explanation for current model: ${currentModel.providerId}/${currentModel.modelId}`,
  );

  // Always explain current route regardless of optimizer enabled state
  const expl = optimizer.explainCurrentRoute();
  fmtExplanation(expl, out);

  // Show optimizer status
  out.push(`
  Optimizer: ${optimizer.enabled ? 'enabled' : 'disabled'}, mode=${optimizer.mode}`);
  if (optimizer.pinnedTarget) {
    out.push(
      `  Pinned to: ${optimizer.pinnedTarget.providerId}/${optimizer.pinnedTarget.modelId}`,
    );
  }

  // Show recent fallback transitions
  const log = optimizer.fallbackLog;
  if (log.length > 0) {
    const recent = log.slice(-5); // last 5 transitions
    out.push(`  Fallback log (last ${recent.length} of ${log.length}):`);
    for (const t of recent) {
      out.push(
        `    ${fmtTs(t.ts)}  ${t.from} → ${t.to}  (${t.reason})`,
      );
    }
  } else {
    out.push('  Fallback log: empty');
  }
}

// ---------------------------------------------------------------------------
// /provider-opt pin <provider:model>
// ---------------------------------------------------------------------------

async function handlePin(
  args: string[],
  context: CommandContext,
  out: string[],
): Promise<void> {
  const optimizer = requireProviderOptimizer(context, out);
  if (!optimizer) return;
  const target = args[0];

  if (!target) {
    // Show current pin status
    if (optimizer.pinnedTarget) {
      out.push(
        `[provider] Currently pinned to: ${optimizer.pinnedTarget.providerId}/${optimizer.pinnedTarget.modelId}`,
      );
      out.push('  Use "/provider-opt pin <provider:model>" to change, or "/provider-opt route manual" to unpin.');
    } else {
      out.push('[provider] No pin active. Usage: /provider-opt pin <provider:model>');
      out.push('  Example: /provider-opt pin anthropic:claude-opus-4-5');
    }
    return;
  }

  // Parse provider:model format
  const colonIdx = target.indexOf(':');
  if (colonIdx === -1) {
    out.push(`[provider] Invalid format "${target}". Expected: <provider>:<model>`);
    out.push('  Example: /provider-opt pin anthropic:claude-opus-4-5');
    return;
  }

  const providerId = target.slice(0, colonIdx);
  const modelId = target.slice(colonIdx + 1);

  if (!providerId || !modelId) {
    out.push(`[provider] Invalid format "${target}". Both provider and model must be non-empty.`);
    return;
  }

  // Validate that the model exists in registry
  const providerApi = requireProviderApi(context);
  const models = await providerApi.listModels();
  const currentModel = await providerApi.getCurrentModel();
  const match = models.find(
    (m) => m.providerId === providerId && (m.modelId === modelId || m.registryKey === target),
  ) ?? (
    currentModel.providerId === providerId
      && (currentModel.modelId === modelId || currentModel.registryKey === target)
      ? currentModel
      : undefined
  );

  if (!match) {
    out.push(
      `[provider] Model not found in registry: ${providerId}/${modelId}`,
    );
    out.push('  Use "/model" to see available models, or check the provider and model ID.');
    return;
  }

  // Pinned mode is an active optimizer, so pinning while it is off turns it on.
  if (!optimizer.enabled) {
    out.push('⚠ Optimizer was disabled: enabling it for pin to take effect (saved: stays on after restart).');
  }

  // The settings own the pin; the provider stack applies them to the live optimizer.
  context.platform.configManager.setDynamic('provider.optimizerPinnedModel', `${match.providerId}:${match.modelId}`);
  context.platform.configManager.setDynamic('provider.optimizerMode', 'pinned');
  out.push(`[provider] Pinned → ${match.providerId}/${match.modelId} (saved: survives restart)`);
  out.push('  All routed requests will target this provider/model.');
  out.push('  Unpin with: /provider-opt route manual');
}

// ---------------------------------------------------------------------------
// /provider-opt fallback test
// ---------------------------------------------------------------------------

function handleFallbackTest(
  args: string[],
  context: CommandContext,
  out: string[],
): void {
  const optimizer = requireProviderOptimizer(context, out);
  if (!optimizer) return;
  const sub = args[0];

  if (sub !== 'test') {
    out.push('[provider] Usage: /provider-opt fallback test');
    return;
  }

  out.push('[provider] Simulating fallback chain (empty request profile; no requirements)...');

  const result: FallbackTestResult = optimizer.testFallback();

  out.push(
    `[provider] Fallback chain: ${result.viableCount} capable / ${result.totalCount} total providers`,
  );

  // Show first capable then rejected
  const capable = result.chain.filter((n) => n.capable);
  const rejected = result.chain.filter((n) => !n.capable);

  if (capable.length > 0) {
    out.push('  Capable providers (would succeed):');
    for (const node of capable.slice(0, 10)) {
      out.push(`    [${node.position}] ${node.providerId}/${node.modelId}`);
    }
    if (capable.length > 10) {
      out.push(`    ... and ${capable.length - 10} more`);
    }
  } else {
    out.push('  No capable providers found for this profile.');
  }

  if (rejected.length > 0) {
    out.push(`  Rejected providers (${rejected.length}):`);
    for (const node of rejected.slice(0, 5)) {
      const reasons = !node.explanation.accepted
        ? node.explanation.rejections.map((r) => r.code).join(', ')
        : '';
      out.push(
        `    [${node.position}] ${node.providerId}/${node.modelId}: ${reasons || 'unknown'}`,
      );
    }
    if (rejected.length > 5) {
      out.push(`    ... and ${rejected.length - 5} more`);
    }
  }

  // Show fallback log
  const log = optimizer.fallbackLog;
  if (log.length > 0) {
    out.push(`  Logged transitions (${log.length} total):`);
    const recent: readonly FallbackTransition[] = log.slice(-5);
    for (const t of recent) {
      out.push(
        `    ${fmtTs(t.ts)}  ${t.from} → ${t.to}  (${t.reason})`,
      );
    }
  } else {
    out.push('  No fallback transitions logged this session.');
  }

  out.push(`  Test completed at: ${fmtTs(result.testedAt)}`);
}

// ---------------------------------------------------------------------------
// Top-level command definition
// ---------------------------------------------------------------------------

/**
 * providerCommand, The `/provider-opt` slash command.
 *
 * Routes to subcommand handlers based on args[0].
 */
export const providerCommand: SlashCommand = {
  name: 'provider-opt',
  aliases: ['prov-opt'],
  description: 'Manage provider routing optimizer (route, pin, explain, fallback)',
  usage: '<subcommand> [args]',
  argsHint: 'optimizer|route|explain-route|pin|fallback',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const [sub, ...rest] = args;
    // One report is one printed block, so it is one notice and one saved message.
    const out: string[] = [];
    try {
      await runProviderOptCommand(sub, rest, context, out);
    } finally {
      if (out.length > 0) context.print(out.join('\n'));
    }
  },
};

async function runProviderOptCommand(sub: string | undefined, rest: string[], context: CommandContext, out: string[]): Promise<void> {
  switch (sub) {
    case 'optimizer':
      handleOptimizerToggle(rest, context, out);
      break;

    case 'route':
      handleRoute(rest, context, out);
      break;

    case 'explain-route':
    case 'explain':
      await handleExplainRoute(rest, context, out);
      break;

    case 'pin':
      await handlePin(rest, context, out);
      break;

    case 'fallback':
      handleFallbackTest(rest, context, out);
      break;

    default: {
      const optimizer = requireProviderOptimizer(context, out);
      if (!optimizer) return;
      const lines = [
        'Usage: /provider-opt <subcommand>',
        '  optimizer on|off               — Enable or disable the provider optimizer',
        '  route auto|manual              — Set optimizer routing mode',
        '  explain-route                  — Show current route explanation',
        '  pin <provider:model>           — Pin routing to specific provider/model',
        '  fallback test                  — Simulate the full fallback chain',
        '',
        `  Optimizer: ${optimizer.enabled ? 'enabled' : 'disabled'}  mode=${optimizer.mode}`,
      ];
      if (optimizer.pinnedTarget) {
        lines.push(`  Pinned: ${optimizer.pinnedTarget.providerId}/${optimizer.pinnedTarget.modelId}`);
      }
      out.push(...lines);
      break;
    }
  }
}
