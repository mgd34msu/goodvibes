import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { proveVoiceRoundTrip, type ProofEngineRunner } from '../platform/src/platform/voice/provisioning/round-trip-proof.js';
import { createVoiceSetupService } from '../platform/src/platform/runtime/voice-setup.js';
import { createVoiceInstallHandler } from '../platform/src/platform/control-plane/routes/voice-setup.js';
import { readVoiceDiagnostics } from '../platform/src/platform/voice/diagnostics.js';

const engine = { ttsEngine: 'piper', ttsBinary: '/managed/piper', ttsModelPath: '/managed/voice.onnx',
  sttEngine: 'whisper-cpp', sttBinary: '/managed/whisper', sttModelPath: '/managed/model.bin' };

// A decision model that would say yes to anything; the proof must never ask it.
let previous: ReturnType<typeof installJudgmentPort> | undefined;
function decisionModel() {
  const fixture = fakePort(() => noulAnswer(0.99));
  previous = installJudgmentPort(fixture.port);
  return fixture;
}
afterEach(() => { if (previous !== undefined) installJudgmentPort(previous); previous = undefined; });

function runner(transcript: string, paths: string[] = []): ProofEngineRunner {
  return async input => {
    if (input.binary === engine.ttsBinary) {
      const path = String(input.args[input.args.indexOf('--output_file') + 1]);
      paths.push(path); writeFileSync(path, 'RIFFfixture'); return { stdout: '' };
    }
    return { stdout: transcript };
  };
}

describe('the install proof compares the transcript in code', () => {
  for (const [transcript, proved] of [
    ['The quick brown fox jumps over the lazy dog.', true],
    ['the quick brown fox jumped over the lazy dog', true],
    ['the quick brown fox over the lazy cat', false],
    ['the lazy dog jumps over the quick brown fox', false],
    ['', false],
  ] as const) test(`"${transcript}" ${proved ? 'proves' : 'does not prove'} the round trip`, async () => {
    const model = decisionModel();
    const proof = await proveVoiceRoundTrip({ ...engine, runner: runner(transcript) });
    expect(proof).toMatchObject({ stage: 'compare', proved, comparison: proved ? 'yes' : 'no', proofBasis: 'native-word-sequence' });
    expect(model.requests).toHaveLength(0);
  });
  test('cancellation during synthesis prevents transcription and removes temporary files', async () => {
    const controller = new AbortController(); const paths: string[] = []; let calls = 0;
    await expect(proveVoiceRoundTrip({ ...engine, signal: controller.signal, runner: async input => {
      calls++; await runner('', paths)(input); controller.abort(); return { stdout: '' };
    } })).rejects.toThrow();
    expect(calls).toBe(1); expect(existsSync(dirname(paths[0]!))).toBe(false);
  });
  test('zero audio is a synthesis failure and caller-owned scratch survives', async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'voice-owned-'));
    try {
      const proof = await proveVoiceRoundTrip({ ...engine, scratchDir, runner: async () => {
        writeFileSync(join(scratchDir, 'proof.wav'), ''); return { stdout: '' };
      } });
      expect(proof.stage).toBe('synthesize'); expect(proof.proved).toBe(false); expect(existsSync(scratchDir)).toBe(true);
    } finally { rmSync(scratchDir, { recursive: true, force: true }); }
  });
});

describe('the setup service reports the proof', () => {
  function service(root: string, stt: 'provisioned' | 'unsupported-platform', transcript = 'The quick brown fox jumps over the lazy dog.') {
    const config: Record<string, string | boolean> = {};
    return createVoiceSetupService({
      managedVoiceRoot: root, getConfig: key => String(config[key] ?? ''), setConfig: (key, value) => { config[key] = value; },
      resetLocalEngineFailureState: () => {}, admitExpensiveWork: () => ({ allowed: true }),
      provision: async () => ({ platform: 'linux-x64', components: [],
        tts: { engine: 'piper', state: 'provisioned', binaryPath: engine.ttsBinary, modelPath: engine.ttsModelPath },
        stt: stt === 'provisioned'
          ? { engine: 'whisper-cpp', state: 'provisioned', binaryPath: engine.sttBinary, modelPath: engine.sttModelPath }
          : { engine: 'whisper-cpp', state: 'unsupported-platform', reason: 'No pinned STT bundle for this fixture' } }),
      prove: options => proveVoiceRoundTrip({ ...options, runner: runner(transcript) }),
    });
  }
  test('a proven install is provisioned and leaves a diagnostic, with no decision request', async () => {
    const model = decisionModel(), root = mkdtempSync(join(tmpdir(), 'voice-proof-setup-'));
    try {
      const setup = service(root, 'provisioned');
      const receipt = await createVoiceInstallHandler(setup)({ context: {} }) as Awaited<ReturnType<typeof setup.install>>;
      expect(receipt).toMatchObject({ provisioned: true, proof: { proved: true, proofBasis: 'native-word-sequence' } });
      expect(readVoiceDiagnostics(root).at(-1)).toMatchObject({ ok: true, operation: 'provision-proof', proofBasis: 'native-word-sequence' });
      expect(model.requests).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('a transcript that does not say the phrase reports not provisioned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'voice-proof-setup-'));
    try {
      const receipt = await service(root, 'provisioned', 'something else entirely').install();
      expect(receipt.provisioned).toBe(false); expect(receipt.proof?.proved).toBe(false);
      expect(readVoiceDiagnostics(root).at(-1)).toMatchObject({ ok: false, operation: 'provision-proof' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('where speech-to-text is unsupported, text-to-speech alone is provisioned with no proof', async () => {
    const root = mkdtempSync(join(tmpdir(), 'voice-tts-only-'));
    try {
      const receipt = await service(root, 'unsupported-platform').install();
      expect(receipt.provisioned).toBe(true); expect(receipt.proof).toBeUndefined();
      expect(receipt.notes.join(' ')).toContain('no round trip could be proven');
      expect(readVoiceDiagnostics(root)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
