/**
 * `engine.hooks.contract-search`: which hook points fit what an operator types
 * after `/hooks contracts`, when the words match no hook point literally?
 * HookApi.contracts tries a local match on each hook point's phase, category,
 * specific and description words first; this battery is asked only when that
 * finds nothing. One yes/no per hook point, all in a single request.
 *
 * Band: low stakes. The result is a listing a person reads; an unsure entry is
 * listed and marked as such.
 */
import { defineBattery, STAKES_BANDS, yesNo, type Fixture, type YesNoItem } from '@goodvibes-jev/judgment';
import { listHookPointContracts, type HookPointContract } from '../contracts.js';

function hookPointQuestion(contract: HookPointContract): YesNoItem {
  const powers = contract.canDeny ? 'a hook there can block it' : 'a hook there only observes';
  return yesNo(
    `Is the hook point ${contract.pattern} (${contract.description} ${powers}) one the operator is looking for with \`query\`?`,
    STAKES_BANDS.low.yesNo,
    {
      true: 'The query names or describes this hook point: its event, its phase (before, after success, after failure, lifecycle, change) or what a hook there may do, in any wording.',
      false: 'The query is about a different event or phase, even if it shares some words. When the query names a specific event, such as an MCP call, a hook point for a broader event that merely includes it, such as any tool call, is not the one asked for.',
    },
  );
}

type HookPointItems = Readonly<Record<string, YesNoItem>>;

const ITEMS: HookPointItems = Object.fromEntries(
  listHookPointContracts().map((contract) => [contract.pattern, hookPointQuestion(contract)]),
);

/** The hook point a query is about; every other hook point is a "no" for it. */
const LABELLED: readonly (readonly [query: string, pattern: string])[] = [
  ['stop a tool call before it runs', 'Pre:tool:*'],
  ['after a tool finished fine', 'Post:tool:*'],
  ['a tool blew up', 'Fail:tool:*'],
  ['after something wrote to disk', 'Post:file:*'],
  ['writing to disk went wrong', 'Fail:file:*'],
  ['veto someone running git commit', 'Pre:git:*'],
  ['after a push went through', 'Post:git:*'],
  ['a merge did not go through', 'Fail:git:*'],
  ['rewrite or block requests going out to the model', 'Pre:llm:chat'],
  ['after the assistant answered', 'Post:llm:chat'],
  ['the model provider errored', 'Fail:llm:chat'],
  ['block a server tool invocation before it happens', 'Pre:mcp:call'],
  ['after a server tool invocation succeeds', 'Post:mcp:call'],
  ['an MCP server call failed', 'Fail:mcp:call'],
  ['before the context gets summarised', 'Pre:compact:*'],
  ['after the history got shortened', 'Post:compact:*'],
  ['compaction blew up', 'Fail:compact:*'],
  ['a session started or ended', 'Lifecycle:session:*'],
  ['when a sub-agent starts or finishes', 'Lifecycle:agent:*'],
  ['a work contract passed or failed', 'Lifecycle:contract:*'],
  ['a message got delivered to its recipient', 'Lifecycle:communication:*'],
  ['the spawn guard refused a new worker', 'Change:contract:*'],
  ['a message route was blocked by policy', 'Change:communication:*'],
  ['right before an approval prompt appears', 'Pre:permission:request'],
  ['after the user allows or denies a tool', 'Post:permission:decision'],
  ['the approval prompt broke', 'Fail:permission:request'],
  ['a server connected or disconnected', 'Lifecycle:mcp:*'],
  ['the daemon connection came up', 'Lifecycle:transport:*'],
  ['someone edited the settings', 'Change:config:*'],
  ['a file was changed outside the session', 'Change:file:*'],
  ['spending crossed a limit', 'Change:budget:*'],
  ['an outside service posted an event to us', '*:webhook:*'],
];

const ALL_NO: Readonly<Record<string, 'no'>> = Object.fromEntries(Object.keys(ITEMS).map((pattern) => [pattern, 'no' as const]));

const FIXTURES: readonly Fixture<HookPointItems>[] = [
  ...LABELLED.map(([query, pattern]) => ({ name: query, state: { query }, expect: { [pattern]: 'yes' as const } })),
  { name: 'nothing about hooks', state: { query: 'switch the TUI to a light colour theme' }, expect: ALL_NO },
];

export const hookContractSearch = defineBattery({
  name: 'engine.hooks.contract-search',
  version: 3,
  description: 'Which hook points match what an operator types to filter the hook contract listing, asked only when no hook point matches the words literally.',
  accuracyFloor: 0.9,
  items: ITEMS,
  fixtures: FIXTURES,
});
