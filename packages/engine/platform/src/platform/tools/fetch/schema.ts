/**
 * JSON Schema definition for the `fetch` tool.
 *
 * The fetch tool performs HTTP requests in batch, with per-URL extract modes,
 * timeout support, and token-efficient verbosity output.
 */
export const FETCH_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    urls: {
      type: 'array',
      description: 'URLs to fetch. Processed as a batch in one call.',
      items: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch.',
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
            description: 'HTTP method. Defaults to GET.',
          },
          params: {
            type: 'object',
            description: 'Query parameters to append to the URL as a query string.',
            additionalProperties: { type: 'string' },
          },
          headers: {
            type: 'object',
            description: 'HTTP headers to include in the request.',
            additionalProperties: { type: 'string' },
          },
          body: {
            type: 'string',
            description: 'Request body string.',
          },
          body_base64: {
            type: 'string',
            description: 'Base64-encoded request body, decoded to bytes and sent as binary. Content-Type defaults to application/octet-stream unless body_type is json or form. Precedence: body_data (with form or multipart) wins over body_base64, which wins over body.',
          },
          body_type: {
            type: 'string',
            enum: ['json', 'form', 'raw', 'multipart'],
            description:
              'How to encode the body. json: sets Content-Type application/json;'
              + ' form: URL-encodes body_data or sends body as application/x-www-form-urlencoded;'
              + ' multipart: builds a FormData body from body_data (object of key-value pairs);'
              + ' raw: sends body as-is with no default Content-Type (set one in headers).',
          },
          body_data: {
            type: 'object',
            description:
              'Key-value pairs for structured request bodies.'
              + ' For form, entries are URL-encoded into the request body.'
              + ' For multipart, each entry becomes a FormData field.',
            additionalProperties: { type: 'string' },
          },
          extract: {
            type: 'string',
            enum: ['raw', 'text', 'json', 'markdown', 'readable', 'code_blocks', 'links', 'metadata', 'structured', 'tables', 'pdf', 'summary'],
            description:
              'Extraction mode for this URL. Overrides the global extract.'
              + ' raw: raw response body; text: plain text, strips HTML tags;'
              + ' json: ask for JSON (Accept: application/json unless headers set Accept), parse and format it (a body that is not JSON comes back as written, with json_parse_error); markdown: convert HTML to markdown;'
              + ' readable: extract main content, strip nav/sidebar/footer;'
              + ' code_blocks: extract <pre>/<code> blocks;'
              + ' links: extract all URLs; metadata: extract title/og-tags;'
              + ' structured: extract text of elements matching simple selectors: tag, #id, .class, tag.class (requires selectors field);'
              + ' tables: parse <table> elements into JSON arrays;'
              + ' pdf: extract the text of a PDF response, page by page (no OCR; pdf_error says why when nothing could be read);'
              + ' summary: extractive summary (the paragraph that says what the page is about + headings).',
          },
          selectors: {
            type: 'array',
            items: { type: 'string' },
            description: 'Selectors for structured extraction mode: tag, #id, .class, or tag.class with any number of classes (for example "h2", "#main", ".note", "div.card.big"). Combinators, attribute selectors and comma lists are not supported and are reported as an error. Each matched element text is returned as an array item.',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 1,
            description: 'Per-URL timeout in milliseconds. Default 30000.',
          },
          max_content_length: {
            type: 'integer',
            minimum: 1,
            description: 'Maximum response body size in bytes. Responses exceeding this are truncated (truncated: true). Overrides global max_content_length. Default 5000000.',
          },
          retry_on_auth: {
            type: 'boolean',
            description: 'When a service is specified and a 401 is returned, attempt to refresh auth and retry once. Defaults to true when service is specified.',
          },
          service: {
            type: 'string',
            description: 'Named service for automatic credential lookup from the service registry. The credential is sent only to the service\'s own origin (its baseUrl); a URL on another origin is refused with nothing sent. Services are configured in the host services.json file. Use the registry tool or inspect that registry to discover available service names.',
          },
          auth: {
            type: 'object',
            description: 'Inline auth configuration. Applied directly without registry lookup.',
            properties: {
              type: {
                type: 'string',
                enum: ['bearer', 'basic', 'api-key'],
                description: 'Auth type.',
              },
              token: { type: 'string', description: 'Bearer token (for type bearer).' },
              username: { type: 'string', description: 'Username (for type basic).' },
              password: { type: 'string', description: 'Password (for type basic).' },
              header: { type: 'string', description: 'Header name (for type api-key). Defaults to X-API-Key.' },
              key: { type: 'string', description: 'API key value (for type api-key).' },
            },
            required: ['type'],
          },
        },
        required: ['url'],
      },
      minItems: 1,
    },
    extract: {
      type: 'string',
      enum: ['raw', 'text', 'json', 'markdown', 'readable', 'code_blocks', 'links', 'metadata', 'structured', 'tables', 'pdf', 'summary'],
      description: 'Global extraction mode applied to all URLs unless overridden per-URL. Defaults to raw.',
    },
    parallel: {
      type: 'boolean',
      description: 'Fetch URLs in parallel. Default true. Setting rate_limit_ms runs them one after another instead.',
    },
    verbosity: {
      type: 'string',
      enum: ['count_only', 'minimal', 'standard', 'verbose'],
      description:
        'count_only: totals only; minimal: URL + status + byte size;'
        + ' standard: URL + status + content (default); verbose: all metadata, with the value of credential headers (set-cookie, authorization and the like) withheld.',
    },
    cache_ttl_seconds: {
      type: 'integer',
      minimum: 0,
      description: 'Cache successful GET responses (status below 400) by URL+params for this many seconds. Error statuses are never cached. 0 disables caching (default).',
    },
    rate_limit_ms: {
      type: 'integer',
      minimum: 0,
      description: 'Minimum delay in milliseconds between requests. Any value above 0 runs the URLs one after another with this pacing, whatever parallel says. 0 disables rate limiting (default).',
    },
    max_content_length: {
      type: 'integer',
      minimum: 1,
      description: 'Global maximum response body size in bytes. Responses exceeding this are truncated (truncated: true). Default 5000000. Can be overridden per-URL.',
    },
    sanitize_mode: {
      type: 'string',
      enum: ['none', 'safe-text', 'strict'],
      description:
        'Response sanitization mode applied to all URL responses.'
        + ' none: content returned verbatim (trusted hosts only);'
        + ' safe-text: strips script/style blocks, control characters and invisible Unicode (default);'
        + ' strict: strips all HTML and every non-ASCII character (untrusted hosts).'
        + ' Both modes alter the content, so structured data can change; a result whose content was altered carries sanitized: true'
        + ' and sanitized_removed (characters removed by kind), and sanitize_note when more than a tenth of the text went.'
        + ' Tags are stripped only from content that is still HTML or XML (extract raw); extracted text keeps a literal < or >.',
    },
    blocked_hosts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Hostnames or glob patterns explicitly blocked. Denied pre-request regardless of other config.',
    },
  },
  required: ['urls'],
} as const;

/** Extraction mode for a single URL or globally. */
export type FetchExtractMode =
  | 'raw'
  | 'text'
  | 'json'
  | 'markdown'
  | 'readable'
  | 'code_blocks'
  | 'links'
  | 'metadata'
  | 'structured'
  | 'tables'
  | 'pdf'
  | 'summary';

/** Output verbosity format. */
export type FetchVerbosity = 'count_only' | 'minimal' | 'standard' | 'verbose';

/** Auth config for a single URL. */
export interface FetchAuthInput {
  type: 'bearer' | 'basic' | 'api-key';
  /** Bearer token (used with type 'bearer'). */
  token?: string | undefined;
  /** Username for basic auth (used with type 'basic'). */
  username?: string | undefined;
  /** Password for basic auth (used with type 'basic'). */
  password?: string | undefined;
  /** Header name for API key auth (used with type 'api-key'). Defaults to X-API-Key. */
  header?: string | undefined;
  /** API key value (used with type 'api-key'). */
  key?: string | undefined;
}

/** Input shape for a single URL entry. */
export interface FetchUrlInput {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | undefined;
  /** Query parameters appended as a query string to the URL. */
  params?: Record<string, string> | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  /** Base64-encoded request body, sent as bytes. Wins over body; body_data with form or multipart wins over both. */
  body_base64?: string | undefined;
  body_type?: 'json' | 'form' | 'raw' | 'multipart' | undefined;
  /** Key-value pairs used when body_type is 'form' or 'multipart'. */
  body_data?: Record<string, string> | undefined;
  extract?: FetchExtractMode | undefined;
  /** CSS selectors for structured extraction mode. */
  selectors?: string[] | undefined;
  timeout_ms?: number | undefined;
  /** Maximum response body size in bytes. Overrides global max_content_length. */
  max_content_length?: number | undefined;
  /** When a service is specified and a 401 is returned, refresh auth and retry once. */
  retry_on_auth?: boolean | undefined;
  /** Named service for automatic credential lookup from the service registry. */
  service?: string | undefined;
  /** Inline auth configuration. Applied directly without registry lookup. */
  auth?: FetchAuthInput | undefined;
}

/**
 * Sanitization mode for response content.
 *
 * Re-exported from sanitizer.ts to avoid duplication.
 */
import type { SanitizeMode } from './sanitizer.js';
/** Sanitization mode re-exported from sanitizer.ts. */
export type FetchSanitizeMode = SanitizeMode;

/** Full input shape for the fetch tool. */
export interface FetchInput {
  urls: FetchUrlInput[];
  extract?: FetchExtractMode | undefined;
  parallel?: boolean | undefined;
  verbosity?: FetchVerbosity | undefined;
  /** Cache GET responses by URL+params for this many seconds. 0 = disabled (default). */
  cache_ttl_seconds?: number | undefined;
  /** Minimum delay in ms between sequential requests. 0 = disabled (default). */
  rate_limit_ms?: number | undefined;
  /** Global maximum response body size in bytes. */
  max_content_length?: number | undefined;
  /**
   * Response sanitization mode applied to all URL responses.
   * Defaults to `'safe-text'` when omitted (rollback-safe default for fetch sanitization).
   */
  sanitize_mode?: FetchSanitizeMode | undefined;
  /** Hostnames or glob patterns explicitly blocked. Denied pre-request regardless of other config. */
  blocked_hosts?: string[] | undefined;
}
