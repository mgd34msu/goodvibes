import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { HeldMergeGroup } from '@goodvibes-jev/engine/platform/platform/orchestration';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { handleFleetCommand, renderGroupList, renderJudgeProposal, renderPickResult } from '../../cli/fleet-command.ts';
import type { CliCommandRuntime } from '../../cli/management.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];

function runtime(args: readonly string[]): CliCommandRuntime {
  const root = makeProjectTempDir('gv-agent-fleet-cli');
  roots.push(root);
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    workingDir: workingDirectory,
    homeDir: homeDirectory,
  });
  return {
    cli: parseGoodVibesCli(['fleet', ...args]),
    configManager,
    workingDirectory,
    homeDirectory,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fleet CLI command', () => {
  test('parses the fleet command and its aliases', () => {
    expect(parseGoodVibesCli(['fleet', 'attempts', 'list']).command).toBe('fleet');
    expect(parseGoodVibesCli(['fleets', 'attempts', 'list']).command).toBe('fleet');
  });

  test('an unknown top-level subcommand is a usage error', async () => {
    const result = await handleFleetCommand(runtime(['bogus']));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Usage: goodvibes-agent fleet attempts');
  });

  test('attempts list asks the connected host and, with none to ask, says so as JSON under --json', async () => {
    const rt = runtime(['attempts', 'list']);
    const result = await handleFleetCommand({ ...rt, cli: parseGoodVibesCli(['fleet', 'attempts', 'list', '--json']) });
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.output) as { readonly ok?: unknown; readonly kind?: unknown; readonly next?: unknown };
    expect(payload.ok).toBe(false);
    expect(payload.kind).toBe('connected_host_unavailable');
    expect(Array.isArray(payload.next)).toBe(true);
  });

  test('attempts pick requires both a groupId and a winnerItemId', async () => {
    const result = await handleFleetCommand(runtime(['attempts', 'pick', 'group-1']));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Usage: goodvibes-agent fleet attempts pick');
  });

  test('attempts pick refuses without --yes', async () => {
    const result = await handleFleetCommand(runtime(['attempts', 'pick', 'group-1', 'item-1']));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('without --yes');
  });

  test('attempts judge requires a groupId', async () => {
    const result = await handleFleetCommand(runtime(['attempts', 'judge']));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Usage: goodvibes-agent fleet attempts judge');
  });

  describe('success output', () => {
    const usage = {
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
      llmCallCount: 2, turnCount: 3, toolCallCount: 4, costUsd: 0.0123, costState: 'priced',
    } as const;
    const group: HeldMergeGroup = {
      groupId: 'c1:group-1', workstreamId: 'ws-1', sourceTitle: 'Fix the parser', ready: true, autoAccept: false,
      candidates: [
        { itemId: 'c1:item-1', attemptIndex: 1, state: 'held-merge', title: 'attempt one', worktreePath: null, branch: null, usage,
          failureReason: null, diff: { files: ['a.ts', 'b.ts'], unifiedDiff: '', stat: '2 files changed' } },
        { itemId: 'c1:item-2', attemptIndex: 2, state: 'failed', title: 'attempt two', worktreePath: null, branch: null, usage,
          failureReason: 'tests failed', diff: null },
      ],
      judgment: { proposedWinnerItemId: 'c1:item-1', reasons: ['smaller diff'], model: 'judge-model', scoredBy: 'model' },
    };

    test('a held group lists every candidate and labels the judge as a proposal, never a decision', () => {
      const text = renderGroupList([group]);
      expect(text).toContain('Best-of-N held-merge groups (1)');
      expect(text).toContain('c1:item-1  attempt #1  held-merge  attempt one');
      expect(text).toContain('diff: 2 file(s), 2 files changed');
      expect(text).toContain('failure: tests failed');
      expect(text).toContain('cost $0.0123');
      expect(text).toContain('MODEL PROPOSAL (scored by judge-model, not a decision');
      expect(text).toContain('proposed winner c1:item-1');
    });

    test('an unjudged group says so', () => {
      expect(renderGroupList([{ ...group, judgment: null }])).toContain('judge proposal: none yet');
    });

    test('a pick names the winner, the cleaned losers and whether it was an explicit pick', () => {
      const text = renderPickResult({ groupId: 'c1:group-1', winnerItemId: 'c1:item-1', loserItemIds: ['c1:item-2'], auto: false });
      expect(text).toContain('Picked winner c1:item-1 for group c1:group-1');
      expect(text).toContain('losers cleaned: c1:item-2');
      expect(text).toContain('explicit operator pick');
      expect(renderPickResult({ groupId: 'g', winnerItemId: 'w', loserItemIds: [], auto: true })).toContain('losers cleaned: none');
    });

    test('a judge result is shown as a proposal with the pick command that confirms it', () => {
      const text = renderJudgeProposal('c1:group-1', { proposedWinnerItemId: null, reasons: ['too close'], model: null, scoredBy: 'model' });
      expect(text).toContain('Judge proposal for group c1:group-1');
      expect(text).toContain('(judge declined to choose)');
      expect(text).toContain('reason: too close');
      expect(text).toContain('goodvibes-agent fleet attempts pick c1:group-1 <winnerItemId> --yes');
    });
  });
});
