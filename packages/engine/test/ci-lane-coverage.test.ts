import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PRODUCT_NAMES } from '../scripts/product-workspace-contract.ts';
import { TEST_FILE } from '../scripts/test-discovery.ts';
import { ENGINE_TEST_PARTITIONS } from '../scripts/test-partitions.ts';

// Coverage of the suite depends on ci.yml listing every partition, product and
// shard by hand; a leg that is forgotten means its tests never run while CI stays green.
interface Step { readonly run?: string }
interface Job { readonly strategy?: { readonly matrix?: Record<string, unknown> }; readonly steps?: readonly Step[] }
const workflow = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../../../.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, Job> };

const sorted = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);
const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, index) => from + index);

describe('CI test lanes', () => {
  test('the engine matrix runs every partition 1..N exactly once, with N the runner\'s count', () => {
    const include = workflow.jobs['platform-matrix']!.strategy!.matrix!['include'] as readonly { 'test-cmd'?: string }[];
    const legs = include.flatMap((entry) => {
      const match = /--partition=(\d+)\/(\d+)/.exec(entry['test-cmd'] ?? '');
      return match ? [{ index: Number(match[1]), count: Number(match[2]) }] : [];
    });
    expect(legs.every((leg) => leg.count === ENGINE_TEST_PARTITIONS)).toBe(true);
    expect(sorted(legs.map((leg) => leg.index))).toEqual(range(1, ENGINE_TEST_PARTITIONS));
  });

  test('every product has a test lane: the product matrix plus the Agent lane', () => {
    const matrix = workflow.jobs['product-tests']!.strategy!.matrix!['product'] as readonly string[];
    expect(workflow.jobs['agent-tests']).toBeDefined();
    expect([...matrix, 'agent'].sort()).toEqual([...PRODUCT_NAMES].sort());
  });

  test('the Agent shards are 0..K-1 for the K the file selection divides by, and the selection regex is the runner\'s', () => {
    const job = workflow.jobs['agent-tests']!;
    const script = (job.steps ?? []).map((step) => step.run ?? '').find((run) => run.includes('NR % '))!;
    const modulus = Number(/NR % (\d+) == shard/.exec(script)![1]);
    expect(sorted(job.strategy!.matrix!['shard'] as readonly number[])).toEqual(range(0, modulus));
    const regex = /-regex '([^']+)'/.exec(script)![1];
    expect(regex).toBe(`.*${TEST_FILE.source.replace('(?:', '(').replace(/\$$/, '')}`);
  });
});
