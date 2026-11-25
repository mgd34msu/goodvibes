/**
 * ONE knowledge store: the daemon's (the wiki, `knowledge-wiki.sqlite`). The
 * Agent kept a second one, "Agent Knowledge" (`knowledge-agent.sqlite`), in two
 * places: the one its own program wrote (`~/.goodvibes/agent/`) and the one the
 * daemon served the Agent's routes from (beside the daemon's store). At the
 * daemon's first start of this version everything each holds is carried into
 * the daemon's store once: every source, extraction, entry, link and issue the
 * daemon's store does not already have (an id it has is left as it is there).
 * Nothing is dropped and the Agent's files are left exactly as they were, so a
 * rollback to 3.5.0 still reads them. A carry that fails is said in the log and
 * tried again at the next start; one that ran is recorded beside the store, by
 * the file it carried, with what it carried, and never runs again for it.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { KnowledgeStore } from './store.js';
import { logger } from '../utils/logger.js';

/** The record of the carries, beside the daemon's store. */
export const AGENT_KNOWLEDGE_CARRY_RECORD = 'agent-knowledge-carried.json';

export interface AgentKnowledgeCarryResult {
  readonly carriedAt: number;
  readonly sources: number;
  readonly extractions: number;
  readonly entries: number;
  readonly links: number;
  readonly issues: number;
  /** Already in the daemon's store (same id), left as they are there. */
  readonly alreadyThere: number;
}

/** What was carried, by the file it was carried from. */
export type AgentKnowledgeCarryRecord = Readonly<Record<string, AgentKnowledgeCarryResult>>;

const ALL = Number.MAX_SAFE_INTEGER;

function recordPathOf(to: Pick<KnowledgeStore, 'storagePath'>): string {
  return join(dirname(to.storagePath), AGENT_KNOWLEDGE_CARRY_RECORD);
}

/** The record of the carries that ran (empty when none did). */
export function readAgentKnowledgeCarry(to: Pick<KnowledgeStore, 'storagePath'>): AgentKnowledgeCarryRecord {
  const path = recordPathOf(to);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AgentKnowledgeCarryRecord : {};
  } catch {
    return {};
  }
}

/**
 * Carry one Agent knowledge store into the daemon's, once (undefined when it was carried already). `recordedAs`: the
 * file the store was copied from, when it is a copy (the record names the real file).
 */
export async function carryAgentKnowledgeOnce(from: KnowledgeStore, to: KnowledgeStore, recordedAs?: string): Promise<AgentKnowledgeCarryResult | undefined> {
  if (from === to || resolve(from.storagePath) === resolve(to.storagePath)) return undefined;
  await to.init();
  const key = recordedAs ?? resolve(from.storagePath);
  const record = readAgentKnowledgeCarry(to);
  if (record[key]) return undefined;
  await from.init();
  const sources = [...from.iterateSources()];
  const extractions = from.listExtractions(ALL);
  const nodes = [...from.iterateNodes()];
  const edges = from.listEdges();
  const issues = from.listIssues(ALL);
  const newSources = sources.filter((source) => !to.getSource(source.id));
  const newExtractions = extractions.filter((extraction) => !to.getExtraction(extraction.id));
  const newNodes = nodes.filter((node) => !to.getNode(node.id));
  const newEdges = edges.filter((edge) => !to.findEdge(edge));
  const newIssues = issues.filter((issue) => !to.getIssue(issue.id));
  const alreadyThere = (sources.length - newSources.length) + (extractions.length - newExtractions.length) + (nodes.length - newNodes.length)
    + (edges.length - newEdges.length) + (issues.length - newIssues.length);
  if (newSources.length + newExtractions.length + newNodes.length + newEdges.length + newIssues.length > 0) {
    // The records are the upsert inputs with their stored ids and facts; one all-or-none commit.
    await to.applyImport({ sources: newSources, extractions: newExtractions, nodes: newNodes, edges: newEdges, issues: newIssues });
  }
  const result: AgentKnowledgeCarryResult = {
    carriedAt: Date.now(), sources: newSources.length, extractions: newExtractions.length, entries: newNodes.length,
    links: newEdges.length, issues: newIssues.length, alreadyThere,
  };
  writeFileSync(recordPathOf(to), `${JSON.stringify({ ...readAgentKnowledgeCarry(to), [key]: result }, null, 2)}\n`, 'utf-8');
  return result;
}

/**
 * The carries at the daemon's start, off the start path: the daemon's own Agent store (`daemonAgentStore`), then
 * the Agent program's file (`agentProgramFile`, opened only to read it and closed after) when it is there. Each
 * outcome is in the log; a failure is tried again at the next start.
 */
export function startAgentKnowledgeCarry(daemonAgentStore: KnowledgeStore, to: KnowledgeStore, agentProgramFile: string | undefined): void {
  const carry = async (from: KnowledgeStore, what: string, recordedAs?: string): Promise<void> => {
    try {
      const result = await carryAgentKnowledgeOnce(from, to, recordedAs);
      if (result) logger.info(`[knowledge] ${what} was carried into the daemon's knowledge once`, { ...result });
    } catch (error) {
      logger.error(`[knowledge] ${what} could not be carried into the daemon's knowledge; it is tried again at the next start, and its file is unchanged`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  void (async () => {
    await carry(daemonAgentStore, 'The Agent knowledge the daemon kept');
    if (!agentProgramFile || !existsSync(agentProgramFile) || resolve(agentProgramFile) === resolve(daemonAgentStore.storagePath)) return;
    if (readAgentKnowledgeCarry(to)[resolve(agentProgramFile)]) return;
    // Read from a copy: opening a store may bring its file up to this version's layout, and the Agent's file must stay
    // exactly as a 3.5.0 binary wrote it.
    const copyDir = mkdtempSync(join(tmpdir(), 'goodvibes-agent-knowledge-'));
    const copy = join(copyDir, basename(agentProgramFile));
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${agentProgramFile}${suffix}`)) copyFileSync(`${agentProgramFile}${suffix}`, `${copy}${suffix}`);
    const program = KnowledgeStore.forFamily({ dbPath: copy, family: 'agent' });
    try {
      await carry(program, 'The Agent\'s own knowledge', resolve(agentProgramFile));
    } finally {
      await program.close().catch(() => undefined);
      rmSync(copyDir, { recursive: true, force: true });
    }
  })();
}
