/**
 * Playbook: Plugin Degradation
 *
 * Plugins that failed to start, stopped, or run degraded.
 */
import type { Playbook } from '../types.js';
import { safeCheck } from '../safe-check.js';

/** Plugin degradation resolution playbook. */
export const pluginDegradationPlaybook: Playbook = {
  id: 'plugin-degradation',
  name: 'Plugin Degradation',
  description: 'Diagnoses plugins that failed to start, stopped, or run degraded, and the tools they no longer provide.',
  symptoms: [
    'A plugin failed to load or start',
    'Tools from a plugin are missing',
    'Plugin errors in the activity log',
    'A plugin was quarantined or disabled',
  ],
  checks: [
    {
      id: 'plugin.health-status',
      label: 'Plugins in error or degraded',
      description: 'Plugins whose last lifecycle state is error or degraded.',
      run: (ctx) => safeCheck(() => {
        const { plugins } = ctx.store.getState();
        const failing = [...plugins.plugins.values()].filter((plugin) => plugin.status === 'error' || plugin.status === 'degraded');
        return {
          passed: failing.length === 0,
          summary: failing.length === 0
            ? `${plugins.totalActive} plugin(s) active; none in error.`
            : failing.slice(0, 5).map((plugin) => `${plugin.name}: ${plugin.status}${plugin.error ? ` (${plugin.error})` : ''}`).join('; '),
          severity: failing.length === 0 ? 'info' : 'error',
          context: { failing: failing.length, active: plugins.totalActive },
        };
      }),
    },
    {
      id: 'plugin.capability-available',
      label: 'Enabled plugins not active',
      description: 'Plugins that are enabled but not running, so their tools are not offered.',
      run: (ctx) => safeCheck(() => {
        const { plugins } = ctx.store.getState();
        if (!plugins.initialLoadComplete) return { passed: true, summary: 'Plugins are still loading.', severity: 'info' };
        const idle = [...plugins.plugins.values()].filter((plugin) => plugin.enabled && !plugin.active);
        return {
          passed: idle.length === 0,
          summary: idle.length === 0 ? 'Every enabled plugin is active.' : `Enabled but not active: ${idle.slice(0, 5).map((plugin) => plugin.name).join(', ')}.`,
          severity: idle.length === 0 ? 'info' : 'warning',
          context: { enabledNotActive: idle.length },
        };
      }),
    },
  ],
  steps: [
    { step: 1, title: 'See why it failed', action: 'Run /plugin inspect <name> in the goodvibes terminal app for the plugin\'s state, trust and last error.', kind: 'command', command: '/plugin inspect <name>', expectedOutcome: 'The cause is named.', automatable: false },
    { step: 2, title: 'Reload it', action: 'Fix the cause (a missing dependency, a setting) and reload the plugin from /plugin.', kind: 'command', command: '/plugin', expectedOutcome: 'The plugin is active and its tools are offered again.', automatable: false },
    { step: 3, title: 'Turn it off', action: 'If it keeps failing, disable it from /plugin so it stops being retried.', kind: 'command', command: '/plugin', expectedOutcome: 'The plugin is disabled; everything else is unaffected.', automatable: false },
  ],
  escalationCriteria: [
    'A plugin fails again right after a reload',
    'A plugin is quarantined and you did not expect it',
  ],
  tags: ['plugin', 'degraded', 'error', 'quarantine'],
};
