import type { ClassicModelStack as LocalModelStack } from '@goodvibes/engine/platform/platform/routing';
export type { ClassicModelStack as LocalModelStack } from '@goodvibes/engine/platform/platform/routing';

/** Serving stacks by provider id: the built-in local adapters and the usual names of local servers. */
const PROVIDER_STACKS: Readonly<Record<string, LocalModelStack>> = {
  ollama: 'ollama', 'llama.cpp': 'llama.cpp', llamacpp: 'llama.cpp', 'llama-cpp': 'llama.cpp', 'llama-server': 'llama.cpp',
  vllm: 'vllm', 'lm-studio': 'openai-compatible', lmstudio: 'openai-compatible', localai: 'openai-compatible', 'openai-compatible': 'openai-compatible',
};
/** The default ports of the local servers in the cookbook's suggested defaults. */
const PORT_STACKS: Readonly<Record<string, LocalModelStack>> = { '11434': 'ollama', '1234': 'openai-compatible', '8080': 'llama.cpp', '8000': 'vllm' };

/** The serving stack a provider id (or a `provider:model` route) names, or null when its name says none. */
export function localStackForProvider(providerOrRoute: string): LocalModelStack | null {
  const id = (providerOrRoute.split(':')[0] ?? '').trim().toLowerCase();
  return PROVIDER_STACKS[id] ?? null;
}

/**
 * The serving stack of an endpoint, decided in code: null when the URL is not
 * loopback or private (not a local server at all), else the stack the
 * provider's id names, else the default-port table, else OpenAI-compatible.
 */
export function localStackFor(baseUrl: string, providerId?: string | null): LocalModelStack | null {
  if (!isPrivateOrLocalUrl(baseUrl)) return null;
  const named = providerId ? localStackForProvider(providerId) : null;
  if (named) return named;
  return PORT_STACKS[parseUrlCandidate(baseUrl)?.port ?? ''] ?? 'openai-compatible';
}

export function cleanUrlCandidate(value: string): string {
  return value.trim().replace(/[),.;]+$/g, '');
}

export function extractUrls(value: string): readonly string[] {
  const matches = value.match(/https?:\/\/[^\s"'`<>]+/gi) ?? [];
  return [...new Set(matches.map(cleanUrlCandidate).filter(Boolean))];
}

export function parseUrlCandidate(raw: string): URL | null {
  const trimmed = cleanUrlCandidate(raw);
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return true;
  if (host.endsWith('.local')) return true;
  if (host.includes(':')) return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  const octets = host.split('.').map((entry) => Number(entry));
  if (octets.length === 4 && octets.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
    const [first, second] = octets as [number, number, number, number];
    return first === 10
      || first === 127
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 169 && second === 254)
      || first === 0;
  }
  return !host.includes('.');
}

export function isPrivateOrLocalUrl(raw: string): boolean {
  const url = parseUrlCandidate(raw);
  if (!url || !/^https?:$/.test(url.protocol)) return false;
  return isPrivateOrLocalHost(url.hostname);
}

export function normalizeLocalBaseUrl(raw: string, stackHint?: string | null): string | null {
  const url = parseUrlCandidate(raw);
  if (!url || !/^https?:$/.test(url.protocol)) return null;
  const stack = stackHint ?? (isPrivateOrLocalHost(url.hostname) ? 'openai-compatible' : null);
  if (!isPrivateOrLocalUrl(url.href)) return null;

  let pathname = url.pathname.replace(/\/+$/g, '');
  if (pathname.endsWith('/models')) pathname = pathname.slice(0, -'/models'.length);
  if (pathname.endsWith('/api/tags')) pathname = pathname.slice(0, -'/api/tags'.length);
  const needsOpenAiPath = stack === 'ollama' || stack === 'llama.cpp' || stack === 'vllm' || stack === 'openai-compatible';
  if (needsOpenAiPath && (!pathname || pathname === '/')) pathname = '/v1';
  url.pathname = pathname || '';
  url.search = '';
  url.hash = '';
  // A gateway credential in the URL must never reach model-visible endpoints, ids or suggested commands.
  url.username = '';
  url.password = '';
  return url.toString().replace(/\/+$/g, '');
}

export function modelsUrlFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/g, '')}/models`;
}

/** Removes userinfo, query and fragment from a URL-looking string for display; text that is not a URL is returned unchanged. */
export function stripUrlCredentials(raw: string): string {
  const url = parseUrlCandidate(raw);
  if (!url || !/^https?:$/.test(url.protocol) || (!url.username && !url.password)) return raw;
  url.username = '';
  url.password = '';
  return url.toString();
}
