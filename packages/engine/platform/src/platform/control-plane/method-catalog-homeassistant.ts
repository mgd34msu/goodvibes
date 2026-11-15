/**
 * Method descriptors for the Home Assistant conversation routes, which a
 * sub-router serves ahead of the shared route table. Declaring them keeps the
 * scope each verb enforces visible to clients and to the scope-aware tokens
 * that gate them.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  EMPTY_OBJECT_SCHEMA,
  JSON_OBJECT_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  bodyEnvelopeSchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

const CONVERSATION_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  status: STRING_SCHEMA,
  messageId: STRING_SCHEMA,
  conversationId: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  error: STRING_SCHEMA,
}, ['ok', 'status'], { additionalProperties: true });

export const builtinGatewayHomeAssistantMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'homeassistant.conversation.health',
    title: 'Home Assistant Conversation Health',
    description: 'Report whether the Home Assistant surface is enabled and the conversation endpoints it serves.',
    category: 'channels',
    scopes: ['read:sessions'],
    http: { method: 'GET', path: '/api/homeassistant/health' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: JSON_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'homeassistant.conversation.submit',
    title: 'Submit Home Assistant Conversation Message',
    description: 'Post one utterance to the isolated chat session of a Home Assistant conversation and wait for the reply (or return at once with wait false). A providerId or modelId of the caller\'s choosing needs an admin token. A tools list is refused.',
    category: 'channels',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/homeassistant/conversation' },
    inputSchema: bodyEnvelopeSchema({
      message: STRING_SCHEMA, conversationId: STRING_SCHEMA, messageId: STRING_SCHEMA, threadId: STRING_SCHEMA,
      surfaceId: STRING_SCHEMA, providerId: STRING_SCHEMA, modelId: STRING_SCHEMA, wait: BOOLEAN_SCHEMA, timeoutMs: NUMBER_SCHEMA,
    }, ['message']),
    outputSchema: CONVERSATION_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'homeassistant.conversation.stream',
    title: 'Stream Home Assistant Conversation Message',
    description: 'Post one utterance and stream the reply as server-sent events: delta frames, then one final or error frame. A providerId or modelId of the caller\'s choosing needs an admin token.',
    category: 'channels',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/homeassistant/conversation/stream' },
    inputSchema: bodyEnvelopeSchema({
      message: STRING_SCHEMA, conversationId: STRING_SCHEMA, messageId: STRING_SCHEMA, threadId: STRING_SCHEMA,
      surfaceId: STRING_SCHEMA, providerId: STRING_SCHEMA, modelId: STRING_SCHEMA,
    }, ['message']),
    outputSchema: JSON_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'homeassistant.conversation.cancel',
    title: 'Cancel Home Assistant Conversation Turn',
    description: 'Stop the running turn of a Home Assistant chat session, named by sessionId or by a known messageId. The session stays open. A session that is not a Home Assistant chat session answers 404.',
    category: 'channels',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/homeassistant/conversation/cancel' },
    inputSchema: bodyEnvelopeSchema({ sessionId: STRING_SCHEMA, messageId: STRING_SCHEMA }),
    outputSchema: objectSchema({ ok: BOOLEAN_SCHEMA, sessionId: STRING_SCHEMA, status: STRING_SCHEMA }, ['ok'], { additionalProperties: true }),
  }),
];
