/** The settings write refusal (the projector's one check) and the schema the admitted wrapper leaves. */
import { describe, expect, test } from 'bun:test';
import type { Tool } from '../platform/src/platform/types/tools.ts';
import {
  validateAgentSettingsMechanics,
  wrapSettingsToolForAdmittedAgentPolicy,
} from '../platform/src/platform/gate/policy/settings-write-policy.ts';
import { PAYMENTS_CARD_NUMBER_CONFIG_KEY } from '../platform/src/platform/config/payment-config-keys.ts';
import { agentSettingsWriteRefusal } from '../platform/src/platform/gate/policy/agent-settings-refusals.ts';

interface SettingsCall {
  readonly key: unknown;
  readonly value: unknown;
}

function makeSettingsTool(calls: SettingsCall[]): Tool {
  return {
    definition: {
      name: 'goodvibes_settings',
      description: 'original settings tool description',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['set', 'reset'] },
          key: { type: 'string' },
          value: {},
          confirm: { type: 'boolean' },
        },
        required: ['mode', 'key', 'confirm'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
    },
    execute: async (args) => {
      const record = args as { key?: unknown; value?: unknown };
      calls.push({ key: record.key, value: record.value });
      return { success: true, output: JSON.stringify({ key: record.key, persistedTo: '/daemon/settings.json' }) };
    },
  };
}

function guardedSettingsTool(): { tool: Tool; calls: SettingsCall[] } {
  const calls: SettingsCall[] = [];
  const tool = makeSettingsTool(calls);
  wrapSettingsToolForAdmittedAgentPolicy(tool);
  return { tool, calls };
}

describe('the admitted settings wrapper', () => {
  test('leaves the tool usable instead of emptying its schema', () => {
    const { tool } = guardedSettingsTool();
    const properties = tool.definition.parameters.properties as Record<string, unknown>;
    expect(properties.mode).toBeDefined();
    expect(properties.key).toBeDefined();
    expect(properties.value).toBeDefined();
    // Nothing reads request text, so the schema must not invite the model to supply it.
    expect(properties.explicitUserRequest).toBeUndefined();
    expect(tool.definition.sideEffects).toEqual(['state']);
    expect(tool.definition.description).not.toContain('Blocked');
  });

  test('a write that is not a settings set or reset, or names no registered key, is explained as refused', () => {
    for (const args of [{ mode: 'list' }, { mode: 'set', key: '   ', value: 'x' }, { mode: 'set', key: 'no.such.key', value: 'x' }]) {
      expect(validateAgentSettingsMechanics(args)).not.toBeNull();
    }
  });

  test('ordinary registered keys pass the mechanics check', () => {
    for (const key of ['surfaces.telegram.botUsername', 'surfaces.telegram.defaultChatId', 'provider.model', 'display.theme']) {
      expect(validateAgentSettingsMechanics({ mode: 'set', key, value: 'x' })).toBeNull();
    }
  });
});

describe('writes no permission can authorize', () => {
  const ownRef = 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_NTFY_TOKEN';

  test('payments limits go on to the normal admission; card material is refused by its key', () => {
    for (const key of ['payments.budget.dailyItem', 'payments.windows.vetoMinutes', 'payments.defaultCardId']) {
      expect(validateAgentSettingsMechanics({ mode: 'set', key, value: '1' })).toBeNull();
    }
    expect(agentSettingsWriteRefusal({ mode: 'set', key: PAYMENTS_CARD_NUMBER_CONFIG_KEY, value: '4111111111111111' })).toContain('secure card setup');
  });

  test('a credential destination is refused, so a stored token cannot be redirected to another host', () => {
    for (const key of ['surfaces.ntfy.baseUrl', 'surfaces.calendar.caldavUrl', 'surfaces.signal.bridgeUrl', 'surfaces.matrix.homeserverUrl']) {
      expect(validateAgentSettingsMechanics({ mode: 'set', key, value: 'https://attacker.example' })).toContain('only the owner changes it');
    }
    expect(validateAgentSettingsMechanics({ mode: 'reset', key: 'surfaces.ntfy.baseUrl' })).toBeNull();
  });

  test('a credential key may point only at its own stored secret', () => {
    expect(validateAgentSettingsMechanics({ mode: 'set', key: 'surfaces.ntfy.token', value: ownRef })).toBeNull();
    expect(validateAgentSettingsMechanics({ mode: 'set', key: 'surfaces.ntfy.token', value: '' })).toBeNull();
    for (const value of [
      'goodvibes://secrets/goodvibes/ANTHROPIC_API_KEY',
      'goodvibes://secrets/other/GOODVIBES_SURFACES_NTFY_TOKEN',
      'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_NTFY_TOKEN/extra',
    ]) {
      const denial = validateAgentSettingsMechanics({ mode: 'set', key: 'surfaces.ntfy.token', value });
      expect(denial).toContain(ownRef);
      expect(denial).toContain('Nothing was changed');
    }
    expect(validateAgentSettingsMechanics({ mode: 'set', key: 'surfaces.ntfy.token', value: 'raw-token-value' })).toContain(ownRef);
    expect(validateAgentSettingsMechanics({ mode: 'set', key: 'surfaces.ntfy.token', value: 12345 })).toContain('never a literal value');
  });

  test('the mail password references keep pointing at the daemon mailbox password', () => {
    expect(validateAgentSettingsMechanics({ mode: 'set', key: 'email.passwordRef', value: 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_EMAIL_PASSWORD' })).toBeNull();
    expect(validateAgentSettingsMechanics({ mode: 'set', key: 'email.passwordRef', value: 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_NTFY_TOKEN' })).toContain('may only point at its own stored secret');
  });
});
