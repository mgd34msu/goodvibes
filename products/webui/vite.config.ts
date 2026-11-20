import { defineConfig, type Plugin } from 'vite';
import { builtinModules, createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWebBindingFromDaemon } from './scripts/daemon-binding.ts';

// Directory this config file lives in (products/webui), resolved independent
// of process.cwd(), this config is the seam every `vite build` invocation
// loads (bun run build, a wrapper script, CI, or a bare `vite build` in this
// directory), so a guard planted here cannot be routed around the way a
// guard in a wrapper script could be by calling vite directly.
const CONFIG_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Build only against this checkout's declared engine, and reject Node-only browser imports. */
function workspaceEnginePlugin(): Plugin {
  const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  return {
    name: 'goodvibes-workspace-engine',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      const require = createRequire(import.meta.url);
      const manifest = JSON.parse(readFileSync(join(CONFIG_DIR, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      if (manifest.dependencies?.['@goodvibes/engine'] !== 'workspace:*') {
        this.error('WebUI must consume @goodvibes/engine from this workspace');
      }
      const installed = realpathSync(require.resolve('@goodvibes/engine/package.json'));
      const expected = realpathSync(join(CONFIG_DIR, '../../packages/engine/package.json'));
      if (installed !== expected) this.error('WebUI resolved an engine outside this checkout');
    },
    resolveId(source, importer) {
      if (importer && nodeBuiltins.has(source)) {
        this.error(`Node-only module ${source} reached the browser through ${importer}`);
      }
      return null;
    },
  };
}

interface GoodVibesListenerSettings {
  hostMode?: string;
  host?: string;
  port?: number;
}

interface GoodVibesDaemonSettings {
  controlPlane?: GoodVibesListenerSettings;
}

/**
 * The same tree rules the runtime uses (platform/config/goodvibes-home.ts),
 * restated here because this file runs under Node before the engine is built:
 * `GOODVIBES_HOME` is the tree root (`<root>/.goodvibes`), `GOODVIBES_DAEMON_HOME`
 * is the daemon's own directory, default `<tree>/daemon`.
 */
function goodVibesTreeDirectory(): string {
  const override = process.env.GOODVIBES_HOME?.trim();
  const root = override ? (isAbsolute(override) ? override : resolve(process.cwd(), override)) : (process.env.HOME?.trim() || homedir());
  return join(root, '.goodvibes');
}

function goodVibesDaemonDirectory(): string {
  const override = process.env.GOODVIBES_DAEMON_HOME?.trim();
  if (!override) return join(goodVibesTreeDirectory(), 'daemon');
  return isAbsolute(override) ? override : resolve(process.cwd(), override);
}

/** The daemon's own settings file names its control-plane listener, the dev proxy's target. */
function readControlPlaneSettings(): GoodVibesListenerSettings | undefined {
  const settingsPath = join(goodVibesDaemonDirectory(), 'settings.json');
  if (!existsSync(settingsPath)) return undefined;
  try {
    return (JSON.parse(readFileSync(settingsPath, 'utf8')) as GoodVibesDaemonSettings).controlPlane;
  } catch {
    return undefined;
  }
}

function listenerHost(settings: GoodVibesListenerSettings | undefined, fallback: string): string {
  const configuredHost = settings?.host?.trim();
  if (settings?.hostMode === 'network') return '0.0.0.0';
  if (settings?.hostMode === 'custom') return configuredHost || fallback;
  if (settings?.hostMode === 'local') return '127.0.0.1';
  return configuredHost || fallback;
}

function localhostTarget(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

function hostnameFromUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return parsed.hostname;
  } catch {
    return '';
  }
}

function csv(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function uniqueHosts(values: string[]): string[] {
  const ignored = new Set(['', '0.0.0.0', '::', '127.0.0.1', 'localhost']);
  const hosts = new Set<string>();
  for (const value of values) {
    const host = value.trim();
    if (!host || ignored.has(host)) continue;
    hosts.add(host);
    hosts.add(host.toLowerCase());
  }
  return [...hosts];
}

export default defineConfig(({ command, isPreview }) => {
// Where the dev server listens comes from the daemon (`goodvibes-daemon webui status
// --json`); one environment variable per value overrides it. The proxy target is the
// daemon's control-plane listener from its own settings file.
const discoverBinding = command === 'serve' && !isPreview && process.env.GOODVIBES_WEBUI_BINDING_DISCOVERY !== '0';
const daemonWebBinding = discoverBinding ? readWebBindingFromDaemon() : null;
if (discoverBinding && !daemonWebBinding) {
  console.warn(
    '[vite] The daemon did not answer `goodvibes-daemon webui status --json`; the dev server binds ' +
    '127.0.0.1:3423 unless GOODVIBES_WEB_HOST / GOODVIBES_WEB_PORT say otherwise.',
  );
}
const controlPlaneSettings = discoverBinding ? readControlPlaneSettings() : undefined;
const controlPlaneHost = listenerHost(controlPlaneSettings, '127.0.0.1');
const controlPlanePort = controlPlaneSettings?.port ?? 3421;
const daemonTarget = process.env.GOODVIBES_DAEMON_BASE_URL
  ?? `http://${localhostTarget(controlPlaneHost)}:${controlPlanePort}`;
const devHost = process.env.GOODVIBES_WEB_HOST ?? daemonWebBinding?.host ?? '127.0.0.1';
const devPort = Number(process.env.GOODVIBES_WEB_PORT ?? daemonWebBinding?.port ?? 3423);
const machineHostname = hostname();
const devAllowedHosts = uniqueHosts([
  ...csv(process.env.GOODVIBES_WEB_ALLOWED_HOSTS),
  hostnameFromUrl(process.env.GOODVIBES_WEB_PUBLIC_BASE_URL),
  hostnameFromUrl(daemonWebBinding?.url),
  machineHostname,
  `${machineHostname}.local`,
  'goodvibes.local',
]);

// This app's own build version, baked in at build/dev-server-start time from
// package.json, read here (config-eval time, Node/Bun) rather than imported as JSON
// into browser code, so no resolveJsonModule config is needed for src/. Exposed as
// `import.meta.env.VITE_WEBUI_VERSION`, same access pattern as the other VITE_-prefixed
// values this config already threads through (GOODVIBES_BASE_URL). Used to compare this
// running build against a daemon-announced client-build floor (lib/client-compatibility.ts).
const webuiVersion = (JSON.parse(readFileSync(join(CONFIG_DIR, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';

return {
  plugins: [react(), workspaceEnginePlugin()],
  define: {
    'import.meta.env.VITE_WEBUI_VERSION': JSON.stringify(webuiVersion),
  },
  server: {
    host: devHost,
    port: devPort,
    strictPort: true,
    allowedHosts: devAllowedHosts,
    proxy: {
      '/api': {
        target: daemonTarget,
        changeOrigin: true,
        ws: true,
      },
      '/login': {
        target: daemonTarget,
        changeOrigin: true,
      },
      '/status': {
        target: daemonTarget,
        changeOrigin: true,
      },
      '/task': {
        target: daemonTarget,
        changeOrigin: true,
      },
      '/config': {
        target: daemonTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/packages/engine/') || id.includes('@goodvibes/engine/')) return 'goodvibes-engine';
          if (!id.includes('node_modules')) return undefined;
          if (
            id.includes('react-markdown')
            || id.includes('remark-')
            || id.includes('micromark')
            || id.includes('unified')
            || id.includes('mdast')
            || id.includes('hast')
            || id.includes('unist')
            || id.includes('vfile')
          ) return 'markdown';
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (id.includes('@tanstack')) return 'query';
          if (id.includes('lucide-react')) return 'icons';
          // onnxruntime-web keeps its OWN chunk instead of falling into the eagerly
          // loaded `vendor` one. It is imported dynamically and only when wake-word
          // detection is switched on for this origin (lib/voice/wake-runtime.ts), so
          // merging it into vendor would put an inference runtime, and the reference
          // to a 13 MB wasm binary, in front of every page load for a feature that
          // ships off. One chunk per backend build, so a tab on the wasm backend never
          // fetches the webgpu one.
          if (id.includes('onnxruntime')) return 'onnxruntime';
          // jsqr is the pairing scanner's fallback QR decoder (lib/pairing-qr-detector.ts),
          // dynamically imported only when a browser has no BarcodeDetector AND
          // someone opens the scanner. Its own chunk for the same reason
          // onnxruntime gets one: `vendor` is fetched on every page load, and
          // putting a decoder there would make every session pay for a sign-in
          // screen fallback that most of them never reach.
          if (id.includes('jsqr')) return 'qr-decoder';
          return 'vendor';
        },
      },
    },
  },
};
});
