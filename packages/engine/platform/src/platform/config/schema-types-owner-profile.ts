/**
 * schema-types-owner-profile.ts, the `profile.*` config domain's types.
 *
 * The shape only: GoodVibesConfig (schema-types.ts) imports it as `profile`,
 * and `ConfigKey` / `ConfigValue` are read off that shape. The defaults, the
 * descriptions and the editable settings rows are in
 * schema-domain-owner-profile.ts.
 */

/** The owner profile's operator-editable policy (`profile.*`). */
export interface OwnerProfileConfig {
  /** Whether the profile is loaded and served at all. */
  enabled: boolean;
  /** Whether the runtime may record facts it learns from the owner without asking. */
  autonomousWrites: boolean;
  /** Whether an autonomous write says, in one line, what it recorded. */
  discloseWrites: boolean;
  /** Whether the open tier is rendered into system context each turn. */
  injectOpenTier: boolean;
  /** Whether a named closed-tier read is announced in the reply. */
  discloseClosedTierReads: boolean;
  /** Whether an unset consumer config key falls back to the matching profile field. */
  consumerFallback: boolean;
  /** Poll interval, in ms, where `fs.watch` is unavailable. Never on a read. */
  reloadThrottleMs: number;
  /** Absolute path override. Empty means the default under the daemon home. */
  path: string;
  /** Whether a conversational turn may record what the owner says about himself. */
  conversationalCapture: boolean;
  /** Comma-separated channels that carry the owner's own voice. Empty inherits the nudge channels. */
  ownerChannels: string;
}
