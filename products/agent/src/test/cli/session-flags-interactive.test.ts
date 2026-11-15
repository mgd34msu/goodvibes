import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createSessionSurface, createShellPathService } from '@/runtime/index.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { applyInitialTuiCliState } from '../../cli/tui-startup.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import type { InputHandler } from '../../input/handler.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('session flags on the interactive launch', () => {
  test.each([
    [['--continue'], '--continue is only supported with run'],
    [['--session', 'abc'], '--session is only supported with run'],
    [['--fork'], 'Unknown option: --fork'],
    [['run', '--continue', '--resume', 'abc', 'hi'], 'Conflicting session lifecycle flags: --continue and --resume'],
  ])('%j is refused at parse time instead of being ignored', (argv, message) => {
    expect(parseGoodVibesCli(argv).errors.join('\n')).toContain(message);
  });

  test('a resume whose handler throws is printed, not left as an unhandled rejection', async () => {
    const root = makeProjectTempDir('gv-startup-resume-failure');
    const shellPaths = createShellPathService({ workingDirectory: join(root, 'workspace'), homeDirectory: join(root, 'home') });
    const registry = new CommandRegistry();
    registry.execute = async () => { throw new Error('session file is corrupt'); };
    const printed: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      applyInitialTuiCliState({
        cli: parseGoodVibesCli(['--resume', 'abc']),
        input: { prompt: '', cursorPos: 0, openAgentWorkspace: () => {} } as unknown as InputHandler,
        commandRegistry: registry,
        commandContext: { print: (text: string) => printed.push(text) } as unknown as CommandContext,
        shellPaths,
        surface: createSessionSurface({ surfaceRoot: 'agent', workingDirectory: shellPaths.workingDirectory, homeDirectory: shellPaths.homeDirectory }),
        render: () => {},
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(printed.join('\n')).toContain('Could not resume session abc: session file is corrupt');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
