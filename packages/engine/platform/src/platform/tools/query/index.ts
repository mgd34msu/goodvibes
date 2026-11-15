import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Tool } from '../../types/tools.js';
import { resolveScopedDirectory } from '../../runtime/surface-root.js';
import { defineLifecycle } from '../../utils/lifecycle-machine.js';
import { writeFileAtomic } from '../../utils/atomic-json-store.js';
import { summarizeError } from '../../utils/error-display.js';
import { QUERY_TOOL_SCHEMA, type QueryToolInput } from './schema.js';

interface QueryRecord {
  readonly id: string;
  readonly prompt: string;
  readonly askedBy?: string | undefined;
  readonly target?: string | undefined;
  readonly answer?: string | undefined;
  readonly resolution?: string | undefined;
  readonly status: 'open' | 'answered' | 'closed';
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A query is asked (open), may be answered (and its answer revised), and is closed for good; a closed query is never reopened. */
const queryLifecycle = defineLifecycle<QueryRecord['status']>('query', {
  open: ['answered', 'closed'],
  answered: ['answered', 'closed'],
  closed: [],
});

function summarizeQuery(record: QueryRecord) {
  return {
    id: record.id,
    prompt: record.prompt,
    askedBy: record.askedBy,
    target: record.target,
    status: record.status,
    hasAnswer: typeof record.answer === 'string' && record.answer.length > 0,
    hasResolution: typeof record.resolution === 'string' && record.resolution.length > 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createQueryTool(
  options: string | { readonly workingDirectory: string; readonly surfaceRoot?: string },
): Tool {
  const workingDirectory = typeof options === 'string' ? options : options.workingDirectory;
  const surfaceRoot = typeof options === 'string' ? undefined : options.surfaceRoot;
  const workspaceRoot = resolve(workingDirectory);
  const queriesDir = resolveScopedDirectory(workspaceRoot, surfaceRoot);
  const queriesPath = join(queriesDir, 'queries.json');

  // Only a missing file is an empty store. An unreadable or malformed file must
  // fail the call: treating it as empty would let the next write replace every record.
  function loadQueries(): QueryRecord[] {
    let raw: string;
    try {
      raw = readFileSync(queriesPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Cannot read ${queriesPath}: ${summarizeError(err)}. Nothing was changed.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${queriesPath} is not valid JSON (${summarizeError(err)}). Nothing was changed; repair or move the file aside.`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${queriesPath} does not hold a list of querys. Nothing was changed; repair or move the file aside.`);
    return parsed as QueryRecord[];
  }

  function saveQueries(records: readonly QueryRecord[]): void {
    mkdirSync(queriesDir, { recursive: true });
    writeFileAtomic(queriesPath, `${JSON.stringify(records, null, 2)}\n`);
  }

  return {
    definition: {
      name: 'query',
      description: 'Keep your own notes on questions, answers, and closure. Queries are stored in a file; asking one does not deliver it to an operator or any surface, and the answer is whatever you record.',
      parameters: QUERY_TOOL_SCHEMA.parameters,
      sideEffects: ['workflow', 'state'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as unknown as QueryToolInput;
      let records: QueryRecord[];
      try {
        records = loadQueries();
      } catch (err) {
        return { success: false, error: summarizeError(err) };
      }
      const view = input.view ?? 'summary';

      if (input.mode === 'ask') {
        if (!input.queryId || !input.prompt) {
          return { success: false, error: 'ask requires queryId and prompt.' };
        }
        const existing = records.find((entry) => entry.id === input.queryId);
        if (existing) {
          return {
            success: false,
            error: `Query ${existing.id} already exists (status ${existing.status}); ask would replace it. Use show to read it, answer or close to change it, or choose a new queryId.`,
          };
        }
        const now = Date.now();
        const record: QueryRecord = {
          id: input.queryId,
          prompt: input.prompt,
          ...(input.askedBy ? { askedBy: input.askedBy } : {}),
          ...(input.target ? { target: input.target } : {}),
          status: 'open',
          createdAt: now,
          updatedAt: now,
        };
        saveQueries([...records, record]);
        return { success: true, output: JSON.stringify(record) };
      }

      if (input.mode === 'list') {
        return {
          success: true,
          output: JSON.stringify({
            view,
            count: records.length,
            queries: view === 'full' ? records : records.map(summarizeQuery),
          }),
        };
      }

      const record = records.find((entry) => entry.id === input.queryId);
      if (!record) return { success: false, error: `Unknown query: ${input.queryId ?? '(missing)'}` };

      if (input.mode === 'show') {
        return { success: true, output: JSON.stringify(view === 'full' ? record : summarizeQuery(record)) };
      }

      if (input.mode === 'answer') {
        if (!input.answer) return { success: false, error: 'answer requires answer text.' };
        const move = queryLifecycle.check(record.status, 'answered');
        if (!move.ok) return { success: false, error: move.reason };
        const next: QueryRecord = {
          ...record,
          answer: input.answer,
          status: 'answered',
          updatedAt: Date.now(),
        };
        saveQueries(records.map((entry) => (entry.id === next.id ? next : entry)));
        return { success: true, output: JSON.stringify(next) };
      }

      if (input.mode === 'close') {
        const move = queryLifecycle.check(record.status, 'closed');
        if (!move.ok) return { success: false, error: move.reason };
        const next: QueryRecord = {
          ...record,
          ...(input.resolution ? { resolution: input.resolution } : {}),
          status: 'closed',
          updatedAt: Date.now(),
        };
        saveQueries(records.map((entry) => (entry.id === next.id ? next : entry)));
        return { success: true, output: JSON.stringify(next) };
      }

      return { success: false, error: `Unknown mode: ${input.mode}` };
    },
  };
}
