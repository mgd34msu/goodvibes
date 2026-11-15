/**
 * A sub-agent's base prompt describes the tools it has, its output contract
 * defines the fields its brief names, and its conventions come from the same
 * instruction files as the foreground session's. Its compaction keeps the task
 * and says plainly that messages were dropped, and its knowledge query is the
 * head of a long brief, not the whole of it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildOrchestratorSystemPrompt } from '../platform/src/platform/agents/orchestrator-prompts.js';
import { compactAgentConversation } from '../platform/src/platform/agents/orchestrator-utils.js';
import { deriveTurnKnowledgeQuery, KNOWLEDGE_QUERY_MAX_CHARS } from '../platform/src/platform/agents/turn-knowledge-injection.js';
import { selfBoundedCallDeadline } from '../platform/src/platform/agents/tool-call-liveness.js';
import type { AgentRecord } from '../platform/src/platform/tools/agent/manager.js';
import type { ProviderMessage } from '../platform/src/platform/providers/interface.js';

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'agent-1', task: 'Review the parser', template: 'researcher', tools: ['read', 'find', 'analyze', 'inspect'],
    status: 'running', startedAt: 0, toolCallCount: 0, orchestrationDepth: 0, executionProtocol: 'direct',
    reviewMode: 'none', communicationLane: 'parent-only', ...overrides,
  } as AgentRecord;
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('base prompt by tool set', () => {
  test('a read-only researcher is not given rules for tools it lacks or an engineer report to fill in', () => {
    const prompt = buildOrchestratorSystemPrompt(record());
    for (const absent of ['Validate after changes', 'state tool (mode: memory)', 'context7', '"archetype": "engineer"', '"archetype": "tester"', '"coverage"', 'No mocks']) {
      expect(prompt).not.toContain(absent);
    }
    expect(prompt).toContain('"archetype": "researcher"');
  });

  test('an engineer that can edit, run commands and keep memory keeps those rules', () => {
    const prompt = buildOrchestratorSystemPrompt(record({ template: 'engineer', tools: ['read', 'write', 'edit', 'exec', 'state'] }));
    for (const present of ['Validate after changes', 'state tool (mode: memory)', '"archetype": "engineer"', 'Write-local, read-global']) {
      expect(prompt).toContain(present);
    }
  });

  test('a contract unit is told what finalAnswer is and is not held to a two-line summary', () => {
    const prompt = buildOrchestratorSystemPrompt(record({ contractUnitId: 'u1' }));
    expect(prompt).toContain('"finalAnswer"');
    expect(prompt).not.toContain('When complete, report only');
  });

  test('conventions load the nearest AGENTS.md before the project GOODVIBES.md, like the foreground loader', () => {
    const root = mkdtempSync(join(tmpdir(), 'prompt-conventions-')); roots.push(root);
    const project = join(root, 'project');
    mkdirSync(join(project, '.goodvibes'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'Run the scoped test file only.');
    writeFileSync(join(project, '.goodvibes', 'GOODVIBES.md'), 'Prefer small diffs.');
    const prompt = buildOrchestratorSystemPrompt(record(), undefined, { workingDirectory: project });
    expect(prompt).toContain('Run the scoped test file only.');
    expect(prompt.indexOf('Run the scoped test file only.')).toBeLessThan(prompt.indexOf('Prefer small diffs.'));
  });
});

describe('sub-agent compaction', () => {
  test('the task survives compaction and the notice says messages were dropped, not summarised', () => {
    const task = 'Review src/parser.ts against criteria c1 and c2.';
    const messages: ProviderMessage[] = [{ role: 'user', content: task }];
    for (let index = 0; index < 20; index++) {
      messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${index}`, name: 'read', arguments: {} }] });
      messages.push({ role: 'tool', callId: `c${index}`, content: `result ${index}` });
    }
    const compacted = compactAgentConversation(messages, 10, task);
    expect(compacted[0]).toEqual({ role: 'user', content: task });
    const notice = String(compacted[1]?.content);
    expect(notice).toContain('dropped, not summarised');
    expect(notice).toContain('re-read');
    expect(compacted.slice(2)).toEqual(messages.slice(-10));
    // A second compaction keeps the same task and one notice.
    const again = compactAgentConversation([...compacted, ...messages.slice(1, 9)], 6, task);
    expect(again[0]).toEqual({ role: 'user', content: task });
    expect(again.filter((message) => String(message.content).includes('dropped, not summarised'))).toHaveLength(1);
  });
});

describe('knowledge query', () => {
  test('a long brief contributes only its opening sections to the query', () => {
    const brief = ['Contract goal: review the daemon', 'Your unit: u4 "daemon"', 'Acceptance criteria: c1',
      'Native review inventory for this unit:\n' + JSON.stringify({ assignedFiles: Array.from({ length: 20_000 }, (_, i) => `src/file-${i}.ts`) })].join('\n\n');
    const query = deriveTurnKnowledgeQuery(brief, [{ role: 'user', content: brief }]);
    expect(query.length).toBeLessThanOrEqual(KNOWLEDGE_QUERY_MAX_CHARS);
    expect(query).toContain('Contract goal: review the daemon');
    expect(query).not.toContain('file-19999');
  });
});

describe('tool-call liveness', () => {
  test('an exec command keeps its agent alive until its own deadline; other tools do not', () => {
    expect(selfBoundedCallDeadline('find', { queries: [] }, 0)).toBeUndefined();
    expect(selfBoundedCallDeadline('exec', { commands: [{ cmd: 'bun test' }] }, 0)).toBe(Number.POSITIVE_INFINITY);
    const bounded = selfBoundedCallDeadline('exec', { commands: [{ cmd: 'bun test', timeout_ms: 900_000 }] }, 1_000);
    expect(bounded).toBeGreaterThan(1_000 + 900_000);
    expect(bounded).toBeLessThan(1_000 + 900_000 + 120_000);
  });
});
