/**
 * `agent_knowledge_ingest`: one source added to the owner's knowledge, the daemon's one store. The arguments and any
 * workspace path are checked here; the ingest itself runs the daemon's `knowledge.*` capability as a nested
 * `capability_run` call, judged by that capability's own risk (fetching from the owner's network loosens a protection
 * and is the owner's to set; importing browser history is his own act), the one gate a model's daemon call goes
 * through. This call only routes it and is classed a read. A workspace file the turn names is read by this program, on
 * its own machine, and its content is sent: the daemon may be on another machine.
 */
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import { assertCurrentToolInvocation, ToolInputProjectionError, type ToolInputProjector, type ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { captureStrictJudgmentJson } from '@goodvibes/engine/platform/platform/gate';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, relative, isAbsolute } from 'node:path';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import type { ConnectedHostConfigReader as AgentConnectedHostConfigReader } from './connected-host-client.js';
import type { AgentInProcessHost } from './in-process-host.js';
/**
 * The largest file this tool sends as a capability's content: the daemon takes a method call's body of up to 1 MiB,
 * and a file that is not text goes as base64 (four bytes for three). A larger one, up to the command line's limit
 * (`MAX_KNOWLEDGE_INGEST_FILE_BYTES`, 64 MiB), is uploaded by the path the command line uses (the artifact upload) and
 * then added through the daemon's `knowledge.ingest-artifact`: one question, that capability's.
 */
const MAX_SENT_FILE_BYTES = 700 * 1024;
const TOO_LARGE_TO_SEND = `Nothing was ingested: the file is larger than ${MAX_KNOWLEDGE_INGEST_FILE_BYTES / (1024 * 1024)} MiB, the most a file is read and sent to the daemon. Split it, or add a part of it.`;
import { AGENT_KNOWLEDGE_METHODS } from './knowledge-methods.js';
import { MAX_KNOWLEDGE_INGEST_FILE_BYTES, postAgentKnowledgeUpload, resolveConnectedHostConnection } from './knowledge-runtime.js';
import { daemonCapabilityRunner } from './capability-tools.js';
import { readString } from './tool-args.js';
import { confirmParameter, requestParameter } from './effect-admission.js';

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
  readonly details?: readonly string[] | undefined;
  /** Appended to a successful result when the request was adjusted. */
  readonly notes?: readonly string[] | undefined;
}

/** The daemon clamps a browser-history import to this many rows. */
const BROWSER_HISTORY_LIMIT_MAX = 500;

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

/** The import window's length in milliseconds; the daemon takes its start as a timestamp. */
function readSinceWindowMs(value: unknown): number | undefined {
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
  // The schema does not offer the field; a call that sends it anyway is refused
  // unless it says false, so no spelling of yes slips through.
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
    const sinceWindowMs = readSinceWindowMs(args.sinceDays);
    // A list not given is omitted, so the host applies its default (every installed browser; history and
    // bookmarks); one given is sent as given, and an empty one is refused there: it selects nothing.
    const browsersGiven = args.browsers !== undefined && args.browsers !== null, kindsGiven = args.sourceKinds !== undefined && args.sourceKinds !== null;
    const browsers = readStringList(args.browsers), kinds = readStringList(args.sourceKinds);
    const homeOverride = readOptionalString(args.homeOverride);
    return {
      method: AGENT_KNOWLEDGE_METHODS.ingestBrowserHistory,
      target: 'local browser history',
      targetLabel: 'source',
      label: 'browser-history import',
      batch: true,
      details: [
        `browsers ${browsersGiven ? browsers.join(', ') || 'none' : 'all'}`,
        `source kinds ${kindsGiven ? kinds.join(', ') || 'none' : 'all'}`,
        `limit ${limit}`,
        `window ${sinceWindowMs === undefined ? 'none (all history up to the limit)' : `last ${Math.round(sinceWindowMs / 86_400_000)} day(s)`}`,
        ...(homeOverride ? [`profile home ${homeOverride}`] : []),
      ],
      ...(requestedLimit > limit ? { notes: [`The limit was capped at ${limit} (requested ${requestedLimit}).`] } : {}),
      payload: {
        ...(browsersGiven ? { browsers: [...browsers] } : {}),
        ...(kindsGiven ? { sourceKinds: [...kinds] } : {}),
        homeOverride,
        limit,
        sinceMs: sinceWindowMs === undefined ? undefined : Date.now() - sinceWindowMs,
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
      if (path && statSync(workspacePath(shellPaths, path, 'path')).size > MAX_KNOWLEDGE_INGEST_FILE_BYTES) {
        throw new IngestArgumentError(TOO_LARGE_TO_SEND);
      }
      if (homeOverride) workspacePath(shellPaths, homeOverride, 'homeOverride');
    } catch (error) {
      if (error instanceof IngestArgumentError) throw new ToolInputProjectionError('invalid', error.message);
      throw error;
    }
    return { status: 'projected', args: request.args };
  } };
}

/**
 * The ingest reaches the daemon through the nested daemon-capability runner, which holds the connection (the daemon
 * hosting this turn, or the Agent's connected host).
 */
export function createAgentKnowledgeIngestTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  inProcess?: AgentInProcessHost | undefined,
): Tool {
  const runCapability = daemonCapabilityRunner();
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
            description: 'Optional browser profile home override for browser_history ingest; must be inside the workspace. The knowledge host reads the directory itself, so it is refused when that host is another machine.',
          },
          limit: {
            type: 'number',
            description: 'Optional browser_history import limit: a positive whole number, default 250, at most 500.',
          },
          sinceDays: {
            type: 'number',
            description: 'Optional browser_history lookback window in whole days; omit for no window.',
          },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter(),
        },
        required: [],
        additionalProperties: false,
      },
      // This call only routes the ingest to the daemon's knowledge capability (a nested capability_run call, judged by
      // that capability's own risk); its path checks hold here first. Classed a read: the capability's question is the
      // only one.
      sideEffects: ['state'],
      category: 'read',
    },
    execute: async (rawArgs, options) => {
      let request: AgentKnowledgeIngestRequest;
      const args = captureStrictJudgmentJson(rawArgs) as AgentKnowledgeIngestToolArgs;
      try { request = requestForArgs(args); }
      catch (error) { return failure(error instanceof Error ? error.message : 'Agent Knowledge ingest input is invalid.'); }
      let call: IngestCall;
      try { call = capabilityFor(request, shellPaths, readString(args.sourceKind) || 'url', args); }
      catch (error) { return failure(error instanceof IngestArgumentError ? error.message : `The file could not be read: ${error instanceof Error ? error.message : String(error)}`); }
      options?.signal?.throwIfAborted();
      if (!assertCurrentToolInvocation(rawArgs, options)) {
        return failure(`${preview(request)}\n\nNothing was ingested: it runs only as an admitted tool call.`);
      }
      let inputs = call.inputs;
      if (call.upload) {
        // The file's bytes go up by the command line's upload (the daemon's artifact upload), then the daemon's
        // knowledge.ingest-artifact adds that artifact: its question is the one asked.
        try {
          const connection = resolveConnectedHostConnection({ configManager, homeDirectory: shellPaths.homeDirectory, ...(inProcess ? { inProcess } : {}) });
          if (connection.unavailable) return failure(`Nothing was ingested: ${connection.unavailable.reason}`);
          const uploaded = await postAgentKnowledgeUpload<{ artifact?: { id?: unknown } }>(connection, '/api/artifacts',
            { bytes: call.upload.bytes, filename: call.upload.name }, { kind: 'document', metadata: { purpose: 'knowledge-ingest', originSurface: 'agent_knowledge_ingest' } },
            options?.signal ? { signal: options.signal } : {});
          const artifactId = typeof uploaded.artifact?.id === 'string' ? uploaded.artifact.id : undefined;
          if (!artifactId) return failure('Nothing was ingested: the daemon did not say which artifact it kept the file as.');
          inputs = { ...inputs, artifact: artifactId };
        } catch (error) {
          return failure(`Nothing was ingested: the file could not be uploaded to the daemon (${error instanceof Error ? error.message : String(error)}).`);
        }
      }
      const answer = await runCapability(call.id, inputs, options);
      if (!answer.ok) return failure(answer.error);
      return output([answer.text || `${call.id}: done.`, ...(request.notes ?? [])].join('\n'));
    },
  };
}

/**
 * Read a workspace file once, bounded; these bytes are what the daemon adds. `path` is already fully resolved inside
 * the workspace, but a link can be put in place of it (or of a directory above it) between that check and this open.
 * So the open refuses a final-component link, and the opened file must be the one the path names inside the workspace
 * now: one realpath and one stat more, no extra read.
 */
function readIngestFile(shellPaths: ShellPathService, path: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new IngestArgumentError('Nothing was ingested: a link was put in place of the file while it was being opened. Check the path and call again.');
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new IngestArgumentError('The path must name a regular file, not a directory.');
    const current = workspacePath(shellPaths, path, 'path');
    const named = statSync(current);
    if (named.dev !== stat.dev || named.ino !== stat.ino) {
      throw new IngestArgumentError('Nothing was ingested: the file changed while it was being opened (it was replaced or a link was put in its place). Check the path and call again.');
    }
    if (stat.size > MAX_KNOWLEDGE_INGEST_FILE_BYTES) throw new IngestArgumentError(TOO_LARGE_TO_SEND);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** A file's bytes as a capability input: its text when it is UTF-8, else base64. */
function contentOf(bytes: Buffer): { readonly content: string; readonly encoding: 'text' | 'base64' } {
  try {
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'text' };
  } catch {
    return { content: bytes.toString('base64'), encoding: 'base64' };
  }
}

/**
 * The daemon's knowledge capability one ingest runs, and its inputs. A file the turn names is read here, on this
 * program's own machine, inside the workspace, and its content is sent: the daemon may be on another machine, and it
 * reads by path only what is on its own machine and was named by a caller there. A browser profile home of the
 * model's choosing is not taken: the daemon reads the owner's own browsers, and that import is the owner's own act.
 */
interface IngestCall {
  readonly id: string;
  readonly inputs: Record<string, string>;
  /** A file too large for a method call's body: uploaded first (its artifact id fills `inputs.artifact`). */
  readonly upload?: { readonly bytes: Buffer; readonly name: string } | undefined;
}

function capabilityFor(request: AgentKnowledgeIngestRequest, shellPaths: ShellPathService, sourceKind: string, args: AgentKnowledgeIngestToolArgs): IngestCall {
  const payload = request.payload;
  const text = (value: unknown): string | undefined => readOptionalString(value);
  const tags = (): string | undefined => { const list = readStringList(args.tags); return list.length > 0 ? list.join(', ') : undefined; };
  const kept = (inputs: Record<string, string | undefined>): Record<string, string> => Object.fromEntries(Object.entries(inputs).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
  const path = (): string => workspacePath(shellPaths, readString(payload.path), 'path');
  if (sourceKind === 'url') return { id: 'knowledge.ingest-url', inputs: kept({ url: text(payload.url), title: text(payload.title), tags: tags(), folder: text(payload.folderPath) }) };
  if (sourceKind === 'file') {
    const resolved = path();
    const bytes = readIngestFile(shellPaths, resolved);
    // Larger than a method call's body takes: uploaded as the command line uploads it, then added as that artifact.
    if (bytes.length > MAX_SENT_FILE_BYTES) {
      return { id: 'knowledge.ingest-artifact', inputs: kept({ title: text(payload.title) ?? basename(resolved), tags: tags(), folder: text(payload.folderPath) }),
        upload: { bytes, name: basename(resolved) } };
    }
    const file = { ...contentOf(bytes), name: basename(resolved) };
    return { id: 'knowledge.ingest-file', inputs: kept({ content: file.content, encoding: file.encoding, name: file.name, title: text(payload.title), tags: tags(), folder: text(payload.folderPath) }) };
  }
  if (sourceKind === 'artifact') return { id: 'knowledge.ingest-artifact', inputs: kept({ artifact: text(payload.artifactId), title: text(payload.title), tags: tags(), folder: text(payload.folderPath) }) };
  // A list of addresses or a bookmarks file is text: sent as its text.
  if (sourceKind === 'urls_file') return { id: 'knowledge.import-urls', inputs: { content: new TextDecoder().decode(readIngestFile(shellPaths, path())) } };
  if (sourceKind === 'bookmarks_file') return { id: 'knowledge.import-bookmarks', inputs: { content: new TextDecoder().decode(readIngestFile(shellPaths, path())) } };
  if (sourceKind === 'browser_history') {
    if (text(payload.homeOverride)) throw new IngestArgumentError('Nothing was imported: homeOverride is not taken; the daemon reads the owner\'s own browsers. Omit it.');
    const kinds = readStringList(args.sourceKinds);
    const since = readSinceWindowMs(args.sinceDays);
    return { id: 'knowledge.import-browser-history', inputs: kept({
      browsers: readStringList(args.browsers).join(', ') || undefined,
      sources: kinds.length === 1 ? kinds[0] : undefined,
      limit: typeof payload.limit === 'number' ? String(payload.limit) : undefined,
      days: since === undefined ? undefined : String(Math.round(since / 86_400_000)),
    }) };
  }
  const input = payload.input;
  // A connector's file is read here and sent as the text it reads, when no text or input was given with it.
  const fileText = text(payload.path) && input === undefined && !text(payload.content) ? new TextDecoder().decode(readIngestFile(shellPaths, path())) : undefined;
  return { id: 'knowledge.ingest-connector', inputs: kept({
    connector: text(payload.connectorId),
    input: input === undefined ? undefined : typeof input === 'string' ? input : JSON.stringify(input),
    content: text(payload.content) ?? fileText,
  }) };
}

export function registerAgentKnowledgeIngestTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  inProcess?: AgentInProcessHost | undefined,
): void {
  registry.register(createAgentKnowledgeIngestTool(shellPaths, configManager, inProcess), {
    inputProjection: createAgentKnowledgeIngestInputProjector(shellPaths),
  });
}
