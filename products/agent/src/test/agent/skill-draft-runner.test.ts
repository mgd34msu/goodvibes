import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { runSkillDraftProposer, readSkillDraftLedger } from '../../agent/skill-draft-runner.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { fakePort, scoreAnswer, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import type { SkillDraftRunResult } from '../../agent/skill-draft-runner.ts';
import { createShellPathService } from '@/runtime/index.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previous = installJudgmentPort(undefined);
  const readings = fakePort((name, question) => question.type === 'score' ? scoreAnswer(question, name === 'link' ? 0 : 3, 0.9999)
    : question.type === 'choice' ? choiceAnswer(question, 'none', 0.9999) : noulAnswer(0.9999));
  installJudgmentPort(readings.port);
});
afterEach(async () => { installJudgmentPort(previous); await cleanupResearchScreeningFixtures(); });
const readingOptions = () => ({ sourceOwner: ordinaryResearchOwner(), assertCurrent: () => undefined });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempRegistry(): { readonly registry: AgentSkillRegistry; readonly paths: ReturnType<typeof createShellPathService> } {
  const root = makeProjectTempDir('goodvibes-agent-draft-runner');
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  return { registry: AgentSkillRegistry.fromShellPaths(paths), paths };
}

function ledgerSiblingPath(registry: AgentSkillRegistry): string {
  const { path } = registry.snapshot();
  return path.replace(/skills\.json$/, 'skill-draft-ledger.json');
}

/**
 * Build a CommandContext stub with a real workspace.shellPaths so that
 * buildLearningCandidates does not throw on null workspace.
 * The temp paths carry no memory/skill data so the pass yields zero
 * eligible candidates, no drafts are written, skipped=0.
 */
function makeContextWithPaths(paths: ReturnType<typeof createShellPathService>): CommandContext {
  return {
    workspace: { shellPaths: paths } as unknown as CommandContext['workspace'],
    session: { runtime: { sessionId: 'native-empty-draft-fixture' } },
    user: null,
    conversationHistory: [],
    meta: {},
  } as unknown as CommandContext;
}

// ---------------------------------------------------------------------------
// Ledger round-trip
// ---------------------------------------------------------------------------

describe('runSkillDraftProposer: ledger round-trip', () => {
  test('readSkillDraftLedger returns empty array when no ledger exists', () => {
    const { registry } = tempRegistry();
    const entries = readSkillDraftLedger(registry);
    expect(entries).toHaveLength(0);
  });

  test('readSkillDraftLedger returns entries after a run that created skills', () => {
    const { registry } = tempRegistry();

    // Manually create a skill then write a ledger entry so we can test the
    // read path without depending on buildLearningCandidates output.
    const skill = registry.create({
      name: 'test-draft-skill',
      description: 'A test draft skill',
      procedure: 'Do test things',
      enabled: false,
      source: 'agent',
      provenance: 'auto-proposed-skill-draft',
    });

    const ledgerPath = ledgerSiblingPath(registry);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const ledgerContent = JSON.stringify({
      version: 1,
      entries: [
        {
          skillId: skill.id,
          name: skill.name,
          candidateId: 'c-test',
          proposedAt: new Date().toISOString(),
        },
      ],
    }, null, 2) + '\n';
    writeFileSync(ledgerPath, ledgerContent, 'utf-8');

    const entries = readSkillDraftLedger(registry);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.skillId).toBe(skill.id);
    expect(entries[0]?.name).toBe(skill.name);
    expect(entries[0]?.candidateId).toBe('c-test');
  });
});

// ---------------------------------------------------------------------------
// Malformed ledger treated as empty
// ---------------------------------------------------------------------------

describe('runSkillDraftProposer: malformed ledger', () => {
  test('malformed JSON in ledger file is treated as empty (no throw)', () => {
    const { registry } = tempRegistry();
    const ledgerPath = ledgerSiblingPath(registry);
    mkdirSync(dirname(ledgerPath), { recursive: true });

    // Write malformed JSON
    writeFileSync(ledgerPath, 'this is not json}', 'utf-8');

    // Should not throw
    const entries = readSkillDraftLedger(registry);
    expect(entries).toHaveLength(0);
  });

  test('ledger with missing entries array is treated as empty', () => {
    const { registry } = tempRegistry();
    const ledgerPath = ledgerSiblingPath(registry);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify({ version: 1 }), 'utf-8');

    const entries = readSkillDraftLedger(registry);
    expect(entries).toHaveLength(0);
  });

  test('ledger with non-object entries are filtered out', () => {
    const { registry } = tempRegistry();
    const ledgerPath = ledgerSiblingPath(registry);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        entries: [
          null,
          42,
          'string-entry',
          { skillId: 's1', name: 'valid', candidateId: 'c1', proposedAt: '2025-01-01T00:00:00.000Z' },
        ],
      }),
      'utf-8',
    );

    const entries = readSkillDraftLedger(registry);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('valid');
  });
});

// ---------------------------------------------------------------------------
// Created skills shape
// ---------------------------------------------------------------------------

describe('runSkillDraftProposer: created skill shape', () => {
  test('a reviewed note actually produces a disabled native skill with its complete procedure', async () => {
    const { registry, paths } = tempRegistry();
    const notes = AgentNoteRegistry.fromShellPaths(paths);
    const body = 'First restore the backup in isolation, then verify all rows before switching traffic.';
    const note = notes.create({ title: 'Restore verification', body }); notes.markReviewed(note.id);
    const readings = fakePort((name, question) => question.type === 'score' ? scoreAnswer(question, name === 'link' ? 0 : 3, 0.9999)
      : question.type === 'choice' ? choiceAnswer(question, name === 'target' ? 'skill' : 'none', 0.9999) : noulAnswer(0.9999));
    installJudgmentPort(readings.port);
    const result = await runSkillDraftProposer(makeContextWithPaths(paths), registry, readingOptions());
    expect(result.proposed).toBe(1); expect(result.skillIds).toHaveLength(1);
    const skill = registry.list().find(value => value.id === result.skillIds[0]);
    expect(skill?.procedure).toContain(body); expect(skill?.enabled).toBe(false);
    expect(skill?.reviewState).toBe('fresh'); expect(skill?.source).toBe('agent');
    expect<string | undefined>(readSkillDraftLedger(registry)[0]?.skillId).toBe(skill?.id);
  });
});

describe('runSkillDraftProposer: a pass that fails after creating a skill', () => {
  function reviewedNoteSkillPort(): void {
    const readings = fakePort((name, question) => question.type === 'score' ? scoreAnswer(question, name === 'link' ? 0 : 3, 0.9999)
      : question.type === 'choice' ? choiceAnswer(question, name === 'target' ? 'skill' : 'none', 0.9999) : noulAnswer(0.9999));
    installJudgmentPort(readings.port);
  }

  test('the created skill is still recorded in the ledger', async () => {
    const { registry, paths } = tempRegistry();
    const notes = AgentNoteRegistry.fromShellPaths(paths);
    const note = notes.create({ title: 'Restore verification', body: 'First restore the backup in isolation, then verify all rows before switching traffic.' });
    notes.markReviewed(note.id);
    reviewedNoteSkillPort();
    // The caller's currentness check starts failing the moment the skill exists.
    const options = {
      sourceOwner: ordinaryResearchOwner(),
      assertCurrent: () => { if (registry.list().length > 0) throw new ToolInputProjectionError('stale'); },
    };

    await expect(runSkillDraftProposer(makeContextWithPaths(paths), registry, options)).rejects.toThrow();

    const created = registry.list();
    expect(created).toHaveLength(1);
    expect(readSkillDraftLedger(registry).map((entry) => entry.skillId)).toEqual([created[0]!.id]);
  });

  test('an unreadable ledger is kept beside the new one instead of being replaced', async () => {
    const { registry, paths } = tempRegistry();
    const notes = AgentNoteRegistry.fromShellPaths(paths);
    const note = notes.create({ title: 'Restore verification', body: 'First restore the backup in isolation, then verify all rows before switching traffic.' });
    notes.markReviewed(note.id);
    reviewedNoteSkillPort();
    const ledgerPath = ledgerSiblingPath(registry);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, 'this is not json}', 'utf-8');

    const result = await runSkillDraftProposer(makeContextWithPaths(paths), registry, readingOptions());

    expect(result.proposed).toBe(1);
    const copy = readdirSync(dirname(ledgerPath)).find((name) => name.startsWith('skill-draft-ledger.json.unreadable-'));
    expect(copy).toBeDefined();
    expect(readFileSync(join(dirname(ledgerPath), copy!), 'utf-8')).toBe('this is not json}');
  });
});

// ---------------------------------------------------------------------------
// Skipped count
// ---------------------------------------------------------------------------

describe('runSkillDraftProposer: result shape', () => {
  test('returns proposed=0, skipped=0, skillIds=[] for an empty-candidate pass', async () => {
    const { registry, paths } = tempRegistry();
    const result: SkillDraftRunResult = await runSkillDraftProposer(makeContextWithPaths(paths), registry, readingOptions());
    expect(result.proposed).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(0);
    expect(result.skillIds).toHaveLength(0);
    expect(result.entries).toHaveLength(0);
  });

  test('a pass skips candidates already in the ledger or colliding with an existing skill, and a repeat pass proposes nothing', async () => {
    const bodies = {
      a: 'Rotate the signing keys by issuing the new key first, then retiring the old key after every client refreshed.',
      b: 'Drain the queue before a deploy by pausing producers, waiting for consumers to idle, then releasing the lock.',
      c: 'Triage inbound invoices by matching the purchase order first, then routing mismatches to the finance owner.',
      d: 'Archive stale branches by listing merged branches older than ninety days, then deleting them after a final check.',
    };
    const skillPort = () => {
      const readings = fakePort((name, question) => question.type === 'score' ? scoreAnswer(question, name === 'link' ? 0 : 3, 0.9999)
        : question.type === 'choice' ? choiceAnswer(question, name === 'target' ? 'skill' : 'none', 0.9999) : noulAnswer(0.9999));
      installJudgmentPort(readings.port);
    };
    const addNote = (paths: ReturnType<typeof createShellPathService>, title: string, body: string): void => {
      const notes = AgentNoteRegistry.fromShellPaths(paths);
      notes.markReviewed(notes.create({ title, body }).id);
    };
    skillPort();

    // Learn the name the proposer derives for note d, in a throwaway workspace.
    const probe = tempRegistry();
    addNote(probe.paths, 'Archive branches', bodies.d);
    const probed = await runSkillDraftProposer(makeContextWithPaths(probe.paths), probe.registry, readingOptions());
    expect(probed.proposed).toBe(1);
    const collidingName = probed.entries[0]!.name;

    const { registry, paths } = tempRegistry();
    addNote(paths, 'Rotate keys', bodies.a);
    addNote(paths, 'Drain queue', bodies.b);
    const first = await runSkillDraftProposer(makeContextWithPaths(paths), registry, readingOptions());
    expect(first.proposed).toBe(2);
    expect(first.skipped).toBe(0);
    expect(readSkillDraftLedger(registry)).toHaveLength(2);

    addNote(paths, 'Triage invoices', bodies.c);
    addNote(paths, 'Archive branches', bodies.d);
    registry.create({ name: collidingName, description: 'Already here', procedure: 'Do it by hand.', enabled: false, source: 'user', provenance: 'manual' });
    const skillCountBefore = registry.list().length;

    const second = await runSkillDraftProposer(makeContextWithPaths(paths), registry, readingOptions());
    // a and b are already proposed and no longer eligible; d is eligible but collides with an existing skill, so only c is new.
    expect(second.proposed).toBe(1);
    expect(second.skipped).toBe(1);
    expect(second.skillIds).toHaveLength(1);
    expect(registry.list()).toHaveLength(skillCountBefore + 1);
    const ledgerIds = readSkillDraftLedger(registry).map(entry => entry.skillId);
    expect(ledgerIds).toHaveLength(3);
    expect(ledgerIds).toContain(second.skillIds[0]!);

    // Remove the skill created for c: its name no longer collides, so only the ledger can stop c from being proposed again.
    registry.deleteSkill(second.skillIds[0]!);
    expect(registry.list()).toHaveLength(skillCountBefore);

    const third = await runSkillDraftProposer(makeContextWithPaths(paths), registry, readingOptions());
    expect(third.proposed).toBe(0);
    expect(third.skipped).toBe(2);
    expect(third.skillIds).toEqual([]);
    expect(registry.list()).toHaveLength(skillCountBefore);
    expect(readSkillDraftLedger(registry)).toHaveLength(3);
  });
});
