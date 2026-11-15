import { describe, expect, test } from 'bun:test';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { compactRegisteredToolDefinitions, CORE_TOOL_NAMES, fullToolDefinition } from '../../tools/tool-definition-compaction.ts';

function makeTool(name: string, description: string): Tool {
  return {
    definition: {
      name,
      description,
      parameters: {
        type: 'object',
        description: 'Top-level schema description that should not be model-visible after compaction.',
        properties: {
          target: {
            type: 'string',
            description: 'Long parameter description that should be discoverable through harness detail, not repeated in every model request.',
          },
          nested: {
            type: 'object',
            description: 'Nested schema description that should also be stripped.',
            properties: {
              value: {
                type: 'string',
                description: 'Nested value description.',
              },
            },
          },
        },
        required: ['target'],
        additionalProperties: false,
      },
    },
    execute: async () => ({ success: true, output: 'ok' }),
  };
}

describe('compactRegisteredToolDefinitions', () => {
  test('uses curated summaries for platform and Agent tools', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('read', 'Verbose read tool description that should never reach the model catalog.'));
    registry.register(makeTool('goodvibes_context', 'Verbose runtime context description that should never reach the model catalog.'));
    registry.register(makeTool('autonomy', 'Verbose autonomy route description that should never reach the model catalog.'));
    registry.register(makeTool('channels', 'Verbose channel route description that should never reach the model catalog.'));
    registry.register(makeTool('computer', 'Verbose computer route description that should never reach the model catalog.'));
    registry.register(makeTool('context', 'Verbose context route description that should never reach the model catalog.'));
    registry.register(makeTool('delegation', 'Verbose delegation route description that should never reach the model catalog.'));
    registry.register(makeTool('device', 'Verbose device and browser route description that should never reach the model catalog.'));
    registry.register(makeTool('execution', 'Verbose execution route description that should never reach the model catalog.'));
    registry.register(makeTool('host', 'Verbose GoodVibes host description that should never reach the model catalog.'));
    registry.register(makeTool('memory', 'Verbose memory route description that should never reach the model catalog.'));
    registry.register(makeTool('models', 'Verbose model and provider route description that should never reach the model catalog.'));
    registry.register(makeTool('personal_ops', 'Verbose personal operations description that should never reach the model catalog.'));
    registry.register(makeTool('research', 'Verbose research workflow description that should never reach the model catalog.'));
    registry.register(makeTool('settings', 'Verbose settings description that should never reach the model catalog.'));
    registry.register(makeTool('setup', 'Verbose setup tool description that should never reach the model catalog.'));
    registry.register(makeTool('vibe', 'Verbose VIBE.md personality description that should never reach the model catalog.'));
    registry.register(makeTool('workspace', 'Verbose workspace route description that should never reach the model catalog.'));
    registry.register(makeTool('agent_local_registry', 'Verbose local registry description that should never reach the model catalog.'));
    registry.register(makeTool('agent_review_packet_presets', 'Verbose review packet preset description that should never reach the model catalog.'));

    compactRegisteredToolDefinitions(registry);

    const descriptions = new Map(registry.getToolDefinitions().map((definition) => [definition.name, definition.description]));
    // A core tool keeps its own description rather than the curated summary.
    expect(descriptions.get('read')).toBe('Verbose read tool description that should never reach the model catalog.');
    expect(descriptions.get('goodvibes_context')).toBe('Inspect current GoodVibes runtime and host harness.');
    expect(descriptions.get('autonomy')).toBe('Route ongoing work and inspect visible autonomy.');
    expect(descriptions.get('channels')).toBe('Inspect channel readiness, setup, triage, and receipts.');
    expect(descriptions.get('computer')).toBe('Inspect/open browser, desktop, and computer routes.');
    expect(descriptions.get('context')).toBe('Inspect project instructions and prompt context.');
    expect(descriptions.get('delegation')).toBe('Inspect build delegation routes and policy.');
    expect(descriptions.get('device')).toBe('Inspect/open device, voice, and browser routes.');
    expect(descriptions.get('execution')).toBe('Inspect local work routes, history, and recovery.');
    expect(descriptions.get('host')).toBe('Inspect GoodVibes host status, services, and methods.');
    expect(descriptions.get('memory')).toBe('Inspect memory posture, providers, curator, records.');
    expect(descriptions.get('models')).toBe('Inspect model routes, providers, cookbook, and checks.');
    expect(descriptions.get('personal_ops')).toBe('Brief, route, inspect, and read Personal Ops.');
    expect(descriptions.get('research')).toBe('Plan, track, source, and save research.');
    expect(descriptions.get('settings')).toBe('List, inspect, change, reset, or import settings.');
    expect(descriptions.get('setup')).toBe('Inspect and complete first-run Agent setup.');
    expect(descriptions.get('vibe')).toBe('Inspect/create/import VIBE.md personality.');
    expect(descriptions.get('workspace')).toBe('Inspect or run workspace actions, commands, keys.');
    expect(descriptions.get('agent_local_registry')).toBe('Inspect/update Agent memory, notes, skills, routines.');
    expect(descriptions.get('agent_review_packet_presets')).toBe('Save/list/refresh Document Ops packet presets.');
    for (const description of descriptions.values()) {
      expect(description).not.toContain('...');
    }
    for (const [name, description] of descriptions) if (!CORE_TOOL_NAMES.has(name)) expect(description.length).toBeLessThanOrEqual(56);
  });

  test('keeps model-visible tool definitions compact while preserving schema shape', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('agent_harness', 'This description is replaced by the Agent-specific harness override.'));
    registry.register(makeTool(
      'custom_long_description',
      'This custom tool description is intentionally verbose so the compaction pass has to shorten it before the model receives the registered tool catalog.',
    ));

    compactRegisteredToolDefinitions(registry);

    const definitions = registry.getToolDefinitions();
    const harness = definitions.find((definition) => definition.name === 'agent_harness');
    const custom = definitions.find((definition) => definition.name === 'custom_long_description');
    expect(harness?.description).toBe('Harness catalog: modes, settings, commands, UI, tools.');
    expect(harness?.description.length).toBeLessThanOrEqual(56);
    expect(custom?.description.length).toBeLessThanOrEqual(56);

    const parametersJson = JSON.stringify(custom?.parameters);
    expect(parametersJson).toContain('"target"');
    expect(parametersJson).toContain('"required":["target"]');
    expect(parametersJson).not.toContain('"description"');
  });
});

test('compacting one catalog preserves a shared definition used by another tool instance', () => {
  const first = makeTool('agent', 'Original full subagent instructions.');
  const second = { ...first };
  const original = structuredClone(second.definition);
  const registry = new ToolRegistry(); registry.register(first);
  compactRegisteredToolDefinitions(registry);
  expect(second.definition).toEqual(original);
  expect(first.definition.description).toBe('Original full subagent instructions.');
  expect(first.definition.parameters).not.toBe(second.definition.parameters);
});

function describedTool(name: string): Tool {
  const long = 'First sentence of the parameter. Second sentence that explains the value in a good deal more detail than any model needs on every single request. Third sentence, longer still, with even more words so the limit is certainly exceeded. Fourth sentence, which adds still more words so that even the larger core limit is passed by a wide margin.';
  return {
    definition: {
      name,
      description: 'Does one thing well. Then a second sentence describing a mode. '.repeat(8),
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', description: 'Operation. One of a, b.' },
          target: { type: 'string', description: long },
          description: { type: 'string', description: 'A parameter literally named description.' },
        },
        required: ['mode'],
      },
    },
    execute: async () => ({ success: true, output: 'ok' }),
  };
}

describe('tiers', () => {
  test('a core tool keeps its parameter descriptions, cut to whole sentences', () => {
    const registry = new ToolRegistry(); registry.register(describedTool('read'));
    compactRegisteredToolDefinitions(registry);
    const properties = (registry.getToolDefinitions()[0]!.parameters as { properties: Record<string, { description?: string }> }).properties;
    expect(properties.mode!.description).toBe('Operation. One of a, b.');
    const kept = properties.target!.description!;
    expect(kept.startsWith('First sentence of the parameter.')).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(240);
    expect(kept).not.toContain('Fourth sentence');
    expect(kept.endsWith('.')).toBe(true);
    expect(registry.getToolDefinitions()[0]!.description.endsWith('.')).toBe(true);
  });

  test('another tool is advertised bare except for its mode, and a parameter named description survives', () => {
    const registry = new ToolRegistry(); registry.register(describedTool('rarely_used'));
    compactRegisteredToolDefinitions(registry);
    const definition = registry.getToolDefinitions()[0]!;
    const properties = (definition.parameters as { properties: Record<string, { description?: string; type?: string }> }).properties;
    expect(properties.mode!.description).toBe('Operation. One of a, b.');
    expect(properties.target).toEqual({ type: 'string' });
    expect(properties.description).toEqual({ type: 'string' });
  });

  test('the full definition stays available for discovery and survives a second pass', () => {
    const tool = describedTool('rarely_used');
    const original = structuredClone(tool.definition);
    const registry = new ToolRegistry(); registry.register(tool);
    compactRegisteredToolDefinitions(registry);
    compactRegisteredToolDefinitions(registry);
    expect(fullToolDefinition(registry, 'rarely_used')).toEqual(original);
    expect(fullToolDefinition(registry, 'missing')).toBeUndefined();
  });
});
