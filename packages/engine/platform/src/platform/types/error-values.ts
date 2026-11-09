/** Runtime-neutral native application error identity and metadata. No decision readers. */
import { GoodVibesError } from '@goodvibes-jev/engine/errors';

export type PlatformErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'billing'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'bad_request'
  | 'not_found'
  | 'permission'
  | 'tool'
  | 'config'
  | 'protocol'
  | 'service'
  | 'internal'
  | 'unknown';

export type PlatformErrorSource =
  | 'provider'
  | 'tool'
  | 'transport'
  | 'config'
  | 'permission'
  | 'runtime'
  | 'render'
  | 'acp'
  | 'unknown';

export interface AppErrorOptions {
  readonly statusCode?: number | undefined;
  readonly category?: PlatformErrorCategory | undefined;
  readonly guidance?: string | undefined;
  readonly detail?: string | undefined;
  readonly source?: PlatformErrorSource | undefined;
  readonly provider?: string | undefined;
  readonly operation?: string | undefined;
  readonly phase?: string | undefined;
  readonly requestId?: string | undefined;
  readonly providerCode?: string | undefined;
  readonly providerType?: string | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly rawMessage?: string | undefined;
  readonly cause?: unknown | undefined;
}

/** Base class for all application errors. Provides a machine-readable code and recoverability hint. */
export class AppError extends GoodVibesError {
  /** HTTP status code associated with the failure. */
  public readonly statusCode?: number | undefined;
  /** Human-readable recovery guidance. */
  public readonly guidance?: string | undefined;
  /** Additional detail string not present on GoodVibesError. */
  public readonly detail?: string | undefined;
  /** Raw provider message before normalisation. */
  public readonly rawMessage?: string | undefined;

  constructor(
    message: string,
    public override readonly code: string,
    public override readonly recoverable: boolean,
    options: AppErrorOptions = {},
  ) {
    super(message, {
      code,
      recoverable,
      category: options.category,
      source: options.source,
      status: options.statusCode,
      hint: options.guidance,
      provider: options.provider,
      operation: options.operation,
      phase: options.phase,
      requestId: options.requestId,
      providerCode: options.providerCode,
      providerType: options.providerType,
      retryAfterMs: options.retryAfterMs,
      cause: options.cause,
    });
    this.name = this.constructor.name;
    this.statusCode = options.statusCode;
    this.guidance = options.guidance;
    this.detail = options.detail;
    this.rawMessage = options.rawMessage;
  }
}

