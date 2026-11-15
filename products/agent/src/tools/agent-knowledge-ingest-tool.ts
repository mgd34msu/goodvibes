import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { assertCurrentToolEffect, assertProjectionExecution, ToolInputProjectionError, type ToolRegistry, type ToolInputProjector } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureStrictJudgmentJson } from '@goodvibes-jev/engine/platform/platform/gate';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, relative, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { captureOperatorConnection } from '../agent/operator-connection-owner.ts';
import { captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import type { AgentConnectedHostConfigReader } from '../agent/routine-schedule-promotion.ts';
import {
  classifyKnowledgeError,
  postAgentKnowledgeJson,
  type AgentKnowledgeFailure,
} from '../cli/agent-knowledge-runtime.ts';
import { AGENT_KNOWLEDGE_METHODS } from '../cli/agent-knowledge-methods.ts';
import { formatBatchIngest, formatFailure, formatIngest } from '../cli/agent-knowledge-format.ts';

export type AgentKnowledgeIngestSourceKind =
  | 'url'
  | 'file'
  | 'artifact'
  | 'urls_file'
  | 'bookmarks_file'
  | 'browser_history'
  | 'connector';

export interface AgentKnowledgeIngestToolArgs {
  readonly sourceKind?: unknown;
  readonly url?: unknown;
  readonly path?: unknown;
  readonly artifactId?: unknown;
  readonly title?: unknown;
  readonly tags?: unknown;
  readonly folderPath?: unknown;
  readonly connectorId?: unknown;
  readonly input?: unknown;
  readonly content?: unknown;
  readonly browsers?: unknown;
  readonly sourceKinds?: unknown;
  readonly homeOverride?: unknown;
  readonly limit?: unknown;
  readonly sinceDays?: unknown;
  readonly allowPrivateHosts?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

type JsonRecord = Record<string, unknown>;

interface AgentKnowledgeIngestRequest {
  readonly method: typeof AGENT_KNOWLEDGE_METHODS[keyof typeof AGENT_KNOWLEDGE_METHODS];
  readonly target: string;
  readonly targetLabel: string;
  readonly label: string;
  readonly payload: JsonRecord;
  readonly batch: boolean;
  /** Effective settings shown in the refusal preview, so an admission names what it covers. */
  readonly details?: readonly string[];
  /** Appended to a successful result when the request was adjusted. */
  readonly notes?: readonly string[];
}

/** The daemon clamps a browser-history import to this many rows. */
const BROWSER_HISTORY_LIMIT_MAX = 500;
/** A captured file is held in memory and compared again before the send. */
const MAX_INGEST_FILE_BYTES = 64 * 1024 * 1024;

/** Every source kind the tool accepts; the connected-host capability map lists the same set. */
export const SOURCE_KINDS: readonly AgentKnowledgeIngestSourceKind[] = [
  'url',
  'file',
  'artifact',
  'urls_file',
  'bookmarks_file',
  'browser_history',
  'connector',
];

function isSourceKind(value: unknown): value is AgentKnowledgeIngestSourceKind {
  return value === 'url' || value === 'file' || value === 'artifact' || value === 'urls_file'
    || value === 'bookmarks_file' || value === 'browser_history' || value === 'connector';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalString(value: unknown): string | undefined {
  const text = readString(value);
  return text.length > 0 ? text : undefined;
}

function readStringList(value: unknown): readonly string[] {
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return Math.min(value, 10_000);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return Math.min(parsed, 10_000);
  }
  return fallback;
}

/** Absent means undefined, null or blank text; a number is a value, never absent. */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** An argument rule this tool refuses; the text is fixed, never built from the caller's values, so it can be shown to the model. */
class IngestArgumentError extends Error {}

function readSinceMs(value: unknown): number | undefined {
  if (isAbsent(value)) return undefined;
  const days = readPositiveInt(value, 0);
  if (days <= 0) throw new IngestArgumentError('sinceDays must be a positive whole number of days; omit it to import without a time window.');
  return days * 24 * 60 * 60 * 1000;
}

function readImportLimit(value: unknown): number {
  if (isAbsent(value)) return 250;
  const limit = readPositiveInt(value, 0);
  if (limit <= 0) throw new IngestArgumentError('limit must be a positive whole number.');
  return limit;
}

function validateUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Agent Knowledge URL ingest requires an http(s) URL.';
    return null;
  } catch {
    return 'url must be a valid http(s) URL.';
  }
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

function formatKnowledgeFailure(failureResult: AgentKnowledgeFailure): string {
  return formatFailure(failureResult, false);
}

function preview(request: AgentKnowledgeIngestRequest): string {
  return [
    `Agent Knowledge ${request.label} preview`,
    `  source ${request.targetLabel}`,
    ...(request.details ?? []).map((line) => `  ${line}`),
    `  route ${request.method.route}`,
    '  policy isolated Agent Knowledge only; no default knowledge or non-Agent fallback',
  ].join('\n');
}

function parseConnectorInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function requestForArgs(args: AgentKnowledgeIngestToolArgs): AgentKnowledgeIngestRequest {
  const sourceKind = args.sourceKind === undefined || readString(args.sourceKind) === ''
    ? 'url'
    : isSourceKind(args.sourceKind)
      ? args.sourceKind
      : null;
  if (sourceKind === null) throw new IngestArgumentError(`sourceKind must be one of ${SOURCE_KINDS.join(', ')}.`);

  // Private-host protection is the daemon's; a model cannot widen it for itself.
  if (readBoolean(args.allowPrivateHosts)) {
    throw new IngestArgumentError('allowPrivateHosts cannot be set by the model. Private-host sources are ingested by the owner from the workspace.');
  }
  const title = readOptionalString(args.title);
  const tags = readStringList(args.tags);
  const originMetadata = {
    originSurface: 'goodvibes-agent',
    explicitUserRequest: readString(args.explicitUserRequest),
  };

  if (sourceKind === 'url') {
    const url = readString(args.url);
    if (!url) throw new IngestArgumentError('url is required.');
    const invalidUrl = validateUrl(url);
    if (invalidUrl) throw new IngestArgumentError(invalidUrl);
    return {
      method: AGENT_KNOWLEDGE_METHODS.ingestUrl,
      target: url,
      targetLabel: 'url',
      label: 'URL ingest',
      batch: false,
      payload: {
        url,
        title,
        tags: [...tags],
        folderPath: readOptionalString(args.folderPath),
        sourceType: 'url',
        connectorId: 'goodvibes-agent-main-conversation',
        metadata: originMetadata,
      },
    };
  }

  if (sourceKind === 'file') {
    const path = readString(args.path);
    if (!path) throw new IngestArgumentError('path is required.');
    return {
      method: AGENT_KNOWLEDGE_METHODS.ingestArtifact,
      target: path,
      targetLabel: 'file',
      label: 'file ingest',
      batch: false,
      payload: {
        path,
        title,
        tags: [...tags],
        folderPath: readOptionalString(args.folderPath),
        connectorId: readOptionalString(args.connectorId) ?? 'goodvibes-agent-main-conversation-file',
        metadata: originMetadata,
      },
    };
  }

  if (sourceKind === 'artifact') {
    const artifactId = readString(args.artifactId);
    if (!artifactId) throw new IngestArgumentError('artifactId is required.');
    return {
      method: AGENT_KNOWLEDGE_METHODS.ingestArtifact,
      target: artifactId,
      targetLabel: 'artifact',
      label: 'artifact ingest',
      batch: false,
      payload: {
        artifactId,
        title,
        tags: [...tags],
        folderPath: readOptionalString(args.folderPath),
        connectorId: readOptionalString(args.connectorId) ?? 'goodvibes-agent-artifact-browser',
        metadata: originMetadata,
      },
    };
  }

  if (sourceKind === 'urls_file' || sourceKind === 'bookmarks_file') {
    const path = readString(args.path);
    if (!path) throw new IngestArgumentError('path is required.');
    const method = sourceKind === 'urls_file' ? AGENT_KNOWLEDGE_METHODS.ingestUrls : AGENT_KNOWLEDGE_METHODS.ingestBookmarks;
    return {
      method,
      target: path,
      targetLabel: 'file',
      label: sourceKind === 'urls_file' ? 'URL-list import' : 'bookmarks import',
      batch: true,
      payload: {
        path,
        metadata: originMetadata,
      },
    };
  }

  if (sourceKind === 'browser_history') {
    const requestedLimit = readImportLimit(args.limit);
    const limit = Math.min(requestedLimit, BROWSER_HISTORY_LIMIT_MAX);
    const sinceMs = readSinceMs(args.sinceDays);
    const browsers = readStringList(args.browsers), kinds = readStringList(args.sourceKinds);
    const homeOverride = readOptionalString(args.homeOverride);
    return {
      method: AGENT_KNOWLEDGE_METHODS.ingestBrowserHistory,
      target: 'local browser history',
      targetLabel: 'source',
      label: 'browser-history import',
      batch: true,
      details: [
        `browsers ${browsers.length > 0 ? browsers.join(', ') : 'all'}`,
        `source kinds ${kinds.length > 0 ? kinds.join(', ') : 'all'}`,
        `limit ${limit}`,
        `window ${sinceMs === undefined ? 'none (all history up to the limit)' : `last ${Math.round(sinceMs / 86_400_000)} day(s)`}`,
        ...(homeOverride ? [`profile home ${homeOverride}`] : []),
      ],
      ...(requestedLimit > limit ? { notes: [`The limit was capped at ${limit} (requested ${requestedLimit}).`] } : {}),
      payload: {
        browsers: [...browsers],
        sourceKinds: [...kinds],
        homeOverride,
        limit,
        sinceMs,
        connectorId: 'goodvibes-agent-main-conversation-browser-history',
        metadata: originMetadata,
      },
    };
  }

  const connectorId = readString(args.connectorId);
  if (!connectorId) throw new IngestArgumentError('connectorId is required.');
  const input = parseConnectorInput(args.input);
  const path = readOptionalString(args.path);
  const content = readOptionalString(args.content);
  if (input === undefined && !path && !content) {
    throw new IngestArgumentError('connector ingest requires input, path, or content.');
  }
  return {
    method: AGENT_KNOWLEDGE_METHODS.ingestConnector,
    target: connectorId,
    targetLabel: 'connector',
    label: 'connector ingest',
    batch: true,
    payload: {
      connectorId,
      input,
      path,
      content,
      sessionId: 'goodvibes-agent-main-conversation',
      metadata: originMetadata,
    },
  };
}

interface IngestCapture {
  readonly shellPaths: ShellPathService;
  readonly configManager: AgentConnectedHostConfigReader;
  readonly connection: ReturnType<typeof captureOperatorConnection>;
  readonly request: AgentKnowledgeIngestRequest;
  readonly assertCurrent: () => void;
}
const ingestCaptures = new WeakMap<object, IngestCapture>();

function fileSignature(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
/** The argument names something this tool cannot ingest; the problem is the arguments, not the host. */
const invalidSelection = (detail?: string) => new ToolInputProjectionError('invalid', detail);

function captureIngestFile(path: string): () => void {
  let before: BigIntStats;
  try { before = lstatSync(path, { bigint: true }); } catch { throw invalidSelection('The path does not name an existing file.'); }
  // A single-link regular file only: another name for the same bytes could change them unseen.
  if (!before.isFile() || before.isSymbolicLink()) throw invalidSelection('The path must name a regular file, not a directory or symbolic link.');
  if (before.nlink !== 1n) throw invalidSelection('The file has more than one hard link, so its content could change unseen. Ingest a copy with a single link.');
  if (before.size > BigInt(MAX_INGEST_FILE_BYTES)) throw invalidSelection(`The file is larger than the ${MAX_INGEST_FILE_BYTES / (1024 * 1024)} MiB limit.`);
  const signature = fileSignature(before);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    if (fileSignature(fstatSync(fd, { bigint: true })) !== signature) throw new ToolInputProjectionError('stale');
    bytes = readFileSync(fd);
    if (fileSignature(fstatSync(fd, { bigint: true })) !== signature
      || fileSignature(lstatSync(path, { bigint: true })) !== signature) throw new ToolInputProjectionError('stale');
  } finally { closeSync(fd); }
  const parents: Array<{ readonly path: string; readonly identity: string }> = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalidSelection('A directory on the path is a symbolic link; use the real path inside the workspace.');
    parents.push({ path: current, identity: `${stat.dev}:${stat.ino}:${stat.mode}` });
    if (current === dirname(current)) break;
  }
  return () => {
    for (const parent of parents) {
      const stat = lstatSync(parent.path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || `${stat.dev}:${stat.ino}:${stat.mode}` !== parent.identity) throw new ToolInputProjectionError('stale');
    }
    const current = lstatSync(path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || fileSignature(current) !== signature) throw new ToolInputProjectionError('stale');
    const checkFd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      if (fileSignature(fstatSync(checkFd, { bigint: true })) !== signature
        || !readFileSync(checkFd).equals(bytes)
        || fileSignature(fstatSync(checkFd, { bigint: true })) !== signature
        || fileSignature(lstatSync(path, { bigint: true })) !== signature) throw new ToolInputProjectionError('stale');
    } finally { closeSync(checkFd); }
  };
}

/** Capture the complete original acquisition selection before admission; this grants no effects. */
export function createAgentKnowledgeIngestInputProjector(shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader): ToolInputProjector {
  return { async project(request) {
    request.assertCurrent(); request.signal?.throwIfAborted();
    const original = captureStrictJudgmentJson(request.args);
    // Argument problems are refused as `invalid` (check the arguments); anything else would read as a host outage.
    let ingest: AgentKnowledgeIngestRequest;
    try { ingest = requestForArgs(original); } catch (error) { throw invalidSelection(error instanceof IngestArgumentError ? error.message : undefined); }
    const method = ingest.method, methodSnapshot = captureStrictJudgmentJson(method);
    const assertMethods = captureCatalogMethods(AGENT_KNOWLEDGE_METHODS, ['ingestUrl', 'ingestArtifact', 'ingestUrls', 'ingestBookmarks', 'ingestBrowserHistory', 'ingestConnector']);
    const assertShellPaths = captureCatalogMethods(shellPaths, ['workingDirectory', 'homeDirectory', 'resolveWorkspacePath']);
    const workspace = shellPaths.workingDirectory, home = shellPaths.homeDirectory;
    const physicalWorkspace = realpathSync(workspace), workspaceStat = lstatSync(physicalWorkspace, { bigint: true });
    if (!workspaceStat.isDirectory()) throw new ToolInputProjectionError('held');
    const workspaceIdentity = `${workspaceStat.dev}:${workspaceStat.ino}:${workspaceStat.mode}:${workspaceStat.ctimeNs}`;
    const resolveWorkspacePath = shellPaths.resolveWorkspacePath;
    const selectedPath = readOptionalString(ingest.payload.path);
    const localPath = selectedPath ? resolveWorkspacePath.call(shellPaths, selectedPath) : undefined;
    // The model picks this path, so it stays inside the workspace; a file elsewhere is the owner's to hand over.
    const inWorkspace = (target: string) => { const rel = relative(physicalWorkspace, target); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
    if (localPath && !inWorkspace(localPath)) throw invalidSelection('The path must be inside the workspace.');
    const homeOverride = readOptionalString(ingest.payload.homeOverride);
    if (homeOverride && !inWorkspace(resolveWorkspacePath.call(shellPaths, homeOverride))) throw invalidSelection('homeOverride must be inside the workspace.');
    const assertFile = localPath ? captureIngestFile(localPath) : undefined;
    const retainedRequest = captureStrictJudgmentJson({ ...ingest,
      payload: { ...ingest.payload, ...(localPath ? { path: localPath } : {}) } });
    let released = false;
    const assertSelection = () => {
      request.assertCurrent(); request.signal?.throwIfAborted(); assertShellPaths(); assertMethods();
      const current = lstatSync(physicalWorkspace, { bigint: true });
      if (released || shellPaths.workingDirectory !== workspace || shellPaths.homeDirectory !== home
        || realpathSync(workspace) !== physicalWorkspace || !current.isDirectory()
        || `${current.dev}:${current.ino}:${current.mode}:${current.ctimeNs}` !== workspaceIdentity
        || (selectedPath && resolveWorkspacePath.call(shellPaths, selectedPath) !== localPath)
        || !isDeepStrictEqual(captureStrictJudgmentJson(method), methodSnapshot)) throw new ToolInputProjectionError('stale');
      assertFile?.(); assertShellPaths(); request.assertCurrent();
    };
    const connection = captureOperatorConnection(shellPaths, configManager, assertSelection);
    const assertCurrent = () => { assertSelection(); connection.assertCurrent(); assertSelection(); };
    assertCurrent();
    const context = Object.freeze({});
    ingestCaptures.set(context, { shellPaths, configManager, connection, request: retainedRequest, assertCurrent });
    return { status: 'projected', args: request.args, executionContext: context, assertCurrent,
      assertRepairedArgs(args) {
        if (!isDeepStrictEqual(captureStrictJudgmentJson(args), original)) throw new ToolInputProjectionError('binding-changed');
        assertCurrent();
      },
      async release() { released = true; ingestCaptures.delete(context); },
    };
  } };
}

export function createAgentKnowledgeIngestTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): Tool {
  return {
    definition: {
      name: 'agent_knowledge_ingest',
      description: 'Ingest one source into isolated Agent Knowledge after recorded effect admission. sourceKind defaults to url, which needs url; file, urls_file and bookmarks_file need a path inside the workspace; artifact needs artifactId; connector needs connectorId plus input, path or content.',
      parameters: {
        type: 'object',
        properties: {
          sourceKind: {
            type: 'string',
            enum: [...SOURCE_KINDS],
            description: 'Source kind. Defaults to url for backwards compatibility.',
          },
          url: {
            type: 'string',
            description: 'HTTP(S) URL when sourceKind is url.',
          },
          path: {
            type: 'string',
            description: 'Local file or import path; must be inside the workspace.',
          },
          artifactId: {
            type: 'string',
            description: 'Saved artifact id when sourceKind is artifact.',
          },
          title: {
            type: 'string',
            description: 'Optional source title for url, file or artifact ingest.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for url, file or artifact ingest.',
          },
          folderPath: {
            type: 'string',
            description: 'Optional folder path for url, file or artifact ingest.',
          },
          connectorId: {
            type: 'string',
            description: 'Connector id.',
          },
          input: {
            description: 'Connector input as JSON-compatible data or a JSON/text string.',
          },
          content: {
            type: 'string',
            description: 'Connector content text.',
          },
          browsers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional browser ids for browser_history ingest.',
          },
          sourceKinds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional browser-history source kinds such as history or bookmark.',
          },
          homeOverride: {
            type: 'string',
            description: 'Optional browser profile home override for browser_history ingest; must be inside the workspace.',
          },
          limit: {
            type: 'number',
            description: 'Optional browser_history import limit: a positive whole number, default 250, at most 500.',
          },
          sinceDays: {
            type: 'number',
            description: 'Optional browser_history lookback window in whole days; omit for no window.',
          },
          allowPrivateHosts: {
            type: 'boolean',
            description: 'Not accepted from the model: private-host sources are ingested by the owner from the workspace.',
          },
          confirm: {
            type: 'boolean',
            description: 'Optional audit annotation; does not grant effect authority.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'Optional request provenance; does not grant effect authority.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      sideEffects: ['read_fs', 'network', 'state'],
    },
    execute: async (rawArgs, options) => {
      let request: AgentKnowledgeIngestRequest;
      try { request = requestForArgs(captureStrictJudgmentJson(rawArgs)); }
      catch (error) { return failure(error instanceof Error ? error.message : 'Agent Knowledge ingest input is invalid.'); }
      const context = options?.inputProjectionContext;
      const capture = context && ingestCaptures.get(context);
      const assertCurrent = () => {
        options?.signal?.throwIfAborted();
        if (!assertCurrentToolEffect(rawArgs, options, 'write') || !assertCurrentToolEffect(rawArgs, options, 'send')
          || !context || !capture || capture.shellPaths !== shellPaths || capture.configManager !== configManager) {
          throw new ToolInputProjectionError('held');
        }
        assertProjectionExecution(context, rawArgs); capture.assertCurrent();
      };
      try { assertCurrent(); }
      catch { return failure(`${preview(request)}\n\nIngestion requires current recorded effect admission and unchanged sources.`); }
      if (!capture) return failure('Agent Knowledge ingest held.');
      request = capture.request;
      const connection = capture.connection;
      if (!connection.token) return failure(formatKnowledgeFailure({ ok: false, kind: 'auth_required',
        error: 'No connected-host operator token found.', baseUrl: connection.baseUrl, route: request.method.route }));
      const restrictions = { signal: options?.signal, assertCurrent };
      const unconfirmed = 'The request may already have reached the host. List the Agent Knowledge sources before retrying, so the same source is not ingested twice.';
      let data: unknown;
      try {
        data = await postAgentKnowledgeJson(connection, request.method.route, request.payload, restrictions);
      } catch (error) {
        try {
          assertCurrent();
          const classified = await classifyKnowledgeError(error, connection, request.method.route, restrictions);
          assertCurrent();
          const text = formatKnowledgeFailure(classified);
          assertCurrent();
          return failure(text);
        } catch { return failure(`Agent Knowledge ingest outcome could not be confirmed: admission, request, or source stopped being current. ${unconfirmed}`); }
      }
      // The host has accepted the ingest. Whatever changed locally since, the result is reported, never turned into "held".
      const text = request.batch ? formatBatchIngest(data, request.label)
        : formatIngest(data, request.target, request.label, request.method.route, request.targetLabel);
      let changedNote = '';
      try { assertCurrent(); } catch { changedNote = '\nNote: admission, the connection or the source file changed while the host was ingesting; the host\'s answer above is reported as received.'; }
      return output([text, ...(request.notes ?? [])].join('\n') + changedNote);
    },
  };
}

export function registerAgentKnowledgeIngestTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): void {
  registry.register(createAgentKnowledgeIngestTool(shellPaths, configManager), {
    inputProjection: createAgentKnowledgeIngestInputProjector(shellPaths, configManager),
  });
}
