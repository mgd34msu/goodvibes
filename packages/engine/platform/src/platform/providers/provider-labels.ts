/**
 * The display name of every built-in provider, in one place: the daemon's
 * provider listing shows it, and the generated reference reads it from here.
 * A compatible provider's name comes from its catalog entry; the native ones,
 * which have no catalog entry, are named below.
 */
import { BUILTIN_COMPAT_PROVIDERS } from './builtin-catalog.js';
import { BEDROCK_PROVIDER_LABELS } from './amazon-bedrock.js';

/** Brand-accurate names of the providers that are not in BUILTIN_COMPAT_PROVIDERS, or whose catalog label is overridden. */
export const NATIVE_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  inceptionlabs: 'Inception Labs',
  ...BEDROCK_PROVIDER_LABELS,
  'anthropic-vertex': 'Anthropic (Vertex)',
  'github-copilot': 'GitHub Copilot',
  groq: 'Groq',
  cerebras: 'Cerebras',
  mistral: 'Mistral',
  'ollama-cloud': 'Ollama Cloud',
  huggingface: 'Hugging Face',
  nvidia: 'NVIDIA',
  llm7: 'LLM7',
  perplexity: 'Perplexity',
  deepgram: 'Deepgram',
  elevenlabs: 'ElevenLabs',
  microsoft: 'Microsoft',
  vydra: 'Vydra',
  byteplus: 'BytePlus',
  fal: 'fal.ai',
  comfy: 'ComfyUI',
  runway: 'Runway',
  alibaba: 'Alibaba Cloud',
  synthetic: 'Synthetic (Local)',
};

const CATALOG_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  BUILTIN_COMPAT_PROVIDERS.filter((definition) => definition.label).map((definition) => [definition.id, definition.label]),
);

/** The name a provider is shown by: the native name, else its catalog label, else its id with a capital first letter. */
export function providerDisplayLabel(providerId: string): string {
  return NATIVE_PROVIDER_LABELS[providerId] ?? CATALOG_LABELS[providerId] ?? providerId.charAt(0).toUpperCase() + providerId.slice(1);
}
