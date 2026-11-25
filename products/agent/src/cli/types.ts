export type GoodVibesCliCommand =
  | 'tui'
  | 'run'
  | 'do'
  | 'find'
  | 'status'
  | 'doctor'
  | 'onboarding'
  | 'models'
  | 'providers'
  | 'profiles'
  | 'personas'
  | 'skills'
  | 'memory'
  | 'routines'
  | 'ci'
  | 'principals'
  | 'owner-profile'
  | 'channel-profiles'
  | 'workspaces'
  | 'browser'
  | 'plugin'
  | 'fleet'
  | 'auth'
  | 'compat'
  | 'knowledge'
  | 'ask'
  | 'search'
  | 'delegate'
  | 'subscription'
  | 'secrets'
  | 'sessions'
  | 'tasks'
  | 'relay'
  | 'pair'
  | 'bundle'
  | 'import'
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
  /** `--just-vibes` or `--yolo`: the execution mode for this launch. */
  readonly permissionMode?: 'just-vibes' | 'yolo' | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly agentProfile: string | undefined;
  readonly runtimeUrl: string | undefined;
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
  readonly port: number | undefined;
  readonly hostname: string | undefined;
  readonly open: boolean;
  readonly continueLast: boolean;
  readonly resume: string | undefined;
  readonly session: string | undefined;
  readonly fork: boolean;
  readonly rawOutput: boolean;
  readonly acceptRawOutputRisk: boolean;
  /** `run --intake-status|retry|resume|cancel`: recover the saved native input instead of sending a new one. */
  readonly intakeMode?: 'status' | 'retry' | 'resume' | 'cancel' | undefined;
  /** `run` limits, as typed; parseNativeShellCli checks them and turns them into the run's limits. */
  readonly timeout?: string | undefined;
  readonly maxTurns?: string | undefined;
  readonly omitAccumulated?: boolean | undefined;
  readonly answerPermissions?: boolean | undefined;
  /** `run --prompt-file <path>`: the prompt is that file's text; `-` reads it from standard input. */
  readonly promptFile?: string | undefined;
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
  /** Non-fatal notices: a deprecated alias, or a near-miss first word taken as the prompt. */
  readonly warnings: readonly string[];
}
