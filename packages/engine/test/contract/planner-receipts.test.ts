/** Fix-round planner receipts do not accumulate: a new round keeps only its own and leaves other contracts' alone. */
import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneOlderPlannerReceipts } from '../../platform/src/platform/contract/fix-planner-input.js';

test('older receipts of the same contract are removed, the new one and other contracts stay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-receipts-'));
  try {
    for (const name of ['ctr-aaaaaaaa-view1.json', 'ctr-aaaaaaaa-view2.json', 'ctr-aaaaaaaa-view3.json', 'ctr-bbbbbbbb-view1.json', 'notes.txt']) writeFileSync(join(dir, name), '{}');
    pruneOlderPlannerReceipts(join(dir, 'ctr-aaaaaaaa-view3.json'), 'ctr-aaaaaaaa');
    expect(readdirSync(dir).sort()).toEqual(['ctr-aaaaaaaa-view3.json', 'ctr-bbbbbbbb-view1.json', 'notes.txt']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
