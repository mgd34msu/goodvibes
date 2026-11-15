/**
 * What a conversational turn is told it can do matches what it is given: every
 * tool or action the standing instructions name exists, and the tools that can
 * read personal data or send requests anywhere are withheld from a channel the
 * owner has not declared theirs.
 */
import { describe, expect, test } from 'bun:test';
import {
  CONVERSATIONAL_TURN_TOOLS,
  OCCASION_ACKNOWLEDGEMENT_INSTRUCTION,
  OCCASION_COMPLAINT_LADDER,
  conversationalTurnCapabilities,
} from '../platform/src/platform/personal-capture/spawn-contract.ts';
import { PROFILE_TOOL_SCHEMA } from '../platform/src/platform/tools/profile/schema.ts';

const owned = { get: (key: string) => key === 'profile.ownerChannels' ? 'telegram' : '' } as const;

describe('standing instructions name only what exists', () => {
  test('every backticked tool, action or parameter is a real one', () => {
    const properties = PROFILE_TOOL_SCHEMA.parameters.properties as Record<string, { enum?: string[] }>;
    const actions = properties['action']?.enum ?? [];
    const named = [...OCCASION_ACKNOWLEDGEMENT_INSTRUCTION, ...OCCASION_COMPLAINT_LADDER].join('\n').match(/`[A-Za-z_]+`/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const token of named.map((t) => t.slice(1, -1))) {
      const known = CONVERSATIONAL_TURN_TOOLS.includes(token) || actions.includes(token) || Object.hasOwn(properties, token);
      expect(known, `${token} is named in the instructions but is not a tool, action or parameter`).toBe(true);
    }
  });
});

describe('the complaint ladder offers only what the turn can do', () => {
  const ladder = OCCASION_COMPLAINT_LADDER.join('\n');
  const actions = ((PROFILE_TOOL_SCHEMA.parameters.properties as Record<string, { enum?: string[] }>)['action']?.enum) ?? [];

  test('every rung the turn can act on names a real profile action', () => {
    const rungs = ladder.split(/\n\s+(?=\d\.\s)/).slice(1);
    const acted = rungs.filter((rung) => !rung.includes('not something you can do'));
    expect(acted.length).toBeGreaterThan(0);
    for (const rung of acted) {
      const named = (rung.match(/`[a-z_]+`/g) ?? []).map((t) => t.slice(1, -1));
      expect(named.some((token) => actions.includes(token)), `a rung offers an action the profile tool does not have: ${rung.split('\n')[0]}`).toBe(true);
    }
  });

  test('removing a date or switching reminders off is handed to the owner, not promised', () => {
    expect(ladder).toContain('not something you can do from here');
    expect(ladder).toContain('settings');
    // Dates live in the profile document; only lead time and the on/off switch are settings.
    expect(ladder).toContain('deletes');
    expect(ladder).toContain('occasions.leadDays');
    expect(ladder).not.toMatch(/settings \(occasions\)/);
    // Wording that offered removal or a feature switch as the turn's own remedy.
    expect(ladder).not.toMatch(/removing it\s+outright|Turn the whole occasions feature off/);
  });
});

describe('tools by channel authority', () => {
  test('a channel the owner has not declared gets neither profile nor fetch, even if routing asks for them', () => {
    const plain = conversationalTurnCapabilities({ surfaceKind: 'telegram', routed: true });
    expect(plain.tools).toEqual(['read', 'find']);
    const asked = conversationalTurnCapabilities({ surfaceKind: 'telegram', routed: true }, { tools: ['read', 'fetch', 'profile'] });
    expect(asked.tools).toEqual(['read']);
  });

  test('a channel listed in profile.ownerChannels gets the full set', () => {
    const own = conversationalTurnCapabilities({ surfaceKind: 'telegram', routed: true }, { configReader: owned });
    expect(own.tools).toEqual([...CONVERSATIONAL_TURN_TOOLS]);
  });

  test('a reminder destination alone does not grant capture', () => {
    const nudgeOnly = { get: (key: string) => key === 'occasions.nudgeChannel' ? 'telegram' : '' } as const;
    expect(conversationalTurnCapabilities({ surfaceKind: 'telegram', routed: true }, { configReader: nudgeOnly }).captureAuthority.canCapture).toBe(false);
  });
});
