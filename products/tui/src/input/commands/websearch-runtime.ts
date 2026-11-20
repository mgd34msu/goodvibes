import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { doAction, textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';

/**
 * registerWebSearchRuntimeCommands - `/web-search <words> [--limit <n>]`, a
 * single-action command (command-actions/).
 *
 * Calls webSearchService.search() directly (skipping the agent-tool wrapper's
 * JSON-stringify contract, same shape as /schedule's ctx.ops.automationManager
 * pattern: read the service off the context, guard on undefined, print) and
 * renders ranked results + the instant answer into the transcript with
 * source labels. webSearchService is already constructed in services.ts and
 * already agent-reachable; this is a second, direct-command consumer of the
 * same instance (ctx.platform.webSearchService).
 */
export function registerWebSearchRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'web-search', leadingFlagsOnly: true, title: 'Search the web', summary: 'Search the web and list ranked results with where each came from', group: 'Knowledge',
    actions: [doAction<CommandContext>({
      id: 'search', label: 'Search the web for words', word: '', touches: 'another-machine',
      inputs: [
        textInput({ id: 'query', label: 'Words', help: 'What to search for', why: 'your own words', typed: { tail: true } }),
        { id: 'limit', label: 'How many', help: 'How many results to list', kind: 'number', freeTextReason: 'a whole number', required: { default: '', defaultMeans: 'the provider\'s usual number' }, typed: { flag: '--limit' } },
      ],
      sentence: '{query} is sent to the web search provider and the ranked results are listed here.',
      operator: { terminalOnly: 'Web search runs in the terminal app.' }, example: { query: 'bun test runner', limit: '5' },
      async run(values, ctx) {
        const service = ctx.platform.webSearchService;
        if (!service) throw commandRefusal('Web search is not available in this session.', undefined, 'UNAVAILABLE');
        const query = values.query!.trim();
        const parsedLimit = values.limit ? Number.parseInt(values.limit, 10) : undefined;
        if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit < 1)) throw commandRefusal(`How many: "${values.limit}" is not a whole number from 1.`);
        const limit = parsedLimit;

        try {
          const response = await service.search({
            query,
            ...(limit !== undefined ? { maxResults: limit } : {}),
          });

          const lines: string[] = [`Search: "${response.query}"  (source: ${response.providerLabel})`];

          const instantAnswer = response.instantAnswer;
          if (instantAnswer) {
            const heading = instantAnswer.heading ?? instantAnswer.source ?? 'Instant answer';
            const body = instantAnswer.answer ?? instantAnswer.abstract;
            if (body) {
              lines.push('', `${heading}: ${body}`);
              if (instantAnswer.url) lines.push(`  ${instantAnswer.url}`);
            }
          }

          if (response.results.length === 0) {
            lines.push('', 'No results found.');
          } else {
            lines.push('');
            for (const result of response.results) {
              const title = result.title ?? result.displayUrl ?? result.url;
              lines.push(`${result.rank}. ${title}`);
              if (result.snippet) lines.push(`   ${result.snippet}`);
              lines.push(`   ${result.url}`);
            }
          }

          return lines.join('\n');
        } catch (error) {
          // Honest degradation: read the thrown error / the service's own status
          // surface rather than inventing an env-var name. WebSearchService.search()
          // throws (not a {success:false} result field) when no provider is
          // registered or the provider itself fails.
          let detail = summarizeError(error);
          try {
            const status = await service.getStatus();
            if (!status.enabled) detail = `${detail} (${status.note})`;
          } catch {
            // getStatus() itself failing is not worth compounding into the error message.
          }
          throw commandRefusal(`Search failed: ${detail}`, undefined, 'NOT_DONE');
        }
      },
    })],
  }));
}
