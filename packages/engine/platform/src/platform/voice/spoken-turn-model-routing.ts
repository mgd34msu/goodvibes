import type { ConfigManager } from '../config/index.js';
import type { ModelDefinition, ProviderRegistry } from '../providers/index.js';
import type { ContentPart } from '../providers/index.js';
import type { Orchestrator, OrchestratorUserInputOptions } from '../core/index.js';
import { isSpokenTurnOrigin, SPOKEN_TURN_SOURCE } from './spoken-turn/controller.js';

type RunTurn = (
  text: string,
  content?: ContentPart[],
  options?: OrchestratorUserInputOptions,
  ...executionContext: readonly unknown[]
) => Promise<void>;

type PatchableOrchestrator = {
  runTurn?: RunTurn;
  setCoreServices: (services: { providerRegistry?: ProviderRegistry }) => void;
};

export interface SpokenTurnModelRoutingOptions {
  readonly orchestrator: Orchestrator;
  readonly providerRegistry: ProviderRegistry;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly notify?: ((message: string) => void) | undefined;
}

export function createSpokenTurnInputOptions(surface: string): OrchestratorUserInputOptions {
  return {
    origin: {
      source: SPOKEN_TURN_SOURCE,
      surface,
      metadata: { spokenOutput: true },
    },
  };
}

const routedOrchestrators = new WeakSet<object>();

export function attachSpokenTurnModelRouting(options: SpokenTurnModelRoutingOptions): () => void {
  const target = options.orchestrator as unknown as PatchableOrchestrator;
  if (typeof target.runTurn !== 'function') {
    // A silent no-op here made tts.llmModel routing vanish whenever the
    // orchestrator's turn entry point was renamed.
    throw new Error('Spoken-turn model routing cannot attach: the orchestrator has no runTurn method to route through.');
  }
  if (routedOrchestrators.has(target)) {
    throw new Error('Spoken-turn model routing is already attached to this orchestrator; detach it before attaching again.');
  }
  const originalRunTurn = target.runTurn.bind(options.orchestrator);

  // This adapter changes only provider selection. Private execution context,
  // including opaque native admission, must cross it unchanged.
  let attached = true;
  const routedRunTurn = async (...args: Parameters<RunTurn>): Promise<void> => {
    const inputOptions = args[2];
    if (!attached || !isSpokenTurnOrigin(inputOptions?.origin)) {
      await originalRunTurn(...args);
      return;
    }

    const override = resolveSpokenTurnModelOverride({
      providerRegistry: options.providerRegistry,
      configManager: options.configManager,
      notify: options.notify,
    });
    if (!override) {
      await originalRunTurn(...args);
      return;
    }

    const routedRegistry = createRoutedProviderRegistry(options.providerRegistry, override);
    target.setCoreServices({ providerRegistry: routedRegistry });
    try {
      await originalRunTurn(...args);
    } finally {
      target.setCoreServices({ providerRegistry: options.providerRegistry });
    }
  };
  target.runTurn = routedRunTurn;
  routedOrchestrators.add(target);

  return () => {
    attached = false;
    routedOrchestrators.delete(target);
    // A wrapper added after this one owns runTurn now; putting the original back
    // would silently remove it.
    if (target.runTurn === routedRunTurn) target.runTurn = originalRunTurn;
    target.setCoreServices({ providerRegistry: options.providerRegistry });
  };
}

export function resolveSpokenTurnModelOverride(options: {
  readonly providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getCurrentModel'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly notify?: ((message: string) => void) | undefined;
}): ModelDefinition | null {
  const modelRef = readConfigString(options.configManager, 'tts.llmModel');
  if (!modelRef) return null;

  const providerId = readConfigString(options.configManager, 'tts.llmProvider');
  const current = options.providerRegistry.getCurrentModel();
  const model = options.providerRegistry.listModels().find((candidate) => {
    const refMatches = candidate.registryKey === modelRef || candidate.id === modelRef;
    const providerMatches = !providerId || candidate.provider === providerId;
    return refMatches && providerMatches;
  });

  if (!model) {
    options.notify?.(`[TTS] Configured TTS LLM '${modelRef}' was not found; using current chat model.`);
    return null;
  }
  if (model.selectable === false) {
    options.notify?.(`[TTS] Configured TTS LLM '${modelRef}' is not selectable; using current chat model.`);
    return null;
  }
  if ((model.registryKey ?? model.id) === (current.registryKey ?? current.id)) return null;
  return model;
}

function createRoutedProviderRegistry(providerRegistry: ProviderRegistry, model: ModelDefinition): ProviderRegistry {
  return new Proxy(providerRegistry, {
    get(target, prop, receiver) {
      if (prop === 'getCurrentModel') return () => model;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function readConfigString(configManager: Pick<ConfigManager, 'get'>, key: 'tts.llmProvider' | 'tts.llmModel'): string {
  return String(configManager.get(key) ?? '').trim();
}
