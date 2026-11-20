# Zod Schemas

Runtime Zod v4 schemas for the event envelope every SSE and WebSocket stream
carries.

| Schema | Describes | File |
|--------|-----------|------|
| `SerializedEventEnvelopeSchema` | SSE/WS envelope | `events.ts` |
| `TypedSerializedEventEnvelopeSchema` | SSE/WS typed envelope | `events.ts` |
| `RuntimeEventRecordSchema` | runtime event record | `events.ts` |

## Method responses

Operator method responses have one statement: the output schema each method
carries in the generated operator contract (`getOperatorContract()`,
`getOperatorMethod(id).outputSchema`). The operator client validates every JSON
response against it, so there is no second, hand-kept copy here to drift from
what the daemon sends.

## Import path

```ts
import { SerializedEventEnvelopeSchema } from '@goodvibes/engine/contracts';
// or the narrower subpath
import { SerializedEventEnvelopeSchema } from '@goodvibes/engine/contracts/zod-schemas/events';
```

## See also

- Main platform: [`@goodvibes/engine/platform`](../../../platform/README.md)
- [Getting Started](../../../docs/getting-started.md)
