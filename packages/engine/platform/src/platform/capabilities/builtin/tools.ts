/**
 * Tools and extensions: the tools the model can call in the program holding
 * the conversation, and a web search.
 *
 *  - `tools.list`, `tools.contract`, `tools.verify`, `tools.verify-all`: the
 *    tool registry is what every tool call of this program's turns runs
 *    through, so these run in that program (home `session`); they only read
 *    it and check that each tool keeps the contract it declares.
 *  - `tools.web-search`: a search through the daemon's web search service
 *    (the one `web_search.query` runs), so a person, the model, an outside
 *    agent and a script reach the same search, worded with its results.
 */
import type { CapabilityDefinition, InputDescription, ListName } from '../types.js';
import { CapabilityRefusal } from '../types.js';

/** One tool as the capabilities show it. */
export interface ToolSummary {
  readonly name: string;
  readonly description: string;
}

/** One tool's contract check, in the verifier's own words. */
export interface ToolContractCheck {
  readonly tool: string;
  readonly passed: boolean;
  /** The verifier's report of it (what passed, what did not). */
  readonly text: string;
}

/** What the tool capabilities need: this program's tool registry. */
export interface ToolRegistryCapabilityServices {
  readonly toolRegistry: {
    list(): readonly ToolSummary[];
    /** A tool's definition: its description and its parameters; undefined when no tool has that name. */
    describe(name: string): (ToolSummary & { readonly parameters: unknown }) | undefined;
    verify(name: string): Promise<ToolContractCheck | undefined>;
    /** Every tool checked, and the verifier's report of them all. */
    verifyAll(): Promise<{ readonly checks: readonly ToolContractCheck[]; readonly text: string }>;
  };
}

/** The tools the model can call here (the list lives in terminal-shell, read from this program's registry). */
export const TOOLS_LIST = 'tools' as ListName;

const TOOL: InputDescription = {
  id: 'tool', label: 'Tool', help: 'The tools the model can call here', kind: 'choice', choices: { list: TOOLS_LIST }, required: true, typed: { position: 1 },
};

function noTool(name: string): CapabilityRefusal {
  return new CapabilityRefusal(`No tool ${name} is registered here.`, 'The Tools list shows the tools the model can call.', 'NOT_FOUND');
}

export const TOOLS_LIST_CAPABILITY: CapabilityDefinition<ToolRegistryCapabilityServices> = {
  capability: { id: 'tools.list', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'list', label: 'See the tools the model can use', word: 'list', inputs: [],
  sentence: 'Lists the tools the model can use here (call in this session), each with what it does.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const tools = services.toolRegistry.list();
    return {
      text: tools.length === 0 ? 'No tools are registered here.' : ['Available tools:', ...tools.map((tool) => `  • ${tool.name}${tool.description ? `: ${tool.description.split('\n')[0]!.slice(0, 100)}` : ''}`)].join('\n'),
      data: { tools: tools.map((tool) => ({ name: tool.name, description: tool.description })) },
    };
  },
};

export const TOOLS_CONTRACT: CapabilityDefinition<ToolRegistryCapabilityServices> = {
  capability: { id: 'tools.contract', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'contract', label: 'See one tool\'s contract', word: 'contract', inputs: [TOOL],
  sentence: 'Shows tool {tool}: its description, its parameters, and whether it keeps its contract.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { tool: 'read' },
  async run(values, services) {
    const name = values.tool!;
    const check = await services.toolRegistry.verify(name);
    const tool = services.toolRegistry.describe(name);
    if (!check || !tool) throw noTool(name);
    const parameters = JSON.stringify(tool.parameters, null, 2) ?? '{}';
    return {
      text: [check.text, '', 'Tool definition:', `  Name:        ${tool.name}`, `  Description: ${tool.description}`,
        `  Parameters:  ${parameters.replace(/\n/g, '\n               ')}`].join('\n'),
      data: { tool: tool.name, description: tool.description, parameters: tool.parameters, passed: check.passed },
    };
  },
};

export const TOOLS_VERIFY: CapabilityDefinition<ToolRegistryCapabilityServices> = {
  capability: { id: 'tools.verify', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'verify', label: 'Check one tool keeps its contract', word: 'verify', inputs: [TOOL],
  sentence: 'Checks that tool {tool} keeps the contract it declares.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { tool: 'read' },
  async run(values, services) {
    const check = await services.toolRegistry.verify(values.tool!);
    if (!check) throw noTool(values.tool!);
    return { text: check.text, data: { tool: check.tool, passed: check.passed } };
  },
};

export const TOOLS_VERIFY_ALL: CapabilityDefinition<ToolRegistryCapabilityServices> = {
  capability: { id: 'tools.verify-all', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'verify-all', label: 'Check every tool keeps its contract', word: 'verify-all', inputs: [],
  sentence: 'Checks that every registered tool keeps the contract it declares.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const { checks, text } = await services.toolRegistry.verifyAll();
    return { text, data: { checks: checks.map((check) => ({ tool: check.tool, passed: check.passed })), failed: checks.filter((check) => !check.passed).length } };
  },
};

export const TOOL_REGISTRY_CAPABILITIES: readonly CapabilityDefinition<ToolRegistryCapabilityServices>[] = [
  TOOLS_LIST_CAPABILITY, TOOLS_CONTRACT, TOOLS_VERIFY, TOOLS_VERIFY_ALL,
];

/** What the web search needs: the daemon's web search service, the one its method `web_search.query` runs. */
export interface WebSearchCapabilityServices {
  readonly webSearch?: {
    search(request: { readonly query: string; readonly maxResults?: number | undefined; readonly includeInstantAnswer?: boolean | undefined }): Promise<unknown>;
    getStatus(): Promise<{ readonly enabled: boolean; readonly note?: string | undefined }>;
  } | undefined;
}

/**
 * A web search for words: the daemon's web search service, the same one its
 * method `web_search.query` and the model's `web_search` tool run, worded with
 * the results and where each came from.
 */
export const WEB_SEARCH: CapabilityDefinition<WebSearchCapabilityServices> = {
  capability: { id: 'tools.web-search', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'search', label: 'Search the web', word: '',
  inputs: [
    { id: 'query', label: 'Words', help: 'What to look up on the web: a topic, a question, a library and its docs', kind: 'text', freeTextReason: 'your own words', required: true, typed: { tail: true } },
    { id: 'limit', label: 'How many', help: 'How many results to list', kind: 'number', freeTextReason: 'a whole number', required: { default: '', defaultMeans: 'the provider\'s usual number' }, typed: { flag: '--limit' } },
  ],
  sentence: '{query} is looked up on the web (an internet search through the web search provider) and the ranked pages are listed, each with where it came from.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'none', example: { query: 'bun test runner', limit: '5' },
  async run(values, services) {
    const service = services.webSearch;
    if (!service) throw new CapabilityRefusal('Web search is not available in this daemon.', undefined, 'UNAVAILABLE');
    const query = values.query!.trim();
    if (!query) throw new CapabilityRefusal('Say what to search for.');
    const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) throw new CapabilityRefusal(`How many: "${values.limit}" is not a whole number from 1.`);
    let answer: unknown;
    try {
      answer = await service.search({ query, includeInstantAnswer: true, ...(limit !== undefined ? { maxResults: limit } : {}) });
    } catch (error) {
      // The service throws when no provider is registered or the provider fails; its own status says which.
      let detail = error instanceof Error ? error.message : String(error);
      try {
        const status = await service.getStatus();
        if (!status.enabled && status.note) detail = `${detail} (${status.note})`;
      } catch { /* The status failing too adds nothing to say. */ }
      throw new CapabilityRefusal(`Search failed: ${detail}`, undefined, 'NOT_DONE');
    }
    const body = (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>;
    return { text: webSearchWords(answer), data: { query: body['query'] ?? query, provider: body['providerLabel'] ?? body['providerId'], results: Array.isArray(body['results']) ? body['results'] : [], ...(body['instantAnswer'] ? { instantAnswer: body['instantAnswer'] } : {}) } };
  },
};

/** A web search's answer (`web_search.query`) in a person's words: the instant answer, then each result with where it came from. */
export function webSearchWords(answer: unknown): string {
  const body = (answer && typeof answer === 'object' ? answer : {}) as {
    readonly query?: unknown; readonly providerLabel?: unknown; readonly results?: unknown; readonly instantAnswer?: unknown;
  };
  const text = (value: unknown): string => typeof value === 'string' ? value : '';
  const lines: string[] = [`Search: "${text(body.query)}"  (source: ${text(body.providerLabel) || 'the web search provider'})`];
  const instant = (body.instantAnswer && typeof body.instantAnswer === 'object' ? body.instantAnswer : undefined) as Record<string, unknown> | undefined;
  const said = instant ? text(instant['answer']) || text(instant['abstract']) : '';
  if (instant && said) {
    lines.push('', `${text(instant['heading']) || text(instant['source']) || 'Instant answer'}: ${said}`);
    if (text(instant['url'])) lines.push(`  ${text(instant['url'])}`);
  }
  const results = Array.isArray(body.results) ? body.results as Record<string, unknown>[] : [];
  if (results.length === 0) {
    lines.push('', 'No results found.');
    return lines.join('\n');
  }
  lines.push('');
  results.forEach((result, index) => {
    const url = text(result['url']);
    lines.push(`${typeof result['rank'] === 'number' ? result['rank'] : index + 1}. ${text(result['title']) || text(result['displayUrl']) || url}`);
    if (text(result['snippet'])) lines.push(`   ${text(result['snippet'])}`);
    if (url) lines.push(`   ${url}`);
  });
  return lines.join('\n');
}
