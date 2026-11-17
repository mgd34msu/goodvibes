/** Exact publisher/configuration literals only; no model identity or readiness inference. */
export type ClassicModelStack = 'ollama' | 'llama.cpp' | 'vllm' | 'openai-compatible';

export function declaredClassicModelStack(value: string): ClassicModelStack | null {
  const literal = value.trim().toLowerCase();
  return literal === 'ollama' || literal === 'llama.cpp' || literal === 'vllm' || literal === 'openai-compatible' ? literal : null;
}

