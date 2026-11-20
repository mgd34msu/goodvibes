/**
 * cli-types.ts, the shared shape of a `goodvibes` front-end's command line:
 * every recognized command word, every global flag, and the parse result a
 * caller consumes.
 */
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';

export type GoodVibesCliCommand =
  | 'tui'
  | 'open'
  | 'run'
  | 'serve'
  | 'web'
  | 'service'
  | 'status'
  | 'doctor'
  | 'setup'
  | 'models'
  | 'providers'
  | 'auth'
  | 'subscription'
  | 'secrets'
  | 'sessions'
  | 'tasks'
  | 'pair'
  | 'surfaces'
  | 'listener'
  | 'control-plane'
  | 'support-bundle'
  | 'remote'
  | 'bridge'
  | 'hooks'
  | 'plugin'
  | 'completion'
  | 'help'
  | 'version'
  | 'unknown';

export type GoodVibesCliOutputFormat = 'text' | 'json' | 'stream-json';

export interface CliCommandOutput {
  readonly output: string;
  readonly exitCode: number;
}

export interface GoodVibesCliFlags {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly daemonHome: string | undefined;
  readonly workingDir: string | undefined;
  readonly help: boolean;
  readonly version: boolean;
  readonly prompt: string | undefined;
  readonly print: boolean;
  readonly outputFormat: GoodVibesCliOutputFormat;
  readonly configOverrides: readonly string[];
  readonly enableFeatures: readonly string[];
  readonly disableFeatures: readonly string[];
  readonly noAltScreen: boolean;
  /** `--just-vibes` or `--yolo`: the execution mode for this launch. */
  readonly permissionMode?: 'just-vibes' | 'yolo' | undefined;
  readonly port: number | undefined;
  readonly hostname: string | undefined;
  readonly open: boolean;
  readonly continueLast: boolean;
  readonly resume: string | undefined;
  readonly session: string | undefined;
  readonly fork: string | true | undefined;
  readonly yes: boolean;
  readonly nonInteractive: boolean;
  /** `doctor --strict`: advisory findings also fail (exit 1), for CI. Ignored by every other command. */
  readonly strict: boolean;
  /** `run --intake-status|retry|resume|cancel`: recover the saved native input instead of sending a new one. */
  readonly intakeMode?: 'status' | 'retry' | 'resume' | 'cancel' | undefined;
  /** `run` limits, as typed; parseNativeShellCli checks them and turns them into the run's limits. */
  readonly timeout?: string | undefined;
  readonly maxTurns?: string | undefined;
  readonly omitAccumulated?: boolean | undefined;
  readonly answerPermissions?: boolean | undefined;
}

export interface GoodVibesCliParseResult {
  readonly binary: string;
  readonly command: GoodVibesCliCommand;
  readonly rawCommand: string | undefined;
  readonly commandArgs: readonly string[];
  /** The words typed after `--`: literal text, never options; also the tail of `commandArgs` (see optionArgsOf). */
  readonly literalArgs?: readonly string[] | undefined;
  readonly positionals: readonly string[];
  readonly flags: GoodVibesCliFlags;
  readonly errors: readonly string[];
  /** Deprecation and soft-warning messages (non-fatal). Callers should surface these to users. */
  readonly warnings: readonly string[];
}

export interface CliCommandRuntime {
  readonly cli: GoodVibesCliParseResult;
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}
