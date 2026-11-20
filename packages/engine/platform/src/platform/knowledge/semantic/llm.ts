import type { ProviderRegistry } from '../../providers/registry.js';
import { callWithFailover, type FailoverTarget } from '../../providers/failover.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import type { KnowledgeSemanticLlm } from './types.js';
import { extractJsonObject } from './utils.js';

/** Why a generation request produced nothing: the provider's error, a timeout, or a reply with no JSON. */
export class KnowledgeSemanticGenerationError extends Error {
  override readonly name = 'KnowledgeSemanticGenerationError';
  constructor(readonly reason: string, options?: ErrorOptions) { super(`Semantic generation failed: ${reason}`, options); }
}

/** A JSON generation (one per enriched source) that names no timeout is bounded by this. */
const DEFAULT_JSON_GENERATION_TIMEOUT_MS = 120_000;

type CompletionOutcome = { readonly text: string | null } | { readonly failure: string; readonly cause?: unknown };

export interface ProviderBackedKnowledgeSemanticLlmOptions {
  readonly timeoutMs?: number | undefined;
  readonly maxConcurrent?: number | undefined;
}

export function createProviderBackedKnowledgeSemanticLlm(
  providerRegistry: ProviderRegistry,
  options: ProviderBackedKnowledgeSemanticLlmOptions = {},
): KnowledgeSemanticLlm {
  const limiter = new SemanticLlmLimiter(Math.max(1, options.maxConcurrent ?? 1));
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  return {
    // A failed generation is reported with its reason, so the caller can say why
    // a source was not enriched instead of guessing from an empty result.
    completeJson: async (input) => limiter.run(async () => {
      const outcome = await completeWithCurrentModel(providerRegistry,
        { ...input, timeoutMs: input.timeoutMs ?? (timeoutMs || DEFAULT_JSON_GENERATION_TIMEOUT_MS) });
      if ('failure' in outcome) throw new KnowledgeSemanticGenerationError(outcome.failure, { cause: outcome.cause });
      if (!outcome.text) return null;
      const json = extractJsonObject(outcome.text);
      if (json === null || json === undefined) throw new KnowledgeSemanticGenerationError('the reply held no JSON object');
      return json;
    }),
    completeText: async (input) => limiter.run(async () => {
      const outcome = await completeWithCurrentModel(providerRegistry, { ...input, timeoutMs: input.timeoutMs ?? timeoutMs });
      return 'failure' in outcome ? null : outcome.text;
    }),
  };
}

async function completeWithCurrentModel(
  providerRegistry: ProviderRegistry,
  input: {
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly maxTokens?: number | undefined;
    readonly purpose: string;
    readonly signal?: AbortSignal | undefined;
    readonly timeoutMs?: number | undefined;
  },
): Promise<CompletionOutcome> {
  const timeoutMs = Math.max(0, input.timeoutMs ?? 0);
  const controller = new AbortController();
  const timeoutSentinel = Symbol('semantic-timeout');
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = (): void => controller.abort();
  if (input.signal?.aborted) return { text: null };
  input.signal?.addEventListener('abort', abortFromParent, { once: true });
  try {
    const current = providerRegistry.getCurrentModel();
    const first: FailoverTarget = {
      model: { registryKey: current.registryKey, provider: current.provider, displayName: current.displayName },
      modelId: current.id,
      provider: providerRegistry.getForModel(current.registryKey, current.provider),
    };
    // The model fails over like a turn: its other sign-ins, then provider.fallbackModels; the timeout bounds the whole call.
    const chatPromise = callWithFailover({ registry: providerRegistry, first, purpose: `Knowledge (${input.purpose})`, signal: controller.signal },
      (target) => target.provider.chat({
        model: target.modelId,
        messages: [{ role: 'user', content: input.prompt }],
        systemPrompt: input.systemPrompt,
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
        reasoningEffort: 'low',
        signal: controller.signal,
      })).catch((error) => {
      if (timedOut || controller.signal.aborted) return null;
      throw error;
    });
    const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
      if (timeoutMs <= 0) return;
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(timeoutSentinel);
      }, timeoutMs);
      timer.unref?.();
    });
    const response = await Promise.race([chatPromise, timeoutPromise]);
    if (response === timeoutSentinel) {
      logger.warn('Knowledge semantic LLM request timed out', {
        purpose: input.purpose,
        timeoutMs,
      });
      return { failure: `the request timed out after ${timeoutMs} ms` };
    }
    if (!response) return { text: null };
    const content = response.content?.trim() ?? '';
    return { text: content.length > 0 ? content : null };
  } catch (error) {
    logger.warn('Knowledge semantic LLM request failed', {
      purpose: input.purpose,
      error: summarizeError(error),
    });
    return { failure: summarizeError(error), cause: error };
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener('abort', abortFromParent);
  }
}

class SemanticLlmLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    // The releasing task hands its slot over without freeing it, so a run()
    // started before this continuation resumes cannot slip in as an extra.
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }
}
