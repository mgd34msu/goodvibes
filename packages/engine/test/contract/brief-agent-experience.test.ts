/**
 * What a unit's agent and the planner are told: a review brief names the
 * unit's scope and counts instead of inlining the inventory, "." is the root
 * directory rather than the whole project, the planner's host rules are kept
 * apart from the user's words, and a nudge says why a criterion read unmet
 * when the check recorded a reason.
 */
import { describe, expect, test } from 'bun:test';
import { buildUnitBrief } from '../../platform/src/platform/contract/brief.js';
import { assignedReviewPaths } from '../../platform/src/platform/contract/review-inventory.js';
import { buildContractPlannerRequest } from '../../platform/src/platform/contract/planner.js';
import { buildNudge } from '../../platform/src/platform/contract/nudge.js';
import { makeContract, makeCriterion, makeUnit } from './fixtures.js';
import { shapeOf } from './plan-support.js';

/** About ten thousand paths spread over nested directories, plus root files. */
function inventory() {
  const paths = ['package.json', 'README.md', '.gitignore'];
  for (let a = 0; a < 10; a++) for (let b = 0; b < 25; b++) for (let c = 0; c < 40; c++) paths.push(`pkg-${a}/src/mod-${b}/file-${c}.ts`);
  return { paths: paths.sort(), source: 'git' as const, errors: [] };
}

describe('review brief inventory', () => {
  test('a brief over a ten-thousand-file inventory sends the scope and counts, not the list', () => {
    const reviewInventory = inventory();
    const unit = makeUnit({ role: 'research', files: ['pkg-3'] });
    const contract = makeContract({ units: [unit], shape: shapeOf(['forbids_writing']), reviewInventory });
    const brief = buildUnitBrief(contract, contract.groups[0]!, unit);
    expect(brief.length).toBeLessThan(6_000);
    expect(brief).toContain('"assignedScope":["pkg-3"]');
    expect(brief).toContain('"count":1000');
    expect(brief).not.toContain('pkg-3/src/mod-0/file-0.ts');
    expect(brief).not.toContain('pkg-4');
  });

  test('a short assignment is still listed exactly', () => {
    const reviewInventory = inventory();
    const unit = makeUnit({ role: 'research', files: ['pkg-1/src/mod-2/file-3.ts', 'README.md'] });
    const contract = makeContract({ units: [unit], shape: shapeOf(['forbids_writing']), reviewInventory });
    expect(buildUnitBrief(contract, contract.groups[0]!, unit)).toContain('"assignedFiles":["README.md","pkg-1/src/mod-2/file-3.ts"]');
  });

  test('"." assigns the root directory\'s direct files, not the whole project', () => {
    expect(assignedReviewPaths(inventory(), ['.'])).toEqual(['.gitignore', 'README.md', 'package.json']);
    expect(assignedReviewPaths(inventory(), ['**'])).toHaveLength(inventory().paths.length);
  });
});

describe('planner request sections', () => {
  test('host rules sit under their own heading, apart from the user\'s words', () => {
    const request = buildContractPlannerRequest({ ask: 'Review the parser and write a report.', shape: shapeOf(['forbids_writing']),
      config: { defaultAttempts: 1, maxUnits: 0 }, repositoryMap: '(map)' });
    const user = request.indexOf('## How the user wants the work done');
    const host = request.indexOf('## Host rules');
    const rule = request.indexOf('Permission to write a requested review report');
    expect(host).toBeGreaterThan(-1);
    expect(rule).toBeGreaterThan(host);
    expect(request.slice(user, host)).not.toContain('Permission to write');
    expect(request.slice(host)).toContain('never make one a criterion');
    expect(request.slice(user, host)).toContain('does not allow changing files');
  });
});

describe('nudge rationale', () => {
  test('an unmet criterion carries the check\'s reason when one was recorded', () => {
    const unit = makeUnit({ criteria: [makeCriterion({ id: 'u1.c1', text: 'Every finding has a file:line anchor', origin: 'derived', serves: ['c1'], quote: undefined })] });
    const text = buildNudge(unit, { checkNumber: 2, kinds: ['unmet'], verdicts: new Map([['u1.c1', 'unmet']]), regressions: [], goalVerdict: 'met',
      qualityProblems: [], qualityUnshown: [], failedGates: [], rationales: new Map([['u1.c1', 'Findings 3 and 5 name a file but no line.']]) });
    expect(text).toContain('- [u1.c1] Every finding has a file:line anchor\n  Why: Findings 3 and 5 name a file but no line.');
  });
});
