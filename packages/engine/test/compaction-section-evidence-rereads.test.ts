/**
 * A sweep that is repeated because one case gained evidence must not re-ask the
 * cases whose evidence did not change.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { OwnedJudgmentWork } from '../platform/src/platform/runtime/owned-judgment-work.js';
import { readDependencyQualifiedMembership } from '../platform/src/platform/runtime/compaction/section-evidence.js';
import { resolvedProblemEvidence } from '../platform/src/platform/runtime/compaction/batteries/section-selection.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

interface State { cases: { id: string; evidenceSourcePositions: number[] }[] }
interface Instruction { caseId: string; targetSourcePosition?: number }

test('a case whose evidence did not change is not asked the same question again', async () => {
  const sources = Array.from({ length: 64 }, (_, index) => `[assistant]: Independent record ${index}. `
    + Array.from({ length: 48 }, (_, row) => `Record ${index} observation ${row} has identifier ${(index * 7919 + row * 104729).toString(36)}.`).join(' '));
  const asked: string[] = [];
  const port = fakePort((key, question, raw) => {
    const input = question.instructions as unknown as Instruction;
    const state = raw as unknown as State;
    if (!key.startsWith('dependency_')) return noulAnswer(0.01);
    const evidence = state.cases.find((entry) => entry.id === input.caseId)!.evidenceSourcePositions;
    asked.push(`${input.caseId}|${input.targetSourcePosition}|${evidence.join(',')}`);
    // Case "a" discovers a chain over three sweeps; case "b" never needs anything.
    const needed = input.caseId === 'a' && (input.targetSourcePosition === 56
      || (input.targetSourcePosition === 26 && evidence.includes(56)) || (input.targetSourcePosition === 6 && evidence.includes(26)));
    return noulAnswer(needed ? 0.99 : 0.01);
  });
  installJudgmentPort(port.port);
  const cases = [
    { id: 'a', sourceIndex: 0, battery: resolvedProblemEvidence },
    { id: 'b', sourceIndex: 1, battery: resolvedProblemEvidence },
  ];
  await readDependencyQualifiedMembership(sources, cases, () => [], new OwnedJudgmentWork());
  const forB = asked.filter((entry) => entry.startsWith('b|'));
  expect(forB.length).toBeGreaterThan(0);
  expect(new Set(forB).size).toBe(forB.length);
});
