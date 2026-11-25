/**
 * Playbook: Plugin Degradation
 *
 * Plugins that failed to start, were quarantined, or are enabled and not running.
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
      label: 'Plugins that failed or are quarantined',
      description: 'Plugins whose last start failed, and plugins under quarantine.',
      run: (ctx) => safeCheck(() => {
        const plugins = ctx.plugins?.();
        if (!plugins) return { passed: true, evaluated: false, summary: 'This app runs no plugins to read.', severity: 'info' };
        const failing = plugins.filter((plugin) => plugin.startFailure !== undefined || plugin.quarantined);
        const active = plugins.filter((plugin) => plugin.active).length;
        return {
          passed: failing.length === 0,
          summary: failing.length === 0
            ? `${active} plugin(s) active; none failed or quarantined.`
            : failing.slice(0, 5).map((plugin) => `${plugin.name}: ${plugin.quarantined ? 'quarantined' : `did not start (${plugin.startFailure})`}`).join('; '),
          severity: failing.length === 0 ? 'info' : 'error',
          context: { failing: failing.length, active },
        };
      }),
    },
    {
      id: 'plugin.capability-available',
      label: 'Enabled plugins not active',
      description: 'Plugins that are enabled but not running, so their tools are not offered.',
      run: (ctx) => safeCheck(() => {
        const plugins = ctx.plugins?.();
        if (!plugins) return { passed: true, evaluated: false, summary: 'This app runs no plugins to read.', severity: 'info' };
        const idle = plugins.filter((plugin) => plugin.enabled && !plugin.active);
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
    { step: 1, title: 'See why it failed', action: 'Open Tools and extensions from the menu, Plugins, and press Enter on the plugin for its state, trust and last error.', kind: 'observe', expectedOutcome: 'The cause is named.', automatable: false },
    { step: 2, title: 'Reload it', action: 'Fix the cause (a missing dependency, a setting), then "load them again" on the Plugins tab of Tools and extensions.', kind: 'observe', expectedOutcome: 'The plugin is active and its tools are offered again.', automatable: false },
    { step: 3, title: 'Turn it off', action: 'If it keeps failing, switch it off on the Plugins tab of Tools and extensions so it stops being retried.', kind: 'observe', expectedOutcome: 'The plugin is disabled; everything else is unaffected.', automatable: false },
  ],
  escalationCriteria: [
    'A plugin fails again right after a reload',
    'A plugin is quarantined and you did not expect it',
  ],
  tags: ['plugin', 'degraded', 'error', 'quarantine'],
};
