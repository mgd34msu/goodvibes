import { describe, expect, test } from 'bun:test';
import { parseSlashCommand, SLASH_COMMANDS } from './slash-commands';

describe('parseSlashCommand', () => {
  test('a bare /new, in any case and with surrounding space, is the new-chat command', () => {
    expect(parseSlashCommand('/new')).toBe('new');
    expect(parseSlashCommand('  /NEW ')).toBe('new');
  });

  test('ordinary text and other slash words are not commands', () => {
    expect(parseSlashCommand('/new chat please')).toBeNull();
    expect(parseSlashCommand('/clear')).toBeNull();
    expect(parseSlashCommand('hello /new')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });

  test('every offered command is one the parser recognizes', () => {
    for (const command of SLASH_COMMANDS) expect(parseSlashCommand(`/${command.name}`)).toBe(command.name);
  });
});
