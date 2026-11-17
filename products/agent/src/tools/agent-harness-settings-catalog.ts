import { getAgentSettingsSchema, type AgentSettingsCatalog } from '../config/settings-catalog.ts';
import { catalogRoutingInput } from './agent-harness-catalog-ingress.ts';
import { isAgentWorkspaceSettingsImportPreview } from './agent-settings-import-admission.ts';
import type { CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { listEffectiveHarnessSettingsPage } from '../agent/harness-control.ts';
import { settingDomainRelatedCommand } from '../config/settings-search-vocabulary.ts';
import { settingsPolicySummary } from './agent-harness-metadata.ts';
import { CATALOG_QUERIES } from './agent-harness-catalog-filters.ts';
import { catalogEnvelope, catalogFilters, readLimit, readString } from './agent-harness-tool-utils.ts';
import type { AgentHarnessToolArgs } from './agent-harness-tool-types.ts';

/** Exact catalog identities do not require semantic source projection. */
export function isHarnessSettingsQuery(input: Record<string, unknown>, config?: AgentSettingsCatalog): boolean {
  const args = catalogRoutingInput(input);
  if (args.mode === 'run_workspace_action') return isAgentWorkspaceSettingsImportPreview(input);
  if (args.mode === 'settings') return typeof args.query === 'string' && args.query.trim().length > 0;
  if (args.mode !== 'get_setting') return false;
  const value = [args.key, args.target, args.query].find(item => typeof item === 'string' && item.trim());
  if (typeof value !== 'string') return false;
  return !config || !getAgentSettingsSchema(config).some(setting => setting.key.toLowerCase() === value.trim().toLowerCase());
}

/**
 * The `settings` catalog page, with the count of what matched beside it.
 *
 * There is no page ceiling: a page that stopped at one was indistinguishable
 * from the complete catalog, so a real setting past the cut read as a setting
 * that does not exist. The page goes out through {@link catalogEnvelope}, which
 * states in words when it is short of `total` and how to ask for the rest.
 *
 * `total` is the size of the catalog the filters name, NOT the number that
 * matched the query. It used to be the latter, which is how a search for
 * "spending limit" answered `{"settings": [], "returned": 0, "total": 0}`, a
 * page that says zero settings exist, from a schema holding 572 of them, 32 of
 * them about payments. `returned` says how many matched; `total` says how many
 * there are; the envelope's own sentence says which filter emptied the page.
 */
export async function harnessSettingsCatalog(
  configManager: ConfigManager,
  args: AgentHarnessToolArgs,
  options: CatalogRankingOptions = {},
): Promise<Record<string, unknown>> {
  const filters = {
    ...(readString(args.category) ? { category: readString(args.category) } : {}),
    ...(readString(args.prefix) ? { prefix: readString(args.prefix) } : {}),
    ...(readString(args.query) ? { query: readString(args.query) } : {}),
    includeHidden: args.includeHidden === true,
    // No page size unless the caller names one: the catalog is listed whole.
    ...(args.limit === undefined || args.limit === null || args.limit === '' ? {} : { limit: readLimit(args.limit, 1, Number.MAX_SAFE_INTEGER) }),
  };
  // Ownership-aware: daemon-owned keys carry the DAEMON's live value.
  const page = await listEffectiveHarnessSettingsPage(configManager, filters, {
    ...options,
    includeParameters: args.includeParameters === true,
  });
  options.assertCurrent?.();
  const settings = page.settings;
  const related = relatedSettingCommands(settings);
  return {
    ...catalogEnvelope(
      'settings',
      settings,
      page.total,
      catalogFilters(args, CATALOG_QUERIES.settings.filters),
      CATALOG_QUERIES.settings.discovery,
    ),
    ...(related.length > 0 ? { relatedCommands: related } : {}),
    policy: settingsPolicySummary(),
  };
}

/**
 * The guided flows for the domains on this page.
 *
 * Some of what a domain needs cannot be a setting: the card number behind
 * `payments.*` is typed at a local terminal through a masked prompt and stored
 * write-only. A page of payment settings that never mentions `/payments card`
 * leaves a reader concluding the platform cannot take a card at all, which is
 * how the live failure ended.
 */
function relatedSettingCommands(
  settings: readonly { readonly key?: unknown }[],
): readonly Record<string, string>[] {
  const seen = new Map<string, Record<string, string>>();
  for (const setting of settings) {
    const key = typeof setting.key === 'string' ? setting.key : '';
    const related = key ? settingDomainRelatedCommand(key) : undefined;
    if (!related || seen.has(related.command)) continue;
    // A command with a subcommand is a flow the person types themselves (the card prompt): running only its
    // root would be a different command, so no model route is offered for it.
    const personOnly = related.command.trim().includes(' ');
    seen.set(related.command, {
      command: related.command,
      why: related.why,
      userRoute: related.command,
      ...(personOnly ? {} : { modelRoute: `agent_harness mode:"run_command" commandName:"${related.command.replace(/^\//, '')}"` }),
    });
  }
  return Array.from(seen.values());
}
