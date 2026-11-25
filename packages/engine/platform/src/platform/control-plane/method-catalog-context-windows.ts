/**
 * method-catalog-context-windows.ts: a terminal program posts a context limit its own turn learned from a provider
 * (routes/context-windows-learned.ts), the way it posts the hooks it ran (method-catalog-hooks.ts).
 */
import { BOOLEAN_SCHEMA, NUMBER_SCHEMA, STRING_SCHEMA, methodDescriptor, objectSchema, stringEnumSchema, type GatewayMethodDescriptor } from './method-catalog-shared.js';

export const CONTEXT_WINDOW_LEARNED_POST_METHOD_ID = 'context.windows.learned.post';

export const builtinGatewayContextWindowMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: CONTEXT_WINDOW_LEARNED_POST_METHOD_ID,
    // A limit already known (a refusal no lower, an accepted input no larger) changes nothing.
    repeat: 'safe',
    title: 'Post A Learned Context Limit',
    description: 'A terminal program (the terminal app, the Agent) tells the daemon what a provider showed its own turn about a model\'s context window: a request of so many tokens was refused as too long, or an input of so many tokens went through. The daemon keeps it in its one context-window file (a learned limit only lowers, an accepted floor only rises, a size the person set stays), says the list changed (LIST_CHANGED context-windows), and every program reads the file again before its next turn. The capability context.window reads it; context.clear-window forgets it.',
    category: 'providers',
    effects: ['control-plane.write'],
    transport: ['ws'],
    inputSchema: objectSchema({
      program: stringEnumSchema(['tui', 'agent']),
      model: STRING_SCHEMA,
      tokens: NUMBER_SCHEMA,
      outcome: stringEnumSchema(['refused', 'accepted']),
    }, ['program', 'model', 'tokens', 'outcome']),
    outputSchema: objectSchema({ kept: BOOLEAN_SCHEMA }, ['kept']),
  }),
];
