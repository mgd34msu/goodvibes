// Proves: An API key or token that passed through a turn is written in the clear to the transcript journal, the execution ledger or the span file, or is sent to a model provider to be classified.
// Red when: The redactor misses an issuer format or a bearer token or asks a decision model about a span, or the agent journal, the ledger writer or the span writer stops passing its lines through it.
/**
 * at-rest-redaction.test.ts
 *
 * Credentials are masked before the raw-content writers put anything on disk:
 * the transcript journal (agents/session.ts) and the local execution ledger
 * and span file (runtime/telemetry/exporters/local-ledger.ts). The masking is
 * decided in code: no span is sent to a decision model, which would hand the
 * credential to a model provider. When the owner-profile source the redactor
 * depends on fails, the line is refused rather than written unmasked.
 *
 * Each proof also checks that the ordinary text of the same record reached the
 * file, so "the secret is absent" cannot pass because nothing was written.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakePort, noulAnswer } from '@goodvibes/judgment/testing';
import { installJudgmentPort } from '@goodvibes/engine/errors';
import { redactAtRestLine } from '../platform/src/platform/runtime/at-rest-persistence.ts';
import { DIGITS, LOWER, syntheticChars, syntheticCredential, syntheticJwt, UPPER } from '../platform/src/platform/utils/fixture-credentials.ts';
import { AgentSession } from '../platform/src/platform/agents/session.ts';
import { LocalLedgerExporter } from '../platform/src/platform/runtime/telemetry/exporters/local-ledger.ts';

const tmpDirs: string[] = [];
function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-atrest-'));
  tmpDirs.push(dir);
  return dir;
}

// Credential-shaped values are assembled at run time (utils/fixture-credentials.ts), so
// no file holds a whole shape a secret scanner reports.
const API_KEY = syntheticCredential('sk-', 'at-rest api key', 24, UPPER);
const GITHUB_TOKEN = syntheticCredential('ghp_', 'at-rest github token', 40, DIGITS);
const BEARER = '7f3c9a1e5b2d48f0a6c4e8b1d3f5a7c9';
const ORDINARY = 'ordinary-visible-text';

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previousPort = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previousPort);
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('redactAtRestLine', () => {
  test('issuer formats and credential-shaped spans are masked in code; no span reaches a decision model', () => {
    const { port, requests } = fakePort(() => noulAnswer(0.01));
    installJudgmentPort(port);
    const secrets = [API_KEY, GITHUB_TOKEN, BEARER, syntheticCredential('sk-proj-', 'at-rest project key', 32), syntheticCredential('key-', 'at-rest key', 32, `${LOWER}${DIGITS}`),
      syntheticCredential('sk-or-v1-', 'at-rest router key', 48, `${DIGITS}abcdef`), syntheticCredential('AKIA', 'at-rest aws key id', 16, UPPER),
      ['xoxb', syntheticChars('slack team', 12, DIGITS), syntheticChars('slack bot', 12, DIGITS), syntheticChars('slack secret', 10, LOWER)].join('-'),
      // A signed JSON web token with no `Bearer` in front of it.
      syntheticJwt('at-rest')];
    const line = JSON.stringify({ body: `${ORDINARY} token ${API_KEY} Authorization: Bearer ${BEARER} also ${secrets.slice(3).join(' ')}`, gh: GITHUB_TOKEN });
    const out = redactAtRestLine(line);
    for (const secret of secrets) expect(out).not.toContain(secret);
    expect(out).toContain(ORDINARY);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(requests).toHaveLength(0);
  });
});

describe('AgentSession transcript journal', () => {
  test('each appended line is masked on disk', () => {
    const dir = mkTemp();
    const session = new AgentSession('agent-1', 'm', 'p', { sessionsDir: dir, stateDir: dir });
    session.appendMessage({ role: 'user', body: `key is ${API_KEY}, ${ORDINARY}` });
    session.appendMessage({ role: 'assistant', body: `gh ${GITHUB_TOKEN}` });
    const text = readFileSync(join(dir, 'agent-1.jsonl'), 'utf8');
    expect(text).toContain(ORDINARY);
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(GITHUB_TOKEN);
  });
});

describe('LocalLedgerExporter', () => {
  test('a ledger event is masked on disk and read back masked', async () => {
    const dir = mkTemp();
    const exporter = new LocalLedgerExporter({ filePath: join(dir, 'spans.jsonl'), ledgerFilePath: join(dir, 'run.ledger.jsonl') });
    exporter.recordEvent({ runId: 'run-1', rev: 1, eventName: 'TOOL_RESULT', payload: { output: `token ${API_KEY} ${ORDINARY}` }, ts: Date.now() });
    await exporter.flush();
    const raw = readFileSync(join(dir, 'run.ledger.jsonl'), 'utf8');
    expect(raw).toContain(ORDINARY);
    expect(raw).not.toContain(API_KEY);
    const entries = exporter.readRunEntries('run-1');
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]!.payload)).not.toContain(API_KEY);
  });

  test('an exported span is masked in the span file', async () => {
    const dir = mkTemp();
    const filePath = join(dir, 'spans.jsonl');
    const exporter = new LocalLedgerExporter({ filePath });
    const span = { name: `read ${ORDINARY}`, attributes: { key: API_KEY }, spanContext: { traceId: 't', spanId: 's' } };
    await exporter.export([span as never]);
    const raw = readFileSync(filePath, 'utf8');
    expect(raw).toContain(ORDINARY);
    expect(raw).not.toContain(API_KEY);
  });
});
