/** Structured completion from registered checks and supported machine test reporters. */
import { SaxesParser } from 'saxes';

export interface GateCheckCounts {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export type GateCompletion =
  | { readonly kind: 'command-exit'; readonly exitCode: number }
  | { readonly kind: 'assertions'; readonly runner: 'bun-junit' | 'registered-protocol'; readonly checks: GateCheckCounts };

function counts(value: unknown): GateCheckCounts | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (!('passed' in value) || !('failed' in value) || !('skipped' in value)) return undefined;
  const { passed, failed, skipped } = value;
  if (typeof passed !== 'number' || typeof failed !== 'number' || typeof skipped !== 'number'
    || ![passed, failed, skipped].every(item => Number.isSafeInteger(item) && item >= 0)) return undefined;
  return { passed, failed, skipped };
}

/** A previous invocation's saved output cannot stand in for this execution. */
export function protocolCompletion(stdout: string, gate: string, runId: string): GateCompletion | undefined {
  const lastLine = stdout.trimEnd().split('\n').at(-1);
  if (!lastLine) return undefined;
  let value: unknown;
  try { value = JSON.parse(lastLine); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('kind' in value) || value.kind !== 'goodvibes-gate-result'
    || !('schemaVersion' in value) || value.schemaVersion !== 1
    || !('gate' in value) || value.gate !== gate
    || !('runId' in value) || value.runId !== runId
    || !('outcome' in value) || !('checks' in value)
    || !('observation' in value) || !value.observation || typeof value.observation !== 'object' || Array.isArray(value.observation)) return undefined;
  const checked = counts(value.checks);
  if (!checked || checked.passed + checked.failed === 0 || !Number.isSafeInteger(checked.passed + checked.failed + checked.skipped)
    || (value.outcome !== 'passed' && value.outcome !== 'failed')
    || (value.outcome === 'passed') !== (checked.failed === 0)) return undefined;
  return { kind: 'assertions', runner: 'registered-protocol', checks: checked };
}

/** Parse XML, not console prose. Counts must agree with the actual testcase records. */
export function junitCompletion(xml: string): GateCompletion | undefined {
  let invalid = false;
  let root = false;
  let declared: { tests: number; failures: number; skipped: number; errors: number } | undefined;
  let active: { failed: boolean; skipped: boolean; error: boolean } | undefined;
  const ancestry: string[] = [];
  const observed = { passed: 0, failed: 0, skipped: 0, errors: 0 };
  const parser = new SaxesParser({ xmlns: false });
  parser.on('error', () => { invalid = true; });
  parser.on('doctype', () => { invalid = true; });
  parser.on('opentag', tag => {
    const parent = ancestry.at(-1);
    ancestry.push(tag.name);
    if (!root) {
      root = true;
      if (tag.name !== 'testsuites') { invalid = true; return; }
      const number = (name: string, optional = false): number => {
        const raw = tag.attributes[name];
        if (raw === undefined && optional) return 0;
        if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) { invalid = true; return 0; }
        return Number(raw);
      };
      declared = { tests: number('tests'), failures: number('failures'), skipped: number('skipped'), errors: number('errors', true) };
    }
    if (tag.name === 'testcase') {
      if (active || parent !== 'testsuite') invalid = true;
      active = { failed: false, skipped: false, error: false };
    } else if (tag.name === 'failure' && active) { if (parent !== 'testcase') invalid = true; active.failed = true; }
    else if (tag.name === 'skipped' && active) { if (parent !== 'testcase') invalid = true; active.skipped = true; }
    else if (tag.name === 'error' && active) { if (parent !== 'testcase') invalid = true; active.error = true; }
  });
  parser.on('closetag', tag => {
    if (ancestry.pop() !== tag.name) invalid = true;
    if (tag.name !== 'testcase') return;
    if (!active || Number(active.failed) + Number(active.skipped) + Number(active.error) > 1) { invalid = true; return; }
    if (active.error) observed.errors++;
    else if (active.failed) observed.failed++;
    else if (active.skipped) observed.skipped++;
    else observed.passed++;
    active = undefined;
  });
  try { parser.write(xml).close(); } catch { return undefined; }
  if (invalid || !declared || active || observed.errors > 0
    || declared.tests !== observed.passed + observed.failed + observed.skipped
    || declared.failures !== observed.failed || declared.skipped !== observed.skipped || declared.errors !== observed.errors
    || observed.passed + observed.failed === 0) return undefined;
  return { kind: 'assertions', runner: 'bun-junit', checks: { passed: observed.passed, failed: observed.failed, skipped: observed.skipped } };
}

/** Instrument only a direct Bun test invocation or a plain registered Bun test script. */
export function bunTestCommand(command: string, scripts: Readonly<Record<string, string>>, reportPath: string): string | undefined {
  const plain = (value: string): boolean => /^\s*bun\s+test(?:\s+[^;&|<>`$\\\n]+)?\s*$/.test(value) && !value.includes('--reporter');
  const direct = plain(command);
  const script = /^\s*bun\s+run\s+test\s*$/.test(command) && typeof scripts['test'] === 'string' && plain(scripts['test']);
  if (!direct && !script) return undefined;
  const escaped = "'" + reportPath.replaceAll("'", "'\\''") + "'";
  return `${command} --reporter=junit --reporter-outfile=${escaped}`;
}
