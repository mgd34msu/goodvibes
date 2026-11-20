import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's knowledge rows open the actions of `/knowledge` (terminal-shell/knowledge-command.ts). */
export const KNOWLEDGE_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'knowledge-urls': { command: 'knowledge', action: 'import-urls' },
  'knowledge-file': { command: 'knowledge', action: 'ingest-file' },
  'knowledge-bookmarks': { command: 'knowledge', action: 'import-bookmarks' },
  'knowledge-browser-history': { command: 'knowledge', action: 'import-browser-history' },
  'knowledge-connector-ingest': { command: 'knowledge', action: 'ingest-connector' },
  'knowledge-connector-show': { command: 'knowledge', action: 'connector' },
  'knowledge-connector-doctor': { command: 'knowledge', action: 'connector-doctor' },
  'knowledge-reindex': { command: 'knowledge', action: 'reindex' },
  'knowledge-search': { command: 'knowledge', action: 'search' },
  'knowledge-ask': { command: 'knowledge', action: 'ask' },
  'knowledge-get': { command: 'knowledge', action: 'get' },
  'knowledge-map': { command: 'knowledge', action: 'map' },
  'knowledge-review-issue': { command: 'knowledge', action: 'review-issue' },
  'knowledge-consolidate': { command: 'knowledge', action: 'consolidate' },
  'knowledge-packet': { command: 'knowledge', action: 'packet' },
  'knowledge-explain': { command: 'knowledge', action: 'packet' },
};
