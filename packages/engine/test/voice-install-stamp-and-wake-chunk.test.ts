import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVoiceSetupService } from '../platform/src/platform/runtime/voice-setup.ts';
import { createWakeSetupService } from '../platform/src/platform/runtime/wake-setup.ts';
import { readGatewayVerbRefusal } from '../platform/src/platform/control-plane/routes/gateway-verb-error.ts';
import type { VoiceProvisionResult } from '../platform/src/platform/voice/provisioning/index.ts';

const dirs: string[] = [];
function dir(): string {
  const made = mkdtempSync(join(tmpdir(), 'gv-voice-stamp-'));
  dirs.push(made);
  return made;
}
afterEach(() => {
  for (const made of dirs.splice(0)) rmSync(made, { recursive: true, force: true });
});

function ttsOnly(root: string): VoiceProvisionResult {
  return {
    platform: 'linux-x64',
    tts: { engine: 'piper', state: 'provisioned', binaryPath: join(root, 'piper', 'piper'), modelPath: join(root, 'voices', 'v.onnx') },
    stt: { engine: 'whisper', state: 'bundle-unavailable' },
    components: [],
  } as unknown as VoiceProvisionResult;
}

function install(root: string): ReturnType<ReturnType<typeof createVoiceSetupService>['install']> {
  const config: Record<string, string> = {};
  return createVoiceSetupService({
    managedVoiceRoot: root,
    getConfig: (key) => config[key] ?? '',
    setConfig: (key, value) => { config[key] = value; },
    resetLocalEngineFailureState: () => {},
    admitExpensiveWork: () => ({ allowed: true }),
    provision: async () => ttsOnly(root),
  }).install();
}

function stampFile(root: string, writes: Record<string, string>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'install-stamp.json'), JSON.stringify({ engineVersion: 'v1', voiceId: 'v', configWrites: writes }));
}

describe('voice install receipt when the ownership record cannot be kept', () => {
  test('a missing install stamp is created so the keys just set stay owned', async () => {
    const root = dir();
    const receipt = await install(root);
    expect(receipt.configured.set.length).toBeGreaterThan(0);
    expect(receipt.notes.join('\n')).not.toContain('could not record');
    const stamp = JSON.parse(readFileSync(join(root, 'install-stamp.json'), 'utf-8')) as { configWrites: Record<string, string> };
    expect(Object.keys(stamp.configWrites).sort()).toEqual(receipt.configured.set.map((entry) => entry.key).sort());
  });

  test('a stamp that cannot be read back is reported in the notes', async () => {
    const root = dir();
    stampFile(root, {});
    // Replace the stamp file with a directory of the same name: neither a read nor a write can succeed.
    rmSync(join(root, 'install-stamp.json'));
    mkdirSync(join(root, 'install-stamp.json'));
    const receipt = await install(root);
    expect(receipt.notes.join('\n')).toContain('could not record which voice settings it set');
  });

  test('a recorded stamp produces no such note', async () => {
    const root = dir();
    stampFile(root, {});
    const receipt = await install(root);
    expect(receipt.notes.join('\n')).not.toContain('could not record');
  });
});

describe('asking for a wake model before it is provisioned', () => {
  test('the error names the recovery step and not the managed path', () => {
    const root = dir();
    const service = createWakeSetupService({ managedVoiceRoot: root });
    let message = '';
    try { service.modelChunk({ component: 'classifier' }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('not provisioned');
    expect(message).toContain('voice.wake.provision');
    expect(message).not.toContain(root);
  });
});

describe('refusals a caller can act on', () => {
  test('an offset past the end of a wake model is a 400 naming the offset field', () => {
    const service = createWakeSetupService({
      managedVoiceRoot: dir(),
      artifactSize: () => 10,
      readArtifact: () => new Uint8Array(0),
    });
    let refusal: unknown;
    try { service.modelChunk({ component: 'classifier', offset: 11 }); } catch (error) { refusal = error; }
    expect(readGatewayVerbRefusal(refusal)).toMatchObject({ status: 400, code: 'INVALID_ARGUMENT', field: 'offset' });
  });

  test('an install refused under memory pressure is a 503 and starts no provision', async () => {
    let provisioned = false;
    const service = createVoiceSetupService({
      managedVoiceRoot: dir(),
      getConfig: () => '',
      setConfig: () => {},
      resetLocalEngineFailureState: () => {},
      admitExpensiveWork: () => ({ allowed: false, reason: 'under memory pressure' }),
      provision: async () => { provisioned = true; return ttsOnly('x'); },
    });
    let refusal: unknown;
    try { await service.install(); } catch (error) { refusal = error; }
    expect(readGatewayVerbRefusal(refusal)).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(provisioned).toBe(false);
  });
});
