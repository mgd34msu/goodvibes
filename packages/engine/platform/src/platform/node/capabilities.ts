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
  '@goodvibes-jev/engine/platform',
  '@goodvibes-jev/engine/platform/auth',
  '@goodvibes-jev/engine/platform/browser',
  '@goodvibes-jev/engine/platform/browser/homeassistant',
  '@goodvibes-jev/engine/platform/browser/knowledge',
  '@goodvibes-jev/engine/platform/client-auth',
  '@goodvibes-jev/engine/platform/contracts',
  '@goodvibes-jev/engine/platform/errors',
  '@goodvibes-jev/engine/platform/events',
  '@goodvibes-jev/engine/platform/expo',
  '@goodvibes-jev/engine/platform/observer',
  '@goodvibes-jev/engine/platform/operator',
  '@goodvibes-jev/engine/platform/peer',
  '@goodvibes-jev/engine/platform/react-native',
  '@goodvibes-jev/engine/platform/transport-core',
  '@goodvibes-jev/engine/platform/transport-direct',
  '@goodvibes-jev/engine/platform/transport-http',
  '@goodvibes-jev/engine/platform/transport-realtime',
  '@goodvibes-jev/engine/platform/web',
  '@goodvibes-jev/engine/platform/workers',
] as const;

export const GOODVIBES_NODE_RUNTIME_ENTRYPOINTS = [
  '@goodvibes-jev/engine/platform/platform/node',
  '@goodvibes-jev/engine/platform/platform/node/runtime-boundary',
  '@goodvibes-jev/engine/platform/platform/config',
  '@goodvibes-jev/engine/platform/platform/core',
  '@goodvibes-jev/engine/platform/platform/daemon',
  '@goodvibes-jev/engine/platform/platform/git',
  '@goodvibes-jev/engine/platform/platform/intelligence',
  '@goodvibes-jev/engine/platform/platform/integrations',
  '@goodvibes-jev/engine/platform/platform/knowledge',
  '@goodvibes-jev/engine/platform/platform/knowledge/extensions',
  '@goodvibes-jev/engine/platform/platform/knowledge/home-graph',
  '@goodvibes-jev/engine/platform/platform/multimodal',
  '@goodvibes-jev/engine/platform/platform/pairing',
  '@goodvibes-jev/engine/platform/platform/providers',
  '@goodvibes-jev/engine/platform/platform/runtime',
  '@goodvibes-jev/engine/platform/platform/runtime/observability',
  '@goodvibes-jev/engine/platform/platform/runtime/sandbox',
  '@goodvibes-jev/engine/platform/platform/runtime/settings',
  '@goodvibes-jev/engine/platform/platform/runtime/state',
  '@goodvibes-jev/engine/platform/platform/runtime/store',
  '@goodvibes-jev/engine/platform/platform/runtime/ui',
  '@goodvibes-jev/engine/platform/contracts/node',
  '@goodvibes-jev/engine/platform/platform/tools',
  '@goodvibes-jev/engine/platform/platform/utils',
  '@goodvibes-jev/engine/platform/platform/voice',
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
      '@goodvibes-jev/engine/transport-*',
      '@goodvibes-jev/engine/operator-client',
      '@goodvibes-jev/engine/peer-client',
    ],
  },
  {
    id: 'worker-proxy',
    description: 'Cloudflare Worker proxy and queue helpers for forwarding daemon batch work.',
    entrypoints: ['@goodvibes-jev/engine/platform/workers'],
    surfaces: ['edge'],
    requirements: ['fetch'],
    dependencyFamilies: [],
  },
  {
    id: 'local-runtime',
    description: 'Runtime stores, diagnostics, transports, bootstrap helpers, and explicit local host service subpaths.',
    entrypoints: [
      '@goodvibes-jev/engine/platform/platform/runtime',
      '@goodvibes-jev/engine/platform/platform/runtime/observability',
      '@goodvibes-jev/engine/platform/platform/runtime/sandbox',
      '@goodvibes-jev/engine/platform/platform/runtime/settings',
      '@goodvibes-jev/engine/platform/platform/runtime/state',
      '@goodvibes-jev/engine/platform/platform/runtime/store',
      '@goodvibes-jev/engine/platform/platform/runtime/ui',
    ],
    surfaces: ['node-runtime', 'node-platform'],
    requirements: ['node-like', 'filesystem', 'local-database'],
    dependencyFamilies: ['sql.js', 'sqlite-vec'],
  },
  {
    id: 'knowledge-system',
    description: 'Knowledge spaces, ingestion, extraction, graph storage, semantic enrichment, generated pages, and extensions.',
    entrypoints: [
      '@goodvibes-jev/engine/platform/platform/knowledge',
      '@goodvibes-jev/engine/platform/platform/knowledge/extensions',
      '@goodvibes-jev/engine/platform/platform/knowledge/home-graph',
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
      '@goodvibes-jev/engine/platform/platform/providers',
      '@goodvibes-jev/engine/platform/platform/voice',
      '@goodvibes-jev/engine/platform/platform/multimodal',
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
      '@goodvibes-jev/engine/platform/platform/tools',
      '@goodvibes-jev/engine/platform/platform/intelligence',
      '@goodvibes-jev/engine/platform/platform/git',
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
