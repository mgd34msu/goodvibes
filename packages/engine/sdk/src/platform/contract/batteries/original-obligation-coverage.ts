import { defineBattery, yesNo } from '@goodvibes-jev/judgment';
import type { ContractAcceptanceStakes } from '../config.js';
import type { ContractView } from '../types.js';
import { UNIT_JUDGE_BANDS } from './unit-judge.js';

const TITLE_SEARCH_FILES = {
  'search.ts': [
    'export function searchTitles(rows: readonly { id: number; title: string }[], query: string) {',
    '  const term = query.trim().toLowerCase();',
    '  return rows.filter(row => row.title.toLowerCase().includes(term));',
    '}',
  ].join('\n') + '\n',
  'search.test.ts': [
    "import { expect, test } from 'bun:test';",
    "import { searchTitles } from './search.js';",
    'const rows = [',
    "  { id: 1, title: 'TypeScript guide', description: 'Language fundamentals' },",
    "  { id: 2, title: 'Bread notes', description: 'TypeScript examples' },",
    "  { id: 3, title: 'Rust book', description: 'Sourdough recipes' },",
    '];',
    "test('matches title substrings', () => expect(searchTitles(rows, 'guide').map(row => row.id)).toEqual([1]));",
    "test('ignores title case', () => expect(searchTitles(rows, 'TYPESCRIPT').map(row => row.id)).toEqual([1]));",
    "test('does not search descriptions', () => expect(searchTitles(rows, 'sourdough')).toEqual([]));",
    "test('returns no unrelated titles', () => expect(searchTitles(rows, 'missing')).toEqual([]));",
  ].join('\n') + '\n',
};

function titleSearchEvidence() {
  const content = Object.entries(TITLE_SEARCH_FILES).map(([path, text]) => {
    const lines = text.trimEnd().split('\n');
    return [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`)].join('\n');
  }).join('\n') + '\n';
  return { stagedArtifact: { path: 'title-search.patch', format: 'git-diff', content },
    hostExecution: { command: 'bun test search.test.ts', exitCode: 0,
      completion: { kind: 'assertions', checks: { passed: 4, failed: 0, skipped: 0 } } } };
}

/** Select original obligations in code; derived plan labels cannot replace them. */
export function originalObligationSource(contract: Pick<ContractView, 'ask' | 'nativeSource' | 'originalSource'>) {
  const source = contract.nativeSource ?? contract.originalSource;
  return {
    origin: contract.nativeSource ? 'native-source' : source ? 'original-source' : 'original-request',
    goal: source?.goal ?? contract.ask,
    criteria: [...(source?.criteria ?? [])],
  };
}

function originalObligationCoverage(name: string, stakes: ContractAcceptanceStakes) {
  return defineBattery({
    name, version: 2, accuracyFloor: 0.95,
    description: 'Checks the staged deliverable against the complete authoritative original obligations, independently of its assigned plan goal.',
    items: {
      original_obligations_unmet: yesNo(
        'Before the host performs `hostStages`, is any substantive obligation in `original` unmet or unsupported by the staged result and actual evidence? Exclude only this result\'s pending native acceptance, exact artifact application and answer delivery: code must perform those after this check passes, so they need not have happened yet. Every other original obligation must already be supported, including independently requested execution, tests, application deployment or publication. A derived plan cannot narrow the original goal or criteria. A filename or a readiness claim alone does not establish completed work.',
        UNIT_JUDGE_BANDS[stakes],
      ),
    },
    fixtures: [
      { name: 'a derived parser-only goal cannot drop description search', state: {
        original: { goal: 'Search titles and descriptions.', criteria: ['Title search works.', 'Description search works.'] },
        assignedGoal: 'Search titles.', output: 'Title search works.',
        evidence: titleSearchEvidence(),
        hostStages: ['native-acceptance', 'artifact-application', 'answer-delivery'],
      }, expect: { original_obligations_unmet: 'yes' } },
      { name: 'pending native delivery does not undo demonstrated staged work', state: {
        original: { goal: 'Implement title search and deliver the checked patch.', criteria: ['Title search works.'] },
        assignedGoal: 'Implement title search.', output: 'The title-search patch is ready for native acceptance and delivery.',
        evidence: titleSearchEvidence(),
        hostStages: ['native-acceptance', 'artifact-application', 'answer-delivery'],
      }, expect: { original_obligations_unmet: 'no' } },
      { name: 'host answer delivery cannot stand in for requested application deployment', state: {
        original: { goal: 'Implement search and deploy the application.', criteria: ['Title search works.', 'Deploy the application.'] },
        assignedGoal: 'Implement search.', output: 'Search is implemented; deployment has not run.',
        evidence: { ...titleSearchEvidence(), deploymentExecutions: [] },
        hostStages: ['native-acceptance', 'artifact-application', 'answer-delivery'],
      }, expect: { original_obligations_unmet: 'yes' } },
      { name: 'actual host execution satisfies a requested test without a worker-local rerun', state: {
        original: { goal: 'Implement title search, run its tests and deliver the result.', criteria: ['Title search works.', 'Its behavior tests pass.'] },
        assignedGoal: 'Implement title search.', output: 'The search implementation and successful behavior test receipt are ready for delivery.',
        evidence: { ...titleSearchEvidence(), workerExecutions: [] },
        hostStages: ['native-acceptance', 'artifact-application', 'answer-delivery'],
      }, expect: { original_obligations_unmet: 'no' } },
      { name: 'pending host stages cannot excuse an unshown implementation', state: {
        original: { goal: 'Implement title search and deliver the checked patch.', criteria: ['Title search works.'] },
        assignedGoal: 'Implement title search.', output: 'The title-search patch is ready for native acceptance and delivery.',
        evidence: { stagedArtifact: 'title-search.patch', checks: [{ criterion: 'title', passed: true }] },
        hostStages: ['native-acceptance', 'artifact-application', 'answer-delivery'],
      }, expect: { original_obligations_unmet: 'yes' } },
    ],
  });
}

export const ORIGINAL_OBLIGATION_COVERAGE = {
  high: originalObligationCoverage('contract.original-obligation-coverage', 'high'),
  critical: originalObligationCoverage('contract.original-obligation-coverage.critical', 'critical'),
} as const;
