import { describe, expect, test } from 'bun:test';
import { AGENT_CLI_CATALOG } from '../../cli/catalog.ts';
import { COMPLETION_COMMANDS, COMPLETION_OPTIONS, renderCompletion } from '../../cli/completion.ts';
import { resolveDoctorExitCode } from '../../cli/doctor-exit.ts';
import { renderGoodVibesHelp } from '../../cli/help.ts';
import { LOCAL_LIBRARY_BOOLEAN_OPTIONS, parseOptions } from '../../cli/local-library-command-shared.ts';
import { parseOperatorCommandArgs } from '../../cli/operator-command-args.ts';
import { listGoodVibesCliCommands, parseGoodVibesCli } from '../../cli/parser.ts';
import type { CliDoctorFinding } from '../../cli/status.ts';

function finding(id: string, severity: CliDoctorFinding['severity']): CliDoctorFinding {
  return { id, area: 'runtime', severity, summary: id, cause: '', impact: '', action: '' };
}

describe('flags that never take a value', () => {
  test('a boolean flag before a positional keeps the positional', () => {
    const parsed = parseOptions(['--yes', 'daily-brief']);
    expect(parsed.flags.has('yes')).toBe(true);
    expect(parsed.positionals).toEqual(['daily-brief']);
    expect(LOCAL_LIBRARY_BOOLEAN_OPTIONS).toContain('enabled');
    expect(parseOptions(['--enabled', 'foo', '--yes']).positionals).toEqual(['foo']);
  });

  test('a declared boolean operator flag leaves the next token alone', () => {
    const parsed = parseOperatorCommandArgs(['--trigger-fix-session', 'my/repo'], [], ['trigger-fix-session']);
    expect(parsed.booleanFlags.has('trigger-fix-session')).toBe(true);
    expect(parsed.positionals).toEqual(['my/repo']);
  });
});

describe('catalog flags', () => {
  test('a model id with a slash keeps the configured provider, a provider:model id names it', () => {
    expect(parseGoodVibesCli(['--model', 'meta-llama/Llama-3.1-8B']).flags.provider).toBeUndefined();
    expect(parseGoodVibesCli(['--model', 'openai:gpt-5.2']).flags.provider).toBe('openai');
  });

  test('a colon inside a model id is not read as a provider unless the prefix is one', () => {
    expect(parseGoodVibesCli(['--model', 'llama3:8b']).flags.provider).toBeUndefined();
    expect(parseGoodVibesCli(['--model', 'ollama:llama3:8b']).flags.provider).toBe('ollama');
  });

  test('session flags are refused where they would do nothing', () => {
    expect(parseGoodVibesCli(['--continue']).errors.join('\n')).toContain('only supported with run');
    expect(parseGoodVibesCli(['--session', 'abc']).errors.join('\n')).toContain('only supported with run');
    expect(parseGoodVibesCli(['--fork']).errors.join('\n')).toContain('Unknown option: --fork');
    expect(parseGoodVibesCli(['run', '--continue', 'hello']).errors).toEqual([]);
    expect(parseGoodVibesCli(['run', '--session', 'abc', 'hello']).errors).toEqual([]);
  });

  test('--port and --hostname apply to pair only', () => {
    expect(parseGoodVibesCli(['status', '--port', '4000']).errors.join('\n')).toContain('only applies to the pair command');
    expect(parseGoodVibesCli(['pair', '--port', '4000', '--hostname', 'lan']).errors).toEqual([]);
  });
});

describe('completion and help follow the catalog', () => {
  test('every command the parser knows is completed', () => {
    for (const command of listGoodVibesCliCommands()) {
      if (command === 'tui') continue;
      expect(COMPLETION_COMMANDS).toContain(command);
      expect(renderCompletion('bash')).toContain(command);
    }
  });

  test('every completed option is one the parser declares', () => {
    const declared = new Set(AGENT_CLI_CATALOG.globalFlags.flatMap((flag) => flag.tokens));
    for (const option of COMPLETION_OPTIONS) expect(declared.has(option)).toBe(true);
  });

  test('the top-level help names every command the parser knows', () => {
    const help = renderGoodVibesHelp();
    for (const command of listGoodVibesCliCommands()) {
      if (command === 'tui') continue;
      expect(help).toMatch(new RegExp(`(^|[\\s|])${command}([\\s|]|$)`, 'm'));
    }
  });

  test('every declared global flag is in the help text or is a run limit documented there', () => {
    const help = renderGoodVibesHelp();
    for (const flag of AGENT_CLI_CATALOG.globalFlags) {
      const long = flag.tokens.find((token) => token.startsWith('--'));
      if (long) expect(help).toContain(long);
    }
  });
});

describe('doctor exit code', () => {
  test('a warning alone does not fail a usable install, strict does', () => {
    const findings = [finding('external-runtime-unreachable', 'warning')];
    expect(resolveDoctorExitCode(findings)).toBe(0);
    expect(resolveDoctorExitCode(findings, true)).toBe(1);
  });

  test('a must-fix risk fails, a note does not, even under strict', () => {
    expect(resolveDoctorExitCode([finding('allow-all-permissions', 'risk')])).toBe(1);
    expect(resolveDoctorExitCode([finding('runtime-posture-0', 'note')])).toBe(0);
    expect(resolveDoctorExitCode([finding('runtime-posture-0', 'note')], true)).toBe(0);
    expect(resolveDoctorExitCode([])).toBe(0);
  });
});
