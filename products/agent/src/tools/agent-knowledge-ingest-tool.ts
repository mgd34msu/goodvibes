import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { assertCurrentToolEffect, ToolInputProjectionError, type ToolInputProjector, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureStrictJudgmentJson } from '@goodvibes-jev/engine/platform/platform/gate';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, relative, isAbsolute } from 'node:path';
import type { ShellPathService } from '@/runtime/index.ts';
import type { AgentConnectedHostConfigReader } from '../agent/routine-schedule-promotion.ts';
import {
  classifyKnowledgeError,
  postAgentKnowledgeJson,
  postAgentKnowledgeUpload,
  resolveConnectedHostConnection,
  type AgentKnowledgeFailure,
} from '../cli/agent-knowledge-runtime.ts';
import { AGENT_KNOWLEDGE_METHODS } from '../cli/agent-knowledge-methods.ts';
import { formatBatchIngest, formatFailure, formatIngest } from '../cli/agent-knowledge-format.ts';
import { readString } from './tool-args.ts';

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
/** A local file is read once into memory and sent as bytes; this bounds that read. */
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


function readOptionalString(value: unknown): string | undefined {
  const text = readString(value);
  return text.length > 0 ? text : undefined;
}

function readStringList(value: unknown): readonly string[] {
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
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
  // Anything but absent or false is refused, so no spelling of yes slips through.
  if (![undefined, null, false, 'false', ''].includes(args.allowPrivateHosts as never)) {
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

/**
 * The model picks local paths, so they stay inside the workspace: the bytes read
 * here leave for the host, and a path outside (a key file, another project) is
 * the owner's to hand over. One realpath per call.
 */
function workspacePath(shellPaths: ShellPathService, selected: string, field: string): string {
  const workspace = realpathSync(shellPaths.workingDirectory);
  let target: string;
  try { target = realpathSync(shellPaths.resolveWorkspacePath(selected)); } catch { throw new IngestArgumentError(`The ${field} does not name an existing file or directory; check the path relative to the workspace.`); }
  const rel = relative(workspace, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new IngestArgumentError(field === 'path'
      ? 'Nothing was ingested: the path is outside the workspace, and this tool reads only workspace files. Copy the file into the workspace and call again, or ask the owner to run `goodvibes-agent knowledge ingest-file <path> --yes`.'
      : `Nothing was ingested: the ${field} is outside the workspace, and this tool reads only workspace files. Point it at a profile copy inside the workspace, or omit it to import the owner's browsers.`);
  }
  return target;
}

/** Read a workspace file once, bounded; these bytes are what the host ingests. */
function readIngestFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new IngestArgumentError('The path must name a regular file, not a directory.');
    if (stat.size > MAX_INGEST_FILE_BYTES) throw new IngestArgumentError(`The file is larger than the ${MAX_INGEST_FILE_BYTES / (1024 * 1024)} MiB limit.`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** What leaves for the host: the JSON body, or the file bytes for an upload. */
type IngestSend =
  | { readonly kind: 'json'; readonly route: string; readonly payload: JsonRecord }
  | { readonly kind: 'upload'; readonly route: string; readonly bytes: Buffer; readonly filename: string; readonly fields: JsonRecord };

/**
 * Local files are read here and sent as bytes, never as a path the host would
 * open on its own machine. A single file becomes an uploaded artifact; a URL
 * or bookmarks list and a connector's file go as the connector's content.
 */
function sendFor(request: AgentKnowledgeIngestRequest, shellPaths: ShellPathService, sourceKind: string): IngestSend {
  const payload = request.payload;
  const homeOverride = readOptionalString(payload.homeOverride);
  if (homeOverride) workspacePath(shellPaths, homeOverride, 'homeOverride');
  const selected = readOptionalString(payload.path);
  if (!selected) return { kind: 'json', route: request.method.route, payload };
  const path = workspacePath(shellPaths, selected, 'path');
  const bytes = readIngestFile(path);
  if (request.method === AGENT_KNOWLEDGE_METHODS.ingestArtifact) {
    const { path: _path, ...fields } = payload;
    return { kind: 'upload', route: request.method.route, bytes, filename: basename(path), fields };
  }
  const { path: _path, ...rest } = payload;
  if (request.method === AGENT_KNOWLEDGE_METHODS.ingestConnector) {
    return { kind: 'json', route: request.method.route, payload: { ...rest, ...(rest.content === undefined && rest.input === undefined ? { content: bytes.toString('utf8') } : {}) } };
  }
  return { kind: 'json', route: AGENT_KNOWLEDGE_METHODS.ingestConnector.route, payload: {
    ...rest, connectorId: sourceKind === 'bookmarks_file' ? 'bookmark' : 'url-list', content: bytes.toString('utf8'),
  } };
}

/**
 * Argument and path problems are refused before the gate is asked anything:
 * they are facts about the arguments, settled here with no host call.
 */
export function createAgentKnowledgeIngestInputProjector(shellPaths: ShellPathService): ToolInputProjector {
  return { async project(request) {
    request.signal?.throwIfAborted();
    try {
      const ingest = requestForArgs(captureStrictJudgmentJson(request.args) as AgentKnowledgeIngestToolArgs);
      const path = readOptionalString(ingest.payload.path), homeOverride = readOptionalString(ingest.payload.homeOverride);
      if (path && statSync(workspacePath(shellPaths, path, 'path')).size > MAX_INGEST_FILE_BYTES) {
        throw new IngestArgumentError(`The file is larger than the ${MAX_INGEST_FILE_BYTES / (1024 * 1024)} MiB limit.`);
      }
      if (homeOverride) workspacePath(shellPaths, homeOverride, 'homeOverride');
    } catch (error) {
      if (error instanceof IngestArgumentError) throw new ToolInputProjectionError('invalid', error.message);
      throw error;
    }
    return { status: 'projected', args: request.args };
  } };
}

export function createAgentKnowledgeIngestTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): Tool {
  return {
    definition: {
      name: 'agent_knowledge_ingest',
      activity: { doing: 'Saving to', did: 'saved to', object: 'knowledge' },
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
      const args = captureStrictJudgmentJson(rawArgs) as AgentKnowledgeIngestToolArgs;
      try { request = requestForArgs(args); }
      catch (error) { return failure(error instanceof Error ? error.message : 'Agent Knowledge ingest input is invalid.'); }
      const admitted = () => assertCurrentToolEffect(rawArgs, options, 'write') && assertCurrentToolEffect(rawArgs, options, 'send');
      let wasAdmitted = false;
      try { wasAdmitted = admitted(); } catch { wasAdmitted = false; }
      if (!wasAdmitted) {
        return failure(`${preview(request)}\n\nNothing was ingested: this call ran without the owner's admission of an ingest. Ask the owner to allow it, then call again.`);
      }
      let send: IngestSend;
      try { send = sendFor(request, shellPaths, readString(args.sourceKind) || 'url'); }
      catch (error) { return failure(error instanceof IngestArgumentError ? error.message : `The file could not be read: ${error instanceof Error ? error.message : String(error)}`); }
      const connection = resolveConnectedHostConnection({ configManager, homeDirectory: shellPaths.homeDirectory });
      if (!connection.token) return failure(formatKnowledgeFailure({ ok: false, kind: 'auth_required',
        error: connection.unavailable?.reason ?? 'No connected-host operator token found.', baseUrl: connection.baseUrl, route: send.route,
        ...(connection.unavailable ? { next: connection.unavailable.next } : {}) }));
      const assertCurrent = () => {
        options?.signal?.throwIfAborted();
        if (!admitted()) throw new Error('The ingest admission ended before the request left. Nothing was sent.');
      };
      const restrictions = { ...(options?.signal ? { signal: options.signal } : {}), assertCurrent };
      let data: unknown;
      try {
        data = send.kind === 'upload'
          ? await postAgentKnowledgeUpload(connection, send.route, { bytes: send.bytes, filename: send.filename }, send.fields, restrictions)
          : await postAgentKnowledgeJson(connection, send.route, send.payload, restrictions);
      } catch (error) {
        try {
          return failure(formatKnowledgeFailure(await classifyKnowledgeError(error, connection, send.route, restrictions.signal ? { signal: restrictions.signal } : {})));
        } catch {
          return failure('Agent Knowledge ingest was cancelled. The request may already have reached the host. List the Agent Knowledge sources before retrying, so the same source is not ingested twice.');
        }
      }
      const text = request.batch ? formatBatchIngest(data, request.label)
        : formatIngest(data, request.target, request.label, request.method.route, request.targetLabel);
      return output([text, ...(request.notes ?? [])].join('\n'));
    },
  };
}

export function registerAgentKnowledgeIngestTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): void {
  registry.register(createAgentKnowledgeIngestTool(shellPaths, configManager), {
    inputProjection: createAgentKnowledgeIngestInputProjector(shellPaths),
  });
}
