import type { FetchSanitizeMode } from './schema.js';

export interface FetchUrlResult {
  url: string;
  status?: number | undefined;
  statusText?: string | undefined;
  contentType?: string | undefined;
  byteSize?: number | undefined;
  content?: string | undefined;
  error?: string | undefined;
  /** The caller cancelled the call before this request finished. */
  cancelled?: boolean | undefined;
  /** No complete response arrived within the request's timeout_ms. */
  timed_out?: boolean | undefined;
  truncated?: boolean | undefined;
  from_cache?: boolean | undefined;
  redirected?: boolean | undefined;
  final_url?: string | undefined;
  duration_ms?: number | undefined;
  tokens_used?: number | undefined;
  /** The sanitizer changed the returned content (it is not the extracted text verbatim). */
  sanitized?: boolean | undefined;
  sanitization_tier?: FetchSanitizeMode | 'skipped' | undefined;
  host_trust_tier?: string | undefined;
  /** `extract: 'json'` and the body is not JSON: why it did not parse (the body is returned as written). */
  json_parse_error?: string | undefined;
  /** `extract: 'pdf'` and no text could be read: why. */
  pdf_error?: string | undefined;
  /**
   * Caller-set request headers not sent on after a redirect to another origin
   * (credentials, or names read as credentials), so the caller knows what to
   * send to the final origin itself.
   */
  redirect_dropped_headers?: string[] | undefined;
  metadata?: {
    headers: Record<string, string>;
    redirected: boolean;
    finalUrl: string;
  };
}

export interface FetchOutput {
  success: boolean;
  error?: string | undefined;
  results?: FetchUrlResult[] | undefined;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    /** Requests that completed with an HTTP status of 400 or above (counted in succeeded). */
    http_errors?: number | undefined;
    total_ms?: number | undefined;
  };
}
