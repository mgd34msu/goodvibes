import type { ToolDefinition } from '../../types/tools.js';

export const PACKET_TOOL_SCHEMA: ToolDefinition = {
  name: 'packet',
  description: 'Keep your own notes as implementation packets (draft, revise, publish). Packets are stored in a file for later reference; nothing consumes them or sends them to anyone.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['create', 'list', 'show', 'revise', 'publish'] },
      view: { type: 'string', enum: ['summary', 'full'] },
      packetId: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string' },
      goals: { type: 'array', items: { type: 'string' } },
      constraints: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
      audience: { type: 'string' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface PacketToolInput {
  readonly mode: 'create' | 'list' | 'show' | 'revise' | 'publish';
  readonly view?: 'summary' | 'full' | undefined;
  readonly packetId?: string | undefined;
  readonly title?: string | undefined;
  readonly summary?: string | undefined;
  readonly goals?: readonly string[] | undefined;
  readonly constraints?: readonly string[] | undefined;
  readonly risks?: readonly string[] | undefined;
  readonly audience?: string | undefined;
}
