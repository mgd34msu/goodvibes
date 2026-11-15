import { afterEach, describe, it, expect } from 'bun:test';
import { shellSplit } from '../platform/src/platform/utils/shell-split.js';
import { fireTriggers, type TriggerExecutionOptions } from '../platform/src/platform/workflow/trigger-executor.js';
import { AutomationCommands } from '../platform/src/platform/workflow/automation-commands.js';
import type { HookEvent } from '../platform/src/platform/hooks/types.js';
import type { TriggerDefinition } from '../platform/src/platform/tools/workflow/index.js';

describe('shellSplit', () => {
  it('splits simple space-separated args', () => {
    expect(shellSplit('echo hello world')).toEqual(['echo', 'hello', 'world']);
  });

  it('preserves spaces inside double-quoted strings', () => {
    expect(shellSplit('echo "hello world"')).toEqual(['echo', 'hello world']);
  });

  it('handles backslash-escaped spaces outside quotes', () => {
    expect(shellSplit('path/with\\ space')).toEqual(['path/with space']);
  });

  it('preserves spaces inside single-quoted strings', () => {
    expect(shellSplit("notify-send 'build done'")).toEqual(['notify-send', 'build done']);
  });

  it('handles double-quote escape sequences', () => {
    expect(shellSplit('echo "say \\"hi\\""')).toEqual(['echo', 'say "hi"']);
  });

  it('handles multiple quoted and unquoted segments concatenated', () => {
    expect(shellSplit('echo "hello"world')).toEqual(['echo', 'helloworld']);
  });

  it('returns empty array for empty string', () => {
    expect(shellSplit('')).toEqual([]);
  });

  it('handles extra whitespace between args', () => {
    expect(shellSplit('echo   hello   world')).toEqual(['echo', 'hello', 'world']);
  });

  it('handles backslash-escaped backslash inside double quotes', () => {
    expect(shellSplit('echo "a\\\\b"')).toEqual(['echo', 'a\\b']);
  });
});

describe('shellSplit in strict mode', () => {
  it('keeps an empty quoted word as an empty argument', () => {
    expect(shellSplit('a "" b', { strict: true })).toEqual(['a', '', 'b']);
    expect(shellSplit("notify-send '' 'body'", { strict: true })).toEqual(['notify-send', '', 'body']);
  });

  it('an empty quoted region joined to text adds nothing, and extra whitespace adds no words', () => {
    expect(shellSplit('a ""x', { strict: true })).toEqual(['a', 'x']);
    expect(shellSplit('a   b', { strict: true })).toEqual(['a', 'b']);
  });

  it('throws on an unterminated quote instead of swallowing the rest of the input', () => {
    expect(() => shellSplit('"abc', { strict: true })).toThrow('Unterminated double quote');
    expect(() => shellSplit("echo 'abc def", { strict: true })).toThrow('Unterminated single quote');
  });

  it('leaves the default behaviour unchanged: empty words are dropped and an open quote runs to the end', () => {
    expect(shellSplit('a "" b')).toEqual(['a', 'b']);
    expect(shellSplit('"abc def')).toEqual(['abc def']);
  });
});

describe('trigger actions are split strictly', () => {
  const commands = new AutomationCommands();
  afterEach(() => { commands.stop(); });

  const event: HookEvent = {
    path: 'Post:tool:exec', phase: 'Post', category: 'tool', specific: 'exec',
    sessionId: 'synthetic', timestamp: 0, payload: {},
  };
  const trigger = (action: string): TriggerDefinition =>
    ({ id: 't1', enabled: true, event: 'Post:tool:exec', action }) as TriggerDefinition;

  function fakeSpawn() {
    const argvs: string[][] = [];
    const spawn = ((argv: string[]) => {
      argvs.push(argv);
      return { pid: 1, exited: new Promise<number>(() => {}), kill() {} };
    }) as unknown as NonNullable<TriggerExecutionOptions['spawn']>;
    return { spawn, argvs };
  }

  it('passes an intentional empty argument through in its position', async () => {
    const { spawn, argvs } = fakeSpawn();
    const [result] = await fireTriggers(event, { list: () => [trigger('notify-send "" \'body\'')], commands }, { spawn });
    expect(result?.executed).toBe(true);
    expect(argvs).toEqual([['notify-send', '', 'body']]);
  });

  it('refuses an action with an unterminated quote and says why, without starting it', async () => {
    const { spawn, argvs } = fakeSpawn();
    const [result] = await fireTriggers(event, { list: () => [trigger('notify-send "build done')], commands }, { spawn });
    expect(result?.executed).toBe(false);
    expect(result?.error).toContain('Action could not be parsed');
    expect(result?.error).toContain('Unterminated double quote');
    expect(argvs).toEqual([]);
  });
});
