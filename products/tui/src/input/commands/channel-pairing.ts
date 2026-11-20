/**
 * channel-pairing.ts, the "A chat channel" choice of `/devices pair` (Pair something).
 *
 * Adapters and their credential requirements are driven from the platform's
 * getBuiltinSetupSchema, the same setup-schema source every GoodVibes
 * consumer (TUI, webui, agent) reads, not a hand-maintained list here.
 * Secret (masked) credentials are stored the same secure way onboarding
 * stores them, via persistSecretBackedConfigValue (secret manager + a
 * config reference), so the plaintext never lands in config or the
 * transcript.
 *
 *   /devices pair channel <surface> → show the adapter's declared fields, ask
 *                                      for every missing required one (and offer
 *                                      the optional ones, skippable), then enable
 *                                      the surface once every required field is set
 *
 * A real round-trip (a test message through the daemon) is `/channels test <surface>`.
 */
import { getBuiltinSetupSchema } from '@goodvibes/engine/platform/platform/channels';
import type { ChannelSetupFieldDescriptor, ChannelSetupSchema, ChannelSurface } from '@goodvibes/engine/platform/platform/channels';
import type { CommandContext } from '../command-registry.ts';
import type { ConfigManager, ConfigKey } from '@goodvibes/engine/platform/platform/config';
import { persistSecretBackedConfigValue } from '../../config/secret-config.ts';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';

/**
 * Surfaces pairable through /devices pair channel, every ChannelSurface except the
 * two internal render surfaces ('tui', 'web'), which are not externally
 * paired channels. The `satisfies Record<...>` shape makes this exhaustive:
 * a new ChannelSurface value that isn't listed here fails to compile.
 */
type PairableSurface = Exclude<ChannelSurface, 'tui' | 'web'>;
const PAIRABLE_SURFACE_SET = {
  slack: true,
  discord: true,
  ntfy: true,
  webhook: true,
  homeassistant: true,
  telegram: true,
  'google-chat': true,
  signal: true,
  whatsapp: true,
  telephony: true,
  imessage: true,
  msteams: true,
  bluebubbles: true,
  mattermost: true,
  matrix: true,
} satisfies Record<PairableSurface, true>;
export const PAIRABLE_SURFACES: readonly PairableSurface[] = Object.keys(PAIRABLE_SURFACE_SET) as PairableSurface[];

function findSchema(surface: string): ChannelSetupSchema | undefined {
  return PAIRABLE_SURFACES.includes(surface as PairableSurface) ? getBuiltinSetupSchema(surface as PairableSurface) : undefined;
}

/** The always-present 'enabled' boolean field's config key, if declared. */
function enabledConfigKey(schema: ChannelSetupSchema): ConfigKey | undefined {
  return schema.fields.find((f) => f.id === 'enabled' && f.kind === 'boolean')?.configKey as ConfigKey | undefined;
}

/**
 * Whether a surface is switched on in settings, read through the key its setup
 * schema declares (`surfaces.googleChat.enabled` for google-chat); undefined
 * for a surface with no schema or no such switch.
 */
export function surfaceEnabledInSettings(configManager: ConfigManager, surface: string): boolean | undefined {
  const schema = findSchema(surface);
  const key = schema ? enabledConfigKey(schema) : undefined;
  return key === undefined ? undefined : configManager.get(key) === true;
}

function fieldValue(field: ChannelSetupFieldDescriptor, configManager: ConfigManager): string {
  if (!field.configKey) return '';
  const raw = configManager.get(field.configKey as ConfigKey);
  return raw === undefined || raw === null ? '' : String(raw);
}

/** A field counts as configured once it has any stored value; 'select' fields always carry a default. */
function fieldConfigured(field: ChannelSetupFieldDescriptor, configManager: ConfigManager): boolean {
  if (field.kind === 'select' || field.kind === 'boolean') return true;
  return fieldValue(field, configManager).length > 0;
}

/** Values the user supplies, secret and plain; booleans and selects carry defaults. Each says whether it is required. */
function credentialFields(schema: ChannelSetupSchema): ChannelSetupFieldDescriptor[] {
  return schema.fields.filter((field) => field.kind === 'secret' || field.kind === 'string' || field.kind === 'url' || field.kind === 'number');
}

/** A field-level hint: the matching secretTarget's detail for secrets, else the placeholder, else the label. */
function fieldHint(field: ChannelSetupFieldDescriptor, schema: ChannelSetupSchema): string {
  if (field.kind === 'secret' && field.secretTargetId) {
    const target = schema.secretTargets.find((t) => t.id === field.secretTargetId);
    if (target?.detail) return target.envKeys?.length ? `${target.detail} (env: ${target.envKeys.join(', ')})` : target.detail;
  }
  return field.placeholder ? `e.g. ${field.placeholder}` : field.label;
}

function listAdapters(ctx: CommandContext): void {
  const configManager = ctx.platform.configManager;
  const lines: string[] = ['Channel adapters: pair with /devices pair channel <surface>:', ''];
  for (const surface of PAIRABLE_SURFACES) {
    const schema = getBuiltinSetupSchema(surface);
    const creds = credentialFields(schema);
    const set = creds.filter((f) => fieldConfigured(f, configManager)).length;
    const enabledKey = enabledConfigKey(schema);
    const enabled = enabledKey !== undefined && configManager.get(enabledKey) === true;
    const required = creds.filter((f) => f.required);
    const requiredSet = required.filter((f) => fieldConfigured(f, configManager)).length;
    const state = creds.length === 0 ? 'no values' : required.length > 0 ? `${requiredSet}/${required.length} required set` : `${set}/${creds.length} optional set`;
    lines.push(`  ${surface.padEnd(14)} ${schema.label.padEnd(22)} ${state.padEnd(12)} ${enabled ? '(enabled)' : ''}`);
  }
  lines.push('');
  lines.push('Run /devices pair channel <surface> to see and enter its declared credentials.');
  ctx.print(lines.join('\n'));
}

function renderSurface(schema: ChannelSetupSchema, configManager: ConfigManager): string[] {
  const lines = [`${schema.label} (${schema.surface})`, schema.description, '', `Setup mode: ${schema.setupMode}`, '', 'Declared credentials:'];
  for (const field of credentialFields(schema)) {
    const configured = fieldConfigured(field, configManager);
    const kindTag = field.kind === 'secret' ? 'secret' : 'value';
    const status = configured ? 'set' : 'not set';
    lines.push(`  - ${field.label} (${kindTag}, ${field.required ? 'required' : 'optional'}): ${status}; ${fieldHint(field, schema)}`);
  }
  if (schema.externalSteps.length > 0) {
    lines.push('', 'External setup steps:');
    for (const step of schema.externalSteps) lines.push(`  - ${step}`);
  }
  return lines;
}

/** Required fields that still have no stored value. */
function missingRequired(schema: ChannelSetupSchema, configManager: ConfigManager): ChannelSetupFieldDescriptor[] {
  return credentialFields(schema).filter((field) => field.required && !fieldConfigured(field, configManager));
}

/**
 * Enable the surface when every required field has a value, or say which are
 * missing. Optional fields never block it.
 */
async function finishPairing(ctx: CommandContext, schema: ChannelSetupSchema, storedAny: boolean): Promise<void> {
  const configManager = ctx.platform.configManager;
  const missing = missingRequired(schema, configManager);
  if (missing.length > 0) {
    // Enabling a surface with a required value missing would start it half-configured.
    ctx.print(`\n${schema.label} was NOT enabled: still missing ${missing.map((f) => f.label).join(', ')} (required). Re-run /devices pair channel ${schema.surface} to enter ${missing.length === 1 ? 'it' : 'them'}.`);
    ctx.renderRequest();
    return;
  }
  const enabledKey = enabledConfigKey(schema);
  const wasEnabled = enabledKey !== undefined && configManager.get(enabledKey) === true;
  if (enabledKey !== undefined && !wasEnabled) {
    configManager.setDynamic(enabledKey, true);
    // The switch is the daemon's: it counts as on only once the daemon took it.
    const refused = await daemonRefusal(configManager, enabledKey);
    if (refused) {
      ctx.print(`\n${schema.label}: every required value is set${storedAny ? ' and the new ones are stored' : ''}, but the surface was NOT enabled: the daemon refused ${enabledKey} (${refused}). Fix that, then run /devices pair channel ${schema.surface} again.`);
      ctx.renderRequest();
      return;
    }
  }
  const state = enabledKey === undefined ? '' : wasEnabled ? ' The surface was already enabled.' : ' The surface is enabled.';
  ctx.print(`\n${schema.label}: every required value is set${storedAny ? ' and the new ones are stored' : ''}.${state} Send a test message with: /channels test ${schema.surface}`);
  ctx.renderRequest();
}

/** The daemon's refusal of `key` among the writes sent and not yet answered, or null when it took it (or nothing was sent). */
async function daemonRefusal(configManager: ConfigManager, key: string): Promise<string | null> {
  const refused = (await configManager.settleDaemonWrites()).find((entry) => entry.key === key);
  return refused ? (refused.error instanceof Error ? refused.error.message : String(refused.error)) : null;
}

/**
 * Store one entered value: secrets through the secret store (config keeps a
 * reference), plain values in config. Resolves once the value stands: a
 * daemon setting only after the daemon took it, so "stored" is never printed
 * for a value it refused.
 */
async function storeFieldValue(ctx: CommandContext, field: ChannelSetupFieldDescriptor, configKey: ConfigKey, value: string): Promise<void> {
  const configManager = ctx.platform.configManager;
  if (field.kind === 'secret') {
    await persistSecretBackedConfigValue(configManager, ctx.platform.secretsManager, configKey, value);
  } else if (field.kind === 'number') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`"${value}" is not a number`);
    configManager.setDynamic(configKey, parsed);
  } else {
    configManager.setDynamic(configKey, value);
  }
  const refused = await daemonRefusal(configManager, configKey);
  if (refused) throw new Error(`the daemon refused ${configKey} (${refused})`);
}

/** Ask for each missing field in turn (required first), then finish. A skipped optional field is not a failure. */
function promptMissingFields(
  ctx: CommandContext,
  schema: ChannelSetupSchema,
  missing: readonly ChannelSetupFieldDescriptor[],
  index: number,
  storedAny = false,
): void {
  if (index >= missing.length) {
    void finishPairing(ctx, schema, storedAny);
    return;
  }
  const field = missing[index]!;
  if (!field.configKey) {
    ctx.print(`[pair] ${field.label} has no config key declared; skipping.`);
    promptMissingFields(ctx, schema, missing, index + 1, storedAny);
    return;
  }
  const configKey = field.configKey as ConfigKey;
  if (!ctx.beginConcealedInput) {
    ctx.print(`[pair] This surface cannot take typed input; set ${missing.slice(index).map((f) => `${f.label} (${f.configKey})`).join(', ')} with /settings, then run /devices pair channel ${schema.surface} again.`);
    return;
  }
  const what = field.required ? 'required' : 'optional, Enter to skip';
  ctx.print(`[pair] Enter ${field.label} (${field.placeholder || fieldHint(field, schema)}; ${what}): typing is masked; Esc to stop.`);
  ctx.beginConcealedInput({
    label: field.label,
    onSubmit: (value) => {
      const entered = value.trim();
      if (entered.length === 0) {
        ctx.print(`[pair] ${field.label} ${field.required ? 'left unset' : 'skipped'}.`);
        promptMissingFields(ctx, schema, missing, index + 1, storedAny);
        return;
      }
      void storeFieldValue(ctx, field, configKey, entered)
        .then(() => {
          ctx.print(`[pair] ${field.label} stored${field.kind === 'secret' ? ' securely (hidden)' : ''}.`);
          promptMissingFields(ctx, schema, missing, index + 1, true);
        })
        .catch((error: unknown) => {
          ctx.print(`[pair] Failed to store ${field.label}: ${error instanceof Error ? error.message : String(error)}`);
          promptMissingFields(ctx, schema, missing, index + 1, storedAny);
        });
    },
    onCancel: () => {
      ctx.print(`[pair] Stopped. Re-run /devices pair channel ${schema.surface} to finish the remaining values.`);
    },
  });
}

/** Set up one surface: ask for its missing values, then switch it on; an empty surface lists the adapters. */
export async function runChannelPairing(surface: string, ctx: CommandContext): Promise<void> {
  if (!surface) {
    listAdapters(ctx);
    return;
  }
  const schema = findSchema(surface);
  if (!schema) throw commandRefusal(`Unknown channel "${surface}". Available: ${PAIRABLE_SURFACES.join(', ')}`);

  const configManager = ctx.platform.configManager;
  ctx.print(renderSurface(schema, configManager).join('\n'));
  const unset = credentialFields(schema).filter((f) => !fieldConfigured(f, configManager));
  const missing = [...unset.filter((f) => f.required), ...unset.filter((f) => !f.required)];
  if (missing.length === 0) {
    await finishPairing(ctx, schema, false);
    return;
  }
  const required = missing.filter((f) => f.required).length;
  ctx.print(`\nEntering ${missing.length} value(s)${required > 0 ? `, ${required} required` : ', all optional'}: Esc to stop.`);
  promptMissingFields(ctx, schema, missing, 0);
}
