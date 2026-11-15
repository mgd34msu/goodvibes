import { describe, expect, test } from 'bun:test';
import { createTtsRuntimeCommands } from '../terminal-shell/src/tts-runtime-commands.js';

type Handler = (args: string[], ctx: unknown) => void;
function run(stop: (() => boolean | void) | undefined): string[] {
  const printed: string[] = [];
  let handler: Handler | undefined;
  createTtsRuntimeCommands<never>({ hidden: false, alwaysSpeakControls: true, description: '' })
    .registerTtsRuntimeCommands({ register: (command: { handler: Handler }) => { handler = command.handler; } } as never);
  handler!(['stop'], { print: (m: string) => printed.push(m), renderRequest() {}, platform: { configManager: {} }, stopSpokenOutput: stop });
  return printed;
}

describe('/tts stop', () => {
  test('says nothing was playing when the port reports that', () => {
    expect(run(() => false)).toEqual(['Nothing is playing.']);
  });
  test('confirms the stop when something was playing', () => {
    expect(run(() => true)).toEqual(['Live TTS playback stopped.']);
  });
  test('says live TTS is unavailable when the context has no stop port', () => {
    expect(run(undefined)).toEqual(['Live TTS is not available in this runtime.']);
  });
});
