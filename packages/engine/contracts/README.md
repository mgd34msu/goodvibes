# @goodvibes/engine/contracts

Public runtime-neutral GoodVibes contract module for operator and peer artifacts, generated ids, lookup helpers, and schema exports.

Most applications should install `@goodvibes/engine` and import `@goodvibes/engine/platform/contracts`. These modules are subpath exports of the engine package.

Consumer import:

```ts
import {
  getOperatorContract,
  getOperatorMethod,
  type OperatorMethodOutput,
} from '@goodvibes/engine/platform/contracts';
```

This surface provides:
- operator contract lookup
- peer contract lookup
- operator method ids
- peer endpoint ids
- runtime event domains
- generated method, endpoint, and event payload types

Example:

```ts
import {
  getOperatorContract,
  getOperatorMethod,
  type OperatorMethodOutput,
} from '@goodvibes/engine/platform/contracts';

const contract = getOperatorContract();
const loginMethod = getOperatorMethod('control.auth.login');
type LoginOutput = OperatorMethodOutput<'control.auth.login'>;
```

Peer example:

```ts
import {
  getPeerContract,
  getPeerEndpoint,
  listPeerEndpoints,
} from '@goodvibes/engine/platform/contracts';

const peerContract = getPeerContract();
const pairEndpoint = getPeerEndpoint('pair.request');
const allEndpoints = listPeerEndpoints();
```

Lookup and guard helpers:

```ts
import {
  listOperatorMethods,
  isOperatorMethodId,
  isPeerEndpointId,
  RUNTIME_EVENT_DOMAINS,
  isRuntimeEventDomain,
} from '@goodvibes/engine/platform/contracts';

listOperatorMethods(); // readonly OperatorMethodContract[]
isOperatorMethodId('control.auth.login'); // true
isPeerEndpointId('pair.request'); // true
RUNTIME_EVENT_DOMAINS.forEach((domain) => isRuntimeEventDomain(domain));
```

This surface also exports the generated `OPERATOR_CONTRACT` and `PEER_CONTRACT`
manifests directly (for callers that want the raw data instead of the lookup
helpers above), the core-verb classification used to lint operator method ids
(`CORE_VERBS`, `BANNED_VERBS`, `EXEMPT_VERB_CATEGORIES`, `classifyVerb`), and
the key-mapping helpers the generated typed-IO maps are built with
(`RequiredNamedKeys`, `OmitNamed`, `NamedProps`, `IndexPart`), for consumers
writing their own generic helpers over `OperatorMethodInput`/`OperatorMethodOutput`.

Node-only artifact path helpers:

```ts
import {
  getOperatorContractPath,
  getPeerContractPath,
} from '@goodvibes/engine/platform/contracts/node';
```

For direct contract imports from the engine package, use
`@goodvibes/engine/contracts` and `@goodvibes/engine/contracts/node`:

```ts
import { getOperatorContract, getPeerContract } from '@goodvibes/engine/contracts';
import { getOperatorContractPath, getPeerContractPath } from '@goodvibes/engine/contracts/node';
```

See the [zod-schemas README](./src/zod-schemas/README.md) for the event-envelope
Zod schemas re-exported from this package root. Method response shapes come
from the generated operator contract only.
