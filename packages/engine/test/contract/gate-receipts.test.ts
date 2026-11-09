import { expect, test } from 'bun:test';
import { junitCompletion, protocolCompletion } from '../../platform/src/platform/contract/gate-receipts.js';

const report = (body: string, attributes = 'tests="1" failures="0" skipped="0"') => `<?xml version="1.0"?><testsuites ${attributes}><testsuite>${body}</testsuite></testsuites>`;

test('machine assertion counts require actual matching testcase records', () => {
  expect(junitCompletion(report('<testcase name="checked"/>'))).toMatchObject({ kind: 'assertions', checks: { passed: 1, failed: 0, skipped: 0 } });
  for (const xml of [
    report(''),
    report('<testcase name="a"/><testcase name="b"/>'),
    report('<testcase name="skipped"><skipped/></testcase>', 'tests="1" failures="0" skipped="1"'),
    report('<testcase name="error"><error/></testcase>', 'tests="1" failures="0" skipped="0" errors="1"'),
    report('<testcase name="a"><testcase name="b"/></testcase>', 'tests="2" failures="0" skipped="0"'),
    report('<system-out><testcase name="hidden"/></system-out>'),
    report('<testcase name="malformed">'),
    '<!DOCTYPE testsuites [<!ENTITY fake "1">]>' + report('<testcase name="a"/>'),
  ]) expect(junitCompletion(xml)).toBeUndefined();
});

test('registered completion binds current invocation, check identity, counts and observation shape', () => {
  const record = { kind: 'goodvibes-gate-result', schemaVersion: 1, gate: 'check', runId: 'current',
    outcome: 'passed', checks: { passed: 1, failed: 0, skipped: 0 }, observation: { measured: 'value' } };
  const parse = (changes: object) => protocolCompletion(JSON.stringify({ ...record, ...changes }), 'check', 'current');
  expect(parse({})).toMatchObject({ kind: 'assertions', checks: { passed: 1 } });
  for (const changes of [
    { gate: 'another' }, { runId: 'previous' }, { outcome: 'failed' }, { observation: [] },
    { checks: { passed: 0, failed: 0, skipped: 3 } }, { checks: { passed: 1, failed: 1, skipped: 0 } },
    { checks: { passed: Number.MAX_SAFE_INTEGER, failed: 0, skipped: 1 } },
  ]) expect(parse(changes)).toBeUndefined();
});
