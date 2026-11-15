import type {
  WebSearchProvider,
  WebSearchProviderDescriptor,
} from './types.js';
import { createBraveSearchProvider } from './providers/brave.js';
import { createDuckDuckGoProvider } from './providers/duckduckgo.js';
import { createExaSearchProvider } from './providers/exa.js';
import { createFirecrawlSearchProvider } from './providers/firecrawl.js';
import { createPerplexitySearchProvider } from './providers/perplexity.js';
import { createSearxngSearchProvider } from './providers/searxng.js';
import { createTavilySearchProvider } from './providers/tavily.js';
import type { SearchProviderContext } from './providers/shared.js';

export class WebSearchProviderRegistry {
  private readonly providers = new Map<string, WebSearchProvider>();

  constructor(context: SearchProviderContext) {
    this.register(createDuckDuckGoProvider(), { replace: true });
    this.register(createSearxngSearchProvider(context), { replace: true });
    this.register(createBraveSearchProvider(context), { replace: true });
    this.register(createExaSearchProvider(context), { replace: true });
    this.register(createFirecrawlSearchProvider(context), { replace: true });
    this.register(createTavilySearchProvider(context), { replace: true });
    this.register(createPerplexitySearchProvider(context), { replace: true });
  }

  register(provider: WebSearchProvider, options: { readonly replace?: boolean } = {}): () => void {
    const id = provider.id.trim();
    if (!id) throw new Error('Web search provider id is required');
    if (this.providers.has(id) && !options.replace) {
      throw new Error(`Web search provider already registered: ${id}`);
    }
    const registered = { ...provider, id };
    this.providers.set(id, registered);
    return () => {
      if (this.providers.get(id) === registered) this.unregister(id);
    };
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  get(id: string): WebSearchProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): WebSearchProviderDescriptor[] {
    return [...this.providers.values()]
      .map((provider) => provider.descriptor?.() ?? {
        id: provider.id,
        label: provider.label,
        capabilities: [...provider.capabilities],
        requiresAuth: false,
        configured: true,
      })
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  /**
   * The provider a search without an id uses: the first one the owner has
   * configured (a key, a service entry or a base url), otherwise the built-in
   * keyless default, which is registered first.
   */
  find(providerId?: string): WebSearchProvider | null {
    if (providerId) return this.get(providerId);
    const all = [...this.providers.values()];
    const configured = all.slice(1).find((provider) => provider.descriptor?.().configured === true);
    return configured ?? all[0] ?? null;
  }
}
