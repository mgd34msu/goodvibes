export type GoodVibesRuntimeSurface =
  | 'client'
  | 'edge'
  | 'mobile'
  | 'node-runtime'
  | 'node-platform';

export type GoodVibesRuntimeRequirement =
  | 'fetch'
  | 'websocket'
  | 'node-like'
  | 'filesystem'
  | 'child-process'
  | 'local-database'
  | 'native-module'
  | 'provider-sdk'
  | 'browser-global'
  | 'secure-mobile-storage';

export interface GoodVibesRuntimeCapability {
  readonly id: string;
  readonly description: string;
  readonly entrypoints: readonly string[];
  readonly surfaces: readonly GoodVibesRuntimeSurface[];
  readonly requirements: readonly GoodVibesRuntimeRequirement[];
  readonly dependencyFamilies: readonly string[];
}

export const GOODVIBES_CLIENT_SAFE_ENTRYPOINTS = [
  '@goodvibes/engine/platform',
  '@goodvibes/engine/platform/auth',
  '@goodvibes/engine/platform/browser',
  '@goodvibes/engine/platform/browser/homeassistant',
  '@goodvibes/engine/platform/browser/knowledge',
  '@goodvibes/engine/platform/client-auth',
  '@goodvibes/engine/platform/contracts',
  '@goodvibes/engine/platform/errors',
  '@goodvibes/engine/platform/events',
  '@goodvibes/engine/platform/expo',
  '@goodvibes/engine/platform/observer',
  '@goodvibes/engine/platform/operator',
  '@goodvibes/engine/platform/peer',
  '@goodvibes/engine/platform/react-native',
  '@goodvibes/engine/platform/transport-core',
  '@goodvibes/engine/platform/transport-direct',
  '@goodvibes/engine/platform/transport-http',
  '@goodvibes/engine/platform/transport-realtime',
  '@goodvibes/engine/platform/web',
  '@goodvibes/engine/platform/workers',
] as const;

export const GOODVIBES_NODE_RUNTIME_ENTRYPOINTS = [
  '@goodvibes/engine/platform/platform/node',
  '@goodvibes/engine/platform/platform/node/runtime-boundary',
  '@goodvibes/engine/platform/platform/config',
  '@goodvibes/engine/platform/platform/core',
  '@goodvibes/engine/platform/platform/daemon',
  '@goodvibes/engine/platform/platform/git',
  '@goodvibes/engine/platform/platform/intelligence',
  '@goodvibes/engine/platform/platform/integrations',
  '@goodvibes/engine/platform/platform/knowledge',
  '@goodvibes/engine/platform/platform/knowledge/extensions',
  '@goodvibes/engine/platform/platform/knowledge/home-graph',
  '@goodvibes/engine/platform/platform/mcp',
  '@goodvibes/engine/platform/platform/mcp/server',
  '@goodvibes/engine/platform/platform/media',
  '@goodvibes/engine/platform/platform/multimodal',
  '@goodvibes/engine/platform/platform/observe',
  '@goodvibes/engine/platform/platform/pairing',
  '@goodvibes/engine/platform/platform/providers',
  '@goodvibes/engine/platform/platform/runtime',
  '@goodvibes/engine/platform/platform/runtime/observability',
  '@goodvibes/engine/platform/platform/runtime/sandbox',
  '@goodvibes/engine/platform/platform/runtime/settings',
  '@goodvibes/engine/platform/platform/runtime/state',
  '@goodvibes/engine/platform/platform/runtime/store',
  '@goodvibes/engine/platform/platform/runtime/ui',
  '@goodvibes/engine/platform/contracts/node',
  '@goodvibes/engine/platform/platform/tools',
  '@goodvibes/engine/platform/platform/utils',
  '@goodvibes/engine/platform/platform/voice',
] as const;

export const GOODVIBES_RUNTIME_CAPABILITIES: readonly GoodVibesRuntimeCapability[] = [
  {
    id: 'remote-client',
    description: 'HTTP, realtime, operator, peer, and auth clients for talking to an existing daemon.',
    entrypoints: GOODVIBES_CLIENT_SAFE_ENTRYPOINTS,
    surfaces: ['client', 'edge', 'mobile'],
    requirements: ['fetch', 'websocket'],
    // Display-only patterns, not glob patterns for resolution; document the npm package family.
    dependencyFamilies: [
      '@goodvibes/engine/transport-*',
      '@goodvibes/engine/operator-client',
      '@goodvibes/engine/peer-client',
    ],
  },
  {
    id: 'worker-proxy',
    description: 'Cloudflare Worker proxy and queue helpers for forwarding daemon batch work.',
    entrypoints: ['@goodvibes/engine/platform/workers'],
    surfaces: ['edge'],
    requirements: ['fetch'],
    dependencyFamilies: [],
  },
  {
    id: 'local-runtime',
    description: 'Runtime stores, diagnostics, transports, bootstrap helpers, and explicit local host service subpaths.',
    entrypoints: [
      '@goodvibes/engine/platform/platform/runtime',
      '@goodvibes/engine/platform/platform/runtime/observability',
      '@goodvibes/engine/platform/platform/runtime/sandbox',
      '@goodvibes/engine/platform/platform/runtime/settings',
      '@goodvibes/engine/platform/platform/runtime/state',
      '@goodvibes/engine/platform/platform/runtime/store',
      '@goodvibes/engine/platform/platform/runtime/ui',
    ],
    surfaces: ['node-runtime', 'node-platform'],
    requirements: ['node-like', 'filesystem', 'local-database'],
    dependencyFamilies: ['sql.js', 'sqlite-vec'],
  },
  {
    id: 'knowledge-system',
    description: 'Knowledge spaces, ingestion, extraction, graph storage, semantic enrichment, generated pages, and extensions.',
    entrypoints: [
      '@goodvibes/engine/platform/platform/knowledge',
      '@goodvibes/engine/platform/platform/knowledge/extensions',
      '@goodvibes/engine/platform/platform/knowledge/home-graph',
    ],
    surfaces: ['node-runtime', 'node-platform'],
    requirements: ['node-like', 'filesystem', 'local-database'],
    dependencyFamilies: [
      'pdfjs-dist',
      'jsdom',
      '@mozilla/readability',
      'jszip',
      'graphql',
      'bplist-parser',
    ],
  },
  {
    id: 'provider-integrations',
    description: 'LLM, voice, multimodal, provider registry, and provider auth integrations.',
    entrypoints: [
      '@goodvibes/engine/platform/platform/providers',
      '@goodvibes/engine/platform/platform/voice',
      '@goodvibes/engine/platform/platform/multimodal',
    ],
    surfaces: ['node-runtime', 'node-platform'],
    requirements: ['node-like', 'provider-sdk'],
    dependencyFamilies: [
      'openai',
      '@anthropic-ai/sdk',
      '@anthropic-ai/bedrock-sdk',
      'google-auth-library',
      'node-edge-tts',
    ],
  },
  {
    id: 'local-tools',
    description: 'Filesystem, shell, git, AST, language-server, and workflow tools used by daemon/TUI runtimes.',
    entrypoints: [
      '@goodvibes/engine/platform/platform/tools',
      '@goodvibes/engine/platform/platform/intelligence',
      '@goodvibes/engine/platform/platform/git',
    ],
    surfaces: ['node-runtime', 'node-platform'],
    requirements: ['node-like', 'filesystem', 'child-process', 'native-module'],
    dependencyFamilies: [
      '@ast-grep/napi',
      'simple-git',
      'web-tree-sitter',
      'tree-sitter-*',
      'bash-language-server',
      'pyright',
      'typescript-language-server',
      'vscode-langservers-extracted',
    ],
  },
] as const;

export function isClientSafeGoodVibesEntrypoint(entrypoint: string): boolean {
  return (GOODVIBES_CLIENT_SAFE_ENTRYPOINTS as readonly string[]).includes(entrypoint);
}

export function isNodeRuntimeGoodVibesEntrypoint(entrypoint: string): boolean {
  return (GOODVIBES_NODE_RUNTIME_ENTRYPOINTS as readonly string[]).includes(entrypoint);
}

export function listGoodVibesRuntimeCapabilities(
  surface?: GoodVibesRuntimeSurface,
): readonly GoodVibesRuntimeCapability[] {
  if (!surface) return GOODVIBES_RUNTIME_CAPABILITIES;
  return GOODVIBES_RUNTIME_CAPABILITIES.filter((capability) => (
    capability.surfaces.includes(surface)
  ));
}
