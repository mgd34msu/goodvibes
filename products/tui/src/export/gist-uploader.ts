import type { CallOptions } from '@goodvibes-jev/judgment';
// ---------------------------------------------------------------------------
// gist-uploader, upload export content to a GitHub Gist
// ---------------------------------------------------------------------------
//
// Architecture: UploadTarget interface with a single GistUploadTarget
// implementation. Future targets (HTTP PUT, Pastebin, etc.) implement
// UploadTarget without changing the caller in share-runtime.
//
// Token resolution:
//   1. serviceRegistry.resolveAuth('github'): its `Authorization` header, in
//      the `Bearer <token>` or GitHub's `token <token>` form
//   2. process.env.GITHUB_TOKEN fallback
//   3. No token → honest guidance; no upload.
//
// Privacy: Gist is created as secret=true (unlisted, not private, anyone with
// the URL can view it).
// ---------------------------------------------------------------------------

import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

export type UploadResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * UploadTarget, interface for pluggable export upload backends.
 * Future HTTP PUT / other targets implement this.
 */
export interface UploadTarget {
  upload(content: string, filename: string): Promise<UploadResult>;
}

export interface GistUploaderOptions {
  /**
   * GitHub PAT with `gist` scope. If not provided the uploader will try
   * process.env.GITHUB_TOKEN then return an error with guidance.
   */
  token?: string;
  /** Description shown on the Gist page. Defaults to filename. */
  description?: string;
}

/** Copy the service registry's header map so a later comparison sees what was used. */
export function captureGithubAuthHeaders(headers: Record<string, string> | null | undefined): Record<string, string> {
  return { ...(headers ?? {}) };
}

const GITHUB_AUTHORIZATION = /^(?:bearer|token)\s+(\S+)\s*$/i;

/** The token in a header map's `Authorization: Bearer <token>` or `Authorization: token <token>`. */
export function githubTokenFromHeaders(headers: Record<string, string> | null | undefined): string | undefined {
  if (!headers) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'authorization' || typeof value !== 'string') continue;
    const token = GITHUB_AUTHORIZATION.exec(value)?.[1];
    if (token) return token;
  }
  return undefined;
}

/**
 * resolveGithubToken, the github service entry's bearer token, else GITHUB_TOKEN.
 * Returns undefined when neither is available; no other header is used as a token.
 */
export async function resolveGithubToken(
  authHeaders: Record<string, string> | null | undefined,
  options: CallOptions = {},
): Promise<string | undefined> {
  options.signal?.throwIfAborted();
  return githubTokenFromHeaders(authHeaders) ?? (process.env['GITHUB_TOKEN'] || undefined);
}

/**
 * GistUploadTarget, uploads content to a secret (unlisted) GitHub Gist.
 */
export class GistUploadTarget implements UploadTarget {
  private readonly token: string;
  private readonly description: string;

  constructor(token: string, description?: string) {
    this.token = token;
    this.description = description ?? 'GoodVibes session export';
  }

  async upload(content: string, filename: string, signal?: AbortSignal): Promise<UploadResult> {
    signal?.throwIfAborted();
    const body = JSON.stringify({
      description: this.description,
      public: false, // secret gist: unlisted, not private
      files: {
        [filename]: { content },
      },
    });

    let response: Response;
    try {
      response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        signal,
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body,
      });
    } catch (fetchErr: unknown) {
      const msg = summarizeError(fetchErr);
      return { ok: false, error: `Network error: ${msg}` };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        error: `GitHub API error ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, error: 'GitHub API returned non-JSON response' };
    }

    const gistUrl = (json as Record<string, unknown>)['html_url'];
    if (typeof gistUrl !== 'string') {
      return { ok: false, error: 'GitHub API response missing html_url field' };
    }

    return { ok: true, url: gistUrl };
  }
}

/**
 * noTokenGuidance, message printed when no GitHub PAT is found.
 */
export const NO_TOKEN_GUIDANCE = [
  'No GitHub token found for --upload.',
  'To enable Gist upload, configure a GitHub service entry with bearer auth:',
  '  add it to ~/.goodvibes/tui/services.json, or /services import <path>',
  'A github entry is used only when it sends `Authorization: Bearer <token>` (or `token <token>`);',
  'any other header is not taken as the token. Change the entry or',
  'set the GITHUB_TOKEN environment variable to a PAT with the `gist` scope.',
  'Token is sent to api.github.com only. Gists are secret (unlisted, not private).',
].join('\n');
