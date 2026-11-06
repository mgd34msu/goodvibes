/** Exact publisher/configuration literals only; no model identity or readiness inference. */
export type ClassicModelStack = 'ollama' | 'llama.cpp' | 'vllm' | 'openai-compatible';
export type ClassicServingStatus = 'ready' | 'attention' | 'blocked' | 'unknown';
export type ClassicResourcePressure = 'low' | 'moderate' | 'high' | 'unknown';

export function declaredClassicModelStack(value: string): ClassicModelStack | null {
  const literal = value.trim().toLowerCase();
  return literal === 'ollama' || literal === 'llama.cpp' || literal === 'vllm' || literal === 'openai-compatible' ? literal : null;
}
export function declaredClassicBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : null;
}
export function declaredClassicServingStatus(value: string): ClassicServingStatus {
  const literal = value.trim().toLowerCase();
  return literal === 'ready' || literal === 'attention' || literal === 'blocked' ? literal : 'unknown';
}
export function declaredClassicResourcePressure(value: string): ClassicResourcePressure {
  const literal = value.trim().toLowerCase();
  return literal === 'low' || literal === 'moderate' || literal === 'high' ? literal : 'unknown';
}
