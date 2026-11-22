import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { resolveScopedDirectory } from '../runtime/surface-root.js';
import type { ReadAccessFilter } from '../tools/shared/read-access.js';
import { logger } from '../utils/logger.js';

/** Where and how an agent's saved journal is read. */
export interface AgentJournalReadInput {
  readonly projectRoot: string;
  readonly surfaceRoot?: string | undefined;
  readonly agentId: string;
  readonly readAccessFilter?: ReadAccessFilter | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => void;
  /**
   * Called when a journal exists but cannot be read (a malformed line, a changed or redirected file), so the
   * caller can say "unreadable" instead of "no history". An absent journal is not reported.
   */
  readonly onUnreadable?: ((reason: string) => void) | undefined;
}

/** Read saved observations without constructing an agent or restoring authority. */
export async function readAgentSessionHistory(input: AgentJournalReadInput): Promise<Record<string, unknown> | undefined> {
  const { agentId } = input;
  const unreadable = (reason: string): undefined => {
    logger.warn('Agent session history is unreadable', { agentId, reason });
    input.onUnreadable?.(reason);
    return undefined;
  };
  const text = await readAgentJournalText(input);
  if (text === undefined) return undefined;
  try {
    let metadataMatches = false, sawMetadata = false, saved: Record<string, unknown> | undefined;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) return unreadable('a line of the saved journal is not a JSON object');
      const entry = row as Record<string, unknown>;
      if (entry.type === 'meta') { metadataMatches = entry.agentId === agentId; sawMetadata ||= metadataMatches; saved = undefined; }
      if (entry.type !== 'agent_conversation') continue;
      if (!metadataMatches || entry.agentId !== agentId || entry.version !== 1 || !Array.isArray(entry.messages)
        || !Array.isArray(entry.archive) || !entry.messages.every((message: unknown) => message && typeof message === 'object'
          && 'role' in message && typeof message.role === 'string' && ['user', 'assistant', 'tool', 'system'].includes(message.role))) return unreadable('the saved conversation entry is malformed');
      saved = entry;
    }
    input.signal?.throwIfAborted(); input.assertCurrent();
    // The run started a journal but its final conversation entry is not in it: the run is still going in
    // another process, or the entry could not be written (a full disk, a permission error). Either way the
    // history is incomplete, which is not the same as "this agent never ran".
    if (!saved && sawMetadata) return unreadable('the journal is incomplete: it has no saved conversation for this run (the run has not finished, or its last entries could not be written)');
    return saved ? { ...saved, kind: 'historical-agent-conversation', executionActive: false,
      meaning: 'Saved worker observations, not a live agent, new execution, current permission or completion approval. Preserve original scopes, versions and source roles.' } : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return unreadable('the saved journal contains a line that is not valid JSON');
    throw error;
  }
}

/**
 * The text of an agent's saved journal (`sessions/agents/<agentId>.jsonl` under the surface), read only when
 * every component of its path is this surface's own (no link, no replaced directory) and the file did not
 * change while it was read; undefined when there is none or it cannot be read (`onUnreadable` says why).
 */
export async function readAgentJournalText(input: AgentJournalReadInput): Promise<string | undefined> {
  const { projectRoot, surfaceRoot, agentId, readAccessFilter, signal, assertCurrent } = input;
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) return undefined;
  const current = () => {
    signal?.throwIfAborted(); assertCurrent();
    if (input.projectRoot !== projectRoot || input.surfaceRoot !== surfaceRoot || input.agentId !== agentId
      || input.readAccessFilter !== readAccessFilter || input.signal !== signal || input.assertCurrent !== assertCurrent)
      throw new Error('Historical worker lookup source changed');
  };
  current();
  const unreadable = (reason: string): undefined => {
    logger.warn('Agent session history is unreadable', { agentId, reason });
    input.onUnreadable?.(reason);
    return undefined;
  };
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const root = await realpath(projectRoot);
    const path = resolve(resolveScopedDirectory(root, surfaceRoot, 'sessions', 'agents'), `${agentId}.jsonl`);
    // Every component belongs to this surface; neither a journal symlink nor
    // a redirected directory may turn history lookup into an unrelated read.
    const parts = relative(root, path).split(sep);
    const directories = new Map<string, { dev: bigint; ino: bigint }>();
    let parent = root;
    for (const part of parts) {
      parent = join(parent, part);
      const entry = await lstat(parent, { bigint: true });
      current();
      if (entry.isSymbolicLink() || (parent === path ? !entry.isFile() : !entry.isDirectory())) return unreadable('a path to the saved journal is a link or not the expected kind of entry');
      if (parent !== path) directories.set(parent, { dev: entry.dev, ino: entry.ino });
    }
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat({ bigint: true });
    current();
    if (readAccessFilter && !await readAccessFilter(path)) return undefined;
    current();
    for (const [directory, expected] of directories) {
      const actual = await lstat(directory, { bigint: true }); current();
      if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino) return unreadable('a directory on the path to the saved journal was replaced while it was read');
    }
    const admitted = await lstat(path, { bigint: true });
    current();
    if (before.nlink !== 1n || !admitted.isFile() || admitted.isSymbolicLink()
      || before.dev !== admitted.dev || before.ino !== admitted.ino || before.ctimeNs !== admitted.ctimeNs) return unreadable('the saved journal changed while it was read');
    const bytes = await file.readFile({ signal });
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) return unreadable('the saved journal is not valid UTF-8');
    const after = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    current();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.dev !== named.dev || after.ino !== named.ino || after.ctimeNs !== named.ctimeNs) return unreadable('the saved journal changed while it was read');
    return text;
  } catch (error) {
    current();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally { await file?.close(); }
}

/** What one agent did, read from its saved journal: the files it read and changed, the commands it ran, and its last report. */
export interface AgentJournalActivity {
  readonly agentId: string;
  readonly task?: string | undefined;
  readonly template?: string | undefined;
  /** Each file it read, with how: `whole`, `lines a-b` (each range read), or the extract mode it asked for. */
  readonly read: Readonly<Record<string, string>>;
  /** Each file a write or edit of it changed. */
  readonly changed: readonly string[];
  readonly commandsRun: number;
  /** Its last reply as saved when its run ended; absent when the run did not end in this journal (cut off). */
  readonly report?: string | undefined;
  /** True when the journal has no end-of-run entry: the run was cut off (a crash, a kill) or is still going. */
  readonly cutOff: boolean;
}

const REPORT_CHARS = 1_500;
const READ_TOOLS: ReadonlySet<string> = new Set(['read']);
const CHANGE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('');
  return '';
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { return objectOf(JSON.parse(value)); } catch { return undefined; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * What an agent read, changed and reported, from its saved journal's tool rows (successful calls only) and its
 * end-of-run conversation entry. Undefined when it has no journal. A journal that cannot be read is reported
 * through `onUnreadable`. Cost: one read of the journal file, a few hundred kilobytes for a typical run.
 */
export async function readAgentJournalActivity(input: AgentJournalReadInput): Promise<AgentJournalActivity | undefined> {
  const text = await readAgentJournalText(input);
  if (text === undefined) return undefined;
  const reads = new Map<string, string[]>();
  const changed = new Set<string>();
  let commandsRun = 0, task: string | undefined, template: string | undefined, report: string | undefined, ended = false;
  const noteRead = (path: string, how: string): void => {
    const ways = reads.get(path) ?? [];
    if (!ways.includes(how)) ways.push(how);
    reads.set(path, ways);
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown> | undefined;
    try { row = objectOf(JSON.parse(line)); } catch { continue; }
    if (!row) continue;
    if (row.type === 'session_config') {
      if (typeof row.task === 'string') task = row.task.slice(0, 300);
      if (typeof row.template === 'string') template = row.template;
      continue;
    }
    if (row.type === 'agent_conversation' && Array.isArray(row.messages)) {
      ended = true;
      const last = [...row.messages].reverse().find((message) => objectOf(message)?.role === 'assistant' && textOf(objectOf(message)?.content).trim());
      const said = textOf(objectOf(last)?.content).trim();
      if (said) report = said.length > REPORT_CHARS ? `${said.slice(0, REPORT_CHARS)}...` : said;
      continue;
    }
    if (row.type !== 'tool_execution' || (row.success !== true && row.success !== 'true')) continue;
    const tool = typeof row.toolName === 'string' ? row.toolName : '';
    const args = objectOf(row.args);
    if (tool === 'exec') { commandsRun += 1; continue; }
    if (!args) continue;
    if (READ_TOOLS.has(tool) && Array.isArray(args.files)) {
      for (const entry of args.files) {
        const file = objectOf(entry);
        if (!file || typeof file.path !== 'string') continue;
        const extract = typeof file.extract === 'string' ? file.extract : typeof args.extract === 'string' ? args.extract : 'content';
        const range = objectOf(file.range);
        noteRead(file.path, extract === 'lines' && range ? `lines ${String(range.start)}-${String(range.end)}` : extract === 'content' ? 'whole' : extract);
      }
      continue;
    }
    if (CHANGE_TOOLS.has(tool)) {
      for (const list of [args.files, args.edits]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          const path = objectOf(entry)?.path;
          if (typeof path === 'string') changed.add(path);
        }
      }
      if (typeof args.path === 'string') changed.add(args.path);
    }
  }
  return {
    agentId: input.agentId,
    ...(task === undefined ? {} : { task }),
    ...(template === undefined ? {} : { template }),
    read: Object.fromEntries([...reads].map(([path, ways]) => [path, ways.includes('whole') ? 'whole' : ways.join(', ')])),
    changed: [...changed],
    commandsRun,
    ...(report === undefined ? {} : { report }),
    cutOff: !ended,
  };
}
