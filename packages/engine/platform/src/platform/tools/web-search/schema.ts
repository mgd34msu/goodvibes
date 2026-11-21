export const WEB_SEARCH_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Web search query to execute.',
    },
    providerId: {
      type: 'string',
      description: 'Optional provider id: duckduckgo, searxng, brave, exa, firecrawl, tavily, perplexity, or one a plugin registered. Left out, the search uses the provider set in webSearch.defaultProvider, else the first configured of searxng, brave, exa, firecrawl, tavily and perplexity, else duckduckgo. The result names the provider that answered (providerId).',
    },
    maxResults: {
      type: 'integer',
      minimum: 1,
      maximum: 25,
      description: 'Maximum number of ranked results to ask for. Default 10. A provider returns at most its own limit: Brave, Firecrawl and Tavily 20, Perplexity 10, the others 25.',
    },
    verbosity: {
      type: 'string',
      enum: ['urls_only', 'titles', 'snippets', 'evidence', 'full'],
      description:
        'urls_only returns ranked URLs, titles adds titles, snippets adds descriptions,'
        + ' evidence fetches bounded excerpts from the top results, and full fetches fuller readable excerpts.',
    },
    region: {
      type: 'string',
      description: 'Region: a country code such as us, or DuckDuckGo\'s country-language form such as us-en. A provider that cannot filter by region names it in metadata.ignoredFilters.',
    },
    safeSearch: {
      type: 'string',
      enum: ['strict', 'moderate', 'off'],
      description: 'Safe-search posture. Default provider behavior is moderate. A provider without the filter names it in metadata.ignoredFilters.',
    },
    timeRange: {
      type: 'string',
      enum: ['any', 'day', 'week', 'month', 'year'],
      description: 'Optional recency filter. A provider that cannot apply it (or this range) names it in metadata.ignoredFilters, so the results are not date-filtered.',
    },
    includeInstantAnswer: {
      type: 'boolean',
      description: 'When supported, include provider instant-answer enrichment.',
    },
    includeEvidence: {
      type: 'boolean',
      description: 'Attach fetched evidence from the top ranked pages.',
    },
    evidenceTopN: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'How many top results to fetch for evidence when evidence is enabled.',
    },
    evidenceExtract: {
      type: 'string',
      enum: ['raw', 'text', 'json', 'markdown', 'readable', 'code_blocks', 'links', 'metadata', 'structured', 'tables', 'pdf', 'summary'],
      description: 'Fetch extraction mode to use for evidence fetches.',
    },
  },
  required: ['query'],
} as const;
