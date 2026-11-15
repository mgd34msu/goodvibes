import { WEBUI_CODE_LANGUAGES, type WebuiCodeLanguage } from '@goodvibes-jev/engine/contracts';

// The aliases the web UI's highlighter (highlight.js 11) registers for each supported grammar,
// so a tag the renderer resolves is never sent for a reading.
const ALIASES: Readonly<Record<string, WebuiCodeLanguage>> = {
  sh: 'bash', zsh: 'bash',
  h: 'c',
  cc: 'cpp', 'c++': 'cpp', 'h++': 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cxx: 'cpp',
  cs: 'csharp', 'c#': 'csharp',
  patch: 'diff',
  docker: 'dockerfile',
  golang: 'go',
  toml: 'ini',
  jsp: 'java',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsonc: 'json', json5: 'json',
  md: 'markdown', mkdown: 'markdown', mkd: 'markdown',
  text: 'plaintext', txt: 'plaintext',
  py: 'python', gyp: 'python', ipython: 'python',
  rb: 'ruby', gemspec: 'ruby', podspec: 'ruby', thor: 'ruby', irb: 'ruby',
  rs: 'rust',
  console: 'shell', shellsession: 'shell',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  html: 'xml', xhtml: 'xml', rss: 'xml', atom: 'xml', xjb: 'xml', xsd: 'xml', xsl: 'xml', plist: 'xml', wsf: 'xml', svg: 'xml',
  yml: 'yaml',
};
const NAMES: ReadonlySet<string> = new Set(WEBUI_CODE_LANGUAGES);

/** The grammar a fence tag names (name or alias, any case), or undefined when the tag is absent or unknown. */
export function readFenceTagLanguage(tag: string): WebuiCodeLanguage | undefined {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) return undefined;
  if (NAMES.has(normalized)) return normalized as WebuiCodeLanguage;
  return Object.hasOwn(ALIASES, normalized) ? ALIASES[normalized] : undefined;
}
