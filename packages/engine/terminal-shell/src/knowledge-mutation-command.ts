import type { KnowledgeApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { readRefusal } from '@goodvibes-jev/engine/errors';
import { readFlag, readStringListFlag, readJsonObjectFlag, positionalArgs } from './command-arguments.js';
import { commandRefusal } from './command-confirmation.js';
export const KNOWLEDGE_REVIEW_ACTIONS = ['accept', 'reject', 'resolve', 'reopen', 'edit', 'forget'] as const;
export type KnowledgeReviewAction = (typeof KNOWLEDGE_REVIEW_ACTIONS)[number];
export interface KnowledgeMutationPorts {
  readonly url: KnowledgeApi['ingest']['url'];
  readonly bookmarksFile: KnowledgeApi['ingest']['bookmarksFile'];
  readonly urlsFile: KnowledgeApi['ingest']['urlsFile'];
  readonly review: KnowledgeApi['graph']['issues']['review'];
  readonly reindex: KnowledgeApi['status']['reindex'];
  readonly run: KnowledgeApi['jobs']['run'];
  readonly runs: KnowledgeApi['jobs']['runs'];
  readonly cancelRun: KnowledgeApi['jobs']['cancelRun'];
  readonly sessionId: () => string;
  readonly describeError: (error: unknown) => string;
}
/** One shared report for every ingest verb: a stored source whose crawl failed is a failure, not an ingest. */
export function printKnowledgeIngestResult(
  print: (text: string) => void,
  source: { readonly id: string; readonly status: string; readonly canonicalUri?: string | undefined; readonly sourceUri?: string | undefined; readonly crawlError?: string | undefined },
  fallbackSubject: string,
): void {
  const subject = source.canonicalUri ?? source.sourceUri ?? fallbackSubject;
  if (source.status === 'failed') {
    throw commandRefusal(`[knowledge] Ingest failed ${source.id} ${subject}: ${source.crawlError ?? 'no reason recorded'}. The source is stored with status failed; no content was added to knowledge`,
      undefined, 'COMMAND_FAILED');
  }
  print(`[knowledge] Ingested ${source.id} ${subject}`);
}

/**
 * `--allow-private-hosts` lets an ingest fetch from the owner's own network or
 * this machine, which every ingest refuses by default. Each product's
 * /knowledge registration asks the owner once for such a line, and the Agent
 * refuses it from a model, so by the time a line reaches here it is his.
 */
function remoteFetchMode(rest: readonly string[]): 'allow-private-hosts' | 'public-only' {
  return rest.includes('--allow-private-hosts') ? 'allow-private-hosts' : 'public-only';
}

/** Parsing and mutation dispatch share code; supplied ports retain product authority and exact segment. */
export async function handleKnowledgeMutationCommand(
  sub: string,
  rest: string[],
  print: (text: string) => void,
  ports: KnowledgeMutationPorts,
  presentation: {
    readonly fieldSeparator: string;
    readonly reviewer: string;
    readonly sourceLabel: string;
  },
): Promise<boolean> {
  try {
    return await dispatchKnowledgeMutation(sub, rest, print, ports, presentation);
  } catch (error) {
    // Every verb reports a failure the same way: as the command's failed result, never as printed text.
    if (readRefusal(error)) throw error;
    throw commandRefusal(`[knowledge] ${ports.describeError(error)}`, undefined, 'COMMAND_FAILED');
  }
}
async function dispatchKnowledgeMutation(
  sub: string,
  rest: string[],
  print: (text: string) => void,
  ports: KnowledgeMutationPorts,
  presentation: {
    readonly fieldSeparator: string;
    readonly reviewer: string;
    readonly sourceLabel: string;
  },
): Promise<boolean> {
  switch (sub) {
    case 'ingest-url': {
      const [url] = positionalArgs(rest, ['--title', '--tags', '--folder']);
      if (!url) {
        print(
          '[knowledge] Usage: /knowledge ingest-url <url> [--title <title>] [--tags <a,b>] [--folder <path>] [--allow-private-hosts]',
        );
        return true;
      }
      const result = await ports.url({
        url,
        title: readFlag(rest, '--title'),
        tags: readStringListFlag(rest, '--tags'),
        folderPath: readFlag(rest, '--folder'),
        sessionId: ports.sessionId(),
        sourceType: 'url',
        connectorId: 'url',
        fetchMode: remoteFetchMode(rest),
      });
      printKnowledgeIngestResult(print, result.source, url);
      if (result.source.summary) print(`  ${result.source.summary}`);
      if (result.artifactId) print(`  artifact${presentation.fieldSeparator}${result.artifactId}`);
      break;
    }
    case 'import-bookmarks': {
      const [path] = positionalArgs(rest);
      if (!path) {
        throw commandRefusal('[knowledge] Usage: /knowledge import-bookmarks <path> [--allow-private-hosts]');
      }
      const result = await ports.bookmarksFile({ path, sessionId: ports.sessionId(), fetchMode: remoteFetchMode(rest) });
      print(`[knowledge] Imported bookmarks${presentation.fieldSeparator}${result.imported} ok, ${result.failed} failed`);
      if (result.errors.length > 0) {
        for (const error of result.errors.slice(0, 10)) print(`  error${presentation.fieldSeparator}${error}`);
      }
      break;
    }
    case 'import-urls': {
      const [path] = positionalArgs(rest);
      if (!path) {
        throw commandRefusal('[knowledge] Usage: /knowledge import-urls <path> [--allow-private-hosts]');
      }
      const result = await ports.urlsFile({ path, sessionId: ports.sessionId(), fetchMode: remoteFetchMode(rest) });
      print(`[knowledge] Imported URL list${presentation.fieldSeparator}${result.imported} ok, ${result.failed} failed`);
      if (result.errors.length > 0) {
        for (const error of result.errors.slice(0, 10)) print(`  error${presentation.fieldSeparator}${error}`);
      }
      break;
    }
    case 'review-issue':
    case 'issue-review': {
      const [issueId, actionValue] = positionalArgs(rest, ['--reviewer', '--value']);
      const action = actionValue?.toLowerCase();
      if (!issueId || !action || !KNOWLEDGE_REVIEW_ACTIONS.includes(action as KnowledgeReviewAction)) {
        print(
          '[knowledge] Usage: /knowledge review-issue <issueId> <accept|reject|resolve|reopen|edit|forget> [--reviewer <name>] [--value <json-object>]',
        );
        return true;
      }
      const value = readJsonObjectFlag(rest, '--value');
      if (value === null) throw commandRefusal('[knowledge] --value must be a JSON object.', undefined, 'USAGE');
      try {
        const result = await ports.review({
          issueId,
          action: action as KnowledgeReviewAction,
          reviewer: readFlag(rest, '--reviewer') ?? presentation.reviewer,
          ...(value ? { value } : {}),
        });
        print(
          [
            `[knowledge] Reviewed issue ${result.issue.id}`,
            `  action${presentation.fieldSeparator}${action}`,
            `  status${presentation.fieldSeparator}${result.issue.status}`,
            ...(result.node ? [`  node${presentation.fieldSeparator}${result.node.id} ${result.node.title}`] : []),
            ...(result.source
              ? [
                  `  ${presentation.sourceLabel}${presentation.fieldSeparator}${result.source.id} ${result.source.title ?? result.source.canonicalUri ?? result.source.sourceUri ?? 'untitled'}`,
                ]
              : []),
            ...(result.appliedFacts
              ? [`  applied facts${presentation.fieldSeparator}${Object.keys(result.appliedFacts).join(', ') || 'none'}`]
              : []),
          ].join('\n'),
        );
      } catch (error) {
        throw commandRefusal(`[knowledge] ${ports.describeError(error)}`, undefined, 'COMMAND_FAILED');
      }
      break;
    }
    case 'reindex': {
      const result = await ports.reindex();
      const failures = result.recompileFailures ?? [];
      print(
        [
          failures.length > 0
            ? `[knowledge] Reindex finished with ${failures.length} source${failures.length === 1 ? '' : 's'} not recompiled`
            : '[knowledge] Reindex complete',
          `  sources${presentation.fieldSeparator}${result.status.sourceCount}`,
          `  nodes${presentation.fieldSeparator}${result.status.nodeCount}`,
          `  edges${presentation.fieldSeparator}${result.status.edgeCount}`,
          `  issues${presentation.fieldSeparator}${result.status.issueCount}`,
          ...failures.map((failure) => `  not recompiled${presentation.fieldSeparator}${failure.sourceId} - ${failure.error}`),
        ].join('\n'),
      );
      break;
    }
    case 'consolidate': {
      const mode = (positionalArgs(rest)[0] ?? 'light').toLowerCase();
      if (mode !== 'light' && mode !== 'deep') {
        throw commandRefusal(`[knowledge] Unknown consolidation mode "${mode}". Nothing was run.`, 'Usage: /knowledge consolidate [light|deep]', 'USAGE');
      }
      const jobId = mode === 'deep' ? 'knowledge-deep-consolidation' : 'knowledge-light-consolidation';
      const run = await ports.run(jobId, { mode: 'inline' });
      print(`[knowledge] Consolidation run ${run.id} finished with status ${run.status}.`);
      break;
    }
    case 'cancel-run': {
      const [runId] = positionalArgs(rest);
      if (!runId) {
        // Without an id, the runs that can be cancelled are listed so one can be picked.
        const active = ports.runs(100).filter((run) => run.status === 'queued' || run.status === 'running');
        print([
          active.length === 0 ? '[knowledge] No knowledge job run is queued or running.' : '[knowledge] Knowledge job runs that can be cancelled:',
          ...active.map((run) => `  ${run.id}${presentation.fieldSeparator}${run.jobId} ${run.status}`),
          `Usage: /knowledge cancel-run <runId>`,
        ].join('\n'));
        return true;
      }
      const run = await ports.cancelRun(runId);
      print(`[knowledge] Job run ${run.id} (${run.jobId}) cancelled; status ${run.status}${run.error ? `${presentation.fieldSeparator}${run.error}` : ''}.`);
      break;
    }
    default:
      return false;
  }
  return true;
}
