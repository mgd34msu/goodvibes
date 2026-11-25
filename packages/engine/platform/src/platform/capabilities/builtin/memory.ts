/**
 * "See what memory a task would be given", worked out by the daemon from the
 * one memory store every program reads (`~/.goodvibes/shared/memory.sqlite`).
 */
import type { MemoryApi } from '../../knowledge/knowledge-api.js';
import type { CapabilityDefinition } from '../types.js';

export interface MemoryCapabilityServices {
  readonly memory: Pick<MemoryApi, 'explain'>;
}

export const MEMORY_EXPLAIN: CapabilityDefinition<MemoryCapabilityServices> = {
  capability: { id: 'memory.explain', group: 'memory', home: 'daemon', repeat: 'safe' },
  actionId: 'explain', label: 'See what memory a task would be given', word: 'explain',
  inputs: [
    { id: 'task', label: 'Task', help: 'The task, the way you would ask for it', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } },
    { id: 'paths', label: 'Files it would change', help: 'Paths the task would write, separated by commas', kind: 'path', freeTextReason: 'a path in this project', required: { default: '', defaultMeans: 'any' }, typed: { flag: '--scope', repeats: true } },
  ],
  sentence: 'Shows the reviewed memory that would be given to "{task}", and why.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { task: 'add a login page' },
  async run(values, services) {
    const paths = (values.paths ?? '').split('\n').flatMap((entry) => entry.split(',')).map((path) => path.trim()).filter(Boolean);
    const explanation = await services.memory.explain(values.task!, paths);
    const ids = explanation.injections.map((injection) => injection.id);
    if (explanation.injections.length === 0) return { text: 'No reviewed project memory would be given to that task.', data: { records: [] } };
    return { text: explanation.prompt ?? 'No reviewed project memory would be given to that task.', data: { records: ids } };
  },
};
