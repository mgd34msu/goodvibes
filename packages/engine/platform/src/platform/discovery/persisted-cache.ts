import type { DiscoveredServer, ServerType } from './scanner.js';

const SERVER_TYPES: ReadonlySet<string> = new Set<ServerType>([
  'ollama', 'lm-studio', 'vllm', 'llamacpp', 'localai', 'tgi', 'jan',
  'gpt4all', 'koboldcpp', 'aphrodite', 'unknown',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isServerType(value: unknown): value is ServerType {
  return typeof value === 'string' && SERVER_TYPES.has(value);
}

function captureNumericMap(value: unknown): Record<string, number> | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  // Model IDs such as "__proto__" are ordinary keys. Missing IDs must not
  // resolve to inherited Object members when the registry reads token limits.
  const captured: Record<string, number> = Object.create(null);
  for (const [key, limit] of Object.entries(value)) {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) return null;
    captured[key] = limit;
  }
  return captured;
}

/** Model sizes as the server wrote them; anything else reads as "not reported". */
function captureSizeMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const captured: Record<string, string> = Object.create(null);
  for (const [key, size] of Object.entries(value)) if (typeof size === 'string' && size !== '') captured[key] = size;
  return Object.keys(captured).length > 0 ? captured : undefined;
}

/** One cache entry, validated with the same rules the loader applies. */
export function capturePersistedServer(value: unknown): DiscoveredServer | null {
  if (!isRecord(value)
    || typeof value.name !== 'string'
    || typeof value.host !== 'string'
    || typeof value.port !== 'number' || !Number.isFinite(value.port)
    || typeof value.baseURL !== 'string'
    || !Array.isArray(value.models) || !value.models.every((model: unknown) => typeof model === 'string')
    || !isServerType(value.serverType)) return null;

  const modelContextWindows = captureNumericMap(value.modelContextWindows);
  const modelOutputLimits = captureNumericMap(value.modelOutputLimits);
  if (modelContextWindows === null || modelOutputLimits === null) return null;
  const modelSizes = captureSizeMap(value.modelSizes);
  return {
    name: value.name,
    host: value.host,
    port: value.port,
    // This is a structural boundary, not route policy or semantic screening.
    // Preserve private routing bytes; catalog projection must omit the route.
    baseURL: value.baseURL,
    models: [...value.models],
    serverType: value.serverType,
    ...(modelContextWindows === undefined ? {} : { modelContextWindows }),
    ...(modelOutputLimits === undefined ? {} : { modelOutputLimits }),
    ...(modelSizes === undefined ? {} : { modelSizes }),
  };
}

/** Internal cache capture. Unknown fields never become runtime provider data. */
export function capturePersistedProviders(value: unknown): { servers: DiscoveredServer[]; invalid: boolean } {
  if (!Array.isArray(value)) return { servers: [], invalid: true };
  const servers: DiscoveredServer[] = [];
  let invalid = false;
  for (const item of value) {
    const server = capturePersistedServer(item);
    if (server === null) invalid = true;
    else servers.push(server);
  }
  return { servers, invalid };
}
