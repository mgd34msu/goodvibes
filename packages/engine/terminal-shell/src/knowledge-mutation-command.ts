import type { KnowledgeApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { readFlag, readStringListFlag, readJsonObjectFlag, positionalArgs } from './command-arguments.js';
export const KNOWLEDGE_REVIEW_ACTIONS = ['accept', 'reject', 'resolve', 'reopen', 'edit', 'forget'] as const;
export type KnowledgeReviewAction = (typeof KNOWLEDGE_REVIEW_ACTIONS)[number];
export type KnowledgeMutationVerb = 'ingest-url' | 'import-bookmarks' | 'import-urls' | 'review-issue' | 'reindex' | 'consolidate';
export interface KnowledgeMutationPorts {
  readonly url: KnowledgeApi['ingest']['url'];
  readonly bookmarksFile: KnowledgeApi['ingest']['bookmarksFile'];
  readonly urlsFile: KnowledgeApi['ingest']['urlsFile'];
  readonly review: KnowledgeApi['graph']['issues']['review'];
  readonly reindex: KnowledgeApi['status']['reindex'];
  readonly run: KnowledgeApi['jobs']['run'];
  readonly sessionId: () => string;
  readonly allow: (verb: KnowledgeMutationVerb, subject: string | undefined, usage: string) => boolean;
  readonly describeError: (error: unknown) => string;
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
    readonly confirmationSuffix: string;
    readonly sourceLabel: string;
  },
): Promise<boolean> {
  switch (sub) {
    case 'ingest-url': {
      const [url] = positionalArgs(rest, ['--title', '--tags', '--folder']);
      if (!url) {
        print(
          '[knowledge] Usage: /knowledge ingest-url <url> [--title <title>] [--tags <a,b>] [--folder <path>]' +
            presentation.confirmationSuffix,
        );
        return true;
      }
      if (!ports.allow('ingest-url', url, '/knowledge ingest-url <url> [--title <title>] [--tags <a,b>] [--folder <path>]')) return true;
      const result = await ports.url({
        url,
        title: readFlag(rest, '--title'),
        tags: readStringListFlag(rest, '--tags'),
        folderPath: readFlag(rest, '--folder'),
        sessionId: ports.sessionId(),
        sourceType: 'url',
        connectorId: 'url',
      });
      print(`[knowledge] Ingested ${result.source.id} ${result.source.canonicalUri ?? result.source.sourceUri ?? url}`);
      if (result.source.summary) print(`  ${result.source.summary}`);
      if (result.artifactId) print(`  artifact${presentation.fieldSeparator}${result.artifactId}`);
      break;
    }
    case 'import-bookmarks': {
      const [path] = positionalArgs(rest);
      if (!path) {
        print('[knowledge] Usage: /knowledge import-bookmarks <path>' + presentation.confirmationSuffix);
        return true;
      }
      if (!ports.allow('import-bookmarks', path, '/knowledge import-bookmarks <path>')) return true;
      const result = await ports.bookmarksFile({ path, sessionId: ports.sessionId() });
      print(`[knowledge] Imported bookmarks${presentation.fieldSeparator}${result.imported} ok, ${result.failed} failed`);
      if (result.errors.length > 0) {
        for (const error of result.errors.slice(0, 10)) print(`  error${presentation.fieldSeparator}${error}`);
      }
      break;
    }
    case 'import-urls': {
      const [path] = positionalArgs(rest);
      if (!path) {
        print('[knowledge] Usage: /knowledge import-urls <path>' + presentation.confirmationSuffix);
        return true;
      }
      if (!ports.allow('import-urls', path, '/knowledge import-urls <path>')) return true;
      const result = await ports.urlsFile({ path, sessionId: ports.sessionId() });
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
          '[knowledge] Usage: /knowledge review-issue <issueId> <accept|reject|resolve|reopen|edit|forget> [--reviewer <name>] [--value <json-object>]' +
            presentation.confirmationSuffix,
        );
        return true;
      }
      if (!ports.allow('review-issue', issueId, '/knowledge review-issue <issueId> <action> [--reviewer <name>] [--value <json-object>]'))
        return true;
      const value = readJsonObjectFlag(rest, '--value');
      if (value === null) {
        print('[knowledge] --value must be a JSON object.');
        return true;
      }
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
        print(`[knowledge] ${ports.describeError(error)}`);
      }
      break;
    }
    case 'reindex': {
      if (!ports.allow('reindex', undefined, '/knowledge reindex')) return true;
      const result = await ports.reindex();
      print(
        [
          '[knowledge] Reindex complete',
          `  sources${presentation.fieldSeparator}${result.status.sourceCount}`,
          `  nodes${presentation.fieldSeparator}${result.status.nodeCount}`,
          `  edges${presentation.fieldSeparator}${result.status.edgeCount}`,
          `  issues${presentation.fieldSeparator}${result.status.issueCount}`,
        ].join('\n'),
      );
      break;
    }
    case 'consolidate': {
      if (!ports.allow('consolidate', undefined, '/knowledge consolidate [light|deep]')) return true;
      const mode = (positionalArgs(rest)[0] ?? 'light').toLowerCase();
      const jobId = mode === 'deep' ? 'knowledge-deep-consolidation' : 'knowledge-light-consolidation';
      const run = await ports.run(jobId, { mode: 'inline' });
      print(`[knowledge] Consolidation run ${run.id} finished with status ${run.status}.`);
      break;
    }
    default:
      return false;
  }
  return true;
}
