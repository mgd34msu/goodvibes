/**
 * A tool server's kept trust level and limits in words, as the runtime decides a call (runtime/mcp/permissions.ts
 * `evaluateToolCall`, then mcp/registry.ts). A server's limits are the folders and sites set for it, and only the ones
 * set are checked. A call the level lets through still goes through the person's permission mode like any tool call.
 * No imports: the screens of every program and the web view read these words.
 */

/** The level a server runs at when none is kept for it (mcp/config.ts `MCP_DEFAULT_TRUST_MODE`). */
export const MCP_TRUST_WORDS_DEFAULT_MODE = 'ask-on-risk';

/** What each level does with a call, one choice each: the label, and the sentence under it. */
export const MCP_TRUST_LEVEL_WORDS: readonly { readonly value: string; readonly label: string; readonly help: string; readonly loosens: boolean }[] = [
  { value: 'ask-on-risk', label: 'Ask me about calls outside its limits', loosens: true,
    help: 'Calls inside its folders and sites go on as your permission mode allows; a call outside them is put to you, in every mode. A server kept with no level set has this one.' },
  { value: 'constrained', label: 'Refuse calls outside its limits', loosens: false,
    help: 'Calls inside its folders and sites go on as your permission mode allows; a call outside them is refused without asking you.' },
  { value: 'blocked', label: 'Refuse every call', loosens: false, help: 'No tool of the server runs.' },
  { value: 'allow-all', label: 'Do not hold it to its limits', loosens: true,
    help: 'Every call goes on as your permission mode allows, inside its folders and sites or not. A project\'s own MCP file cannot set this.' },
];

/** A kept level in words, as a row or a line says it ("<server> asks you about calls outside its limits"). */
export function mcpTrustWords(mode: string | undefined | null): string {
  const level = mode || MCP_TRUST_WORDS_DEFAULT_MODE;
  if (level === 'ask-on-risk') return 'asks you about calls outside its limits';
  if (level === 'allow-all') return 'is not held to its limits';
  if (level === 'constrained') return 'refuses calls outside its limits';
  if (level === 'blocked') return 'refuses every call';
  return String(level).replace(/[_-]+/g, ' ');
}

/** The limits a level is held to, in words: only the folders and sites set are checked. */
export function mcpLimitWords(server: { readonly allowedPaths?: readonly string[] | undefined; readonly allowedHosts?: readonly string[] | undefined }): string {
  const folders = server.allowedPaths?.length ?? 0, sites = server.allowedHosts?.length ?? 0;
  if (folders === 0 && sites === 0) return 'no folders or sites set, so no call is outside its limits';
  return [folders > 0 ? `${folders} folder${folders === 1 ? '' : 's'}` : 'any folder', sites > 0 ? `${sites} site${sites === 1 ? '' : 's'}` : 'any site'].join(', ');
}
