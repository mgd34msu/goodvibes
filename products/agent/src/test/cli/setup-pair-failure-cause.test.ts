import { describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { runSetupPairingCommand } from '../../cli/setup-pair-command.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('setup pair failure reporting', () => {
  test('a failure before any credential request names its cause instead of reporting an interruption', async () => {
    const homeDirectory = makeProjectTempDir('setup-pair-cause');
    const configManager = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, configDir: join(homeDirectory, '.goodvibes', 'agent'), workingDir: homeDirectory, homeDir: homeDirectory });
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const written: string[] = [];
    try {
      const code = await runSetupPairingCommand(
        { cli: parseGoodVibesCli(['setup', 'pair']), configManager, homeDirectory, workingDirectory: homeDirectory },
        { interactive: true, write: (text) => { written.push(text); throw new Error('stdout closed'); }, question: async () => '' },
      );
      expect(code).toBe(1);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('stdout closed'));
      expect(written.join('\n')).not.toContain('Pairing interrupted');
    } finally {
      errors.mockRestore();
    }
  });
});
