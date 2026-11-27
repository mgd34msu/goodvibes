import type { JsonRecord } from './route-helpers.js';
import type { ArtifactStoreUploadLike } from './artifact-upload.js';

export { ARTIFACT_KINDS, type ArtifactKind } from './artifact-upload.js';
export const FETCH_EXTRACT_MODES = [
  'raw', 'text', 'json', 'markdown', 'readable', 'code_blocks', 'links', 'metadata', 'structured', 'tables', 'pdf', 'summary',
] as const;
export type FetchExtractMode = typeof FETCH_EXTRACT_MODES[number];
export const MULTIMODAL_DETAILS = ['compact', 'standard', 'detailed'] as const;
export type MultimodalDetail = typeof MULTIMODAL_DETAILS[number];
export const WEB_SEARCH_VERBOSITIES = ['urls_only', 'titles', 'snippets', 'evidence', 'full'] as const;
export type WebSearchVerbosity = typeof WEB_SEARCH_VERBOSITIES[number];
export const WEB_SEARCH_SAFE_SEARCH = ['strict', 'moderate', 'off'] as const;
export type WebSearchSafeSearch = typeof WEB_SEARCH_SAFE_SEARCH[number];
export const WEB_SEARCH_TIME_RANGES = ['any', 'day', 'week', 'month', 'year'] as const;
export type WebSearchTimeRange = typeof WEB_SEARCH_TIME_RANGES[number];

/** An analysis as the daemon returned it; the service re-reads it and refuses one it did not produce. */
export type MultimodalAnalysisResult = unknown;

/** A media file a provider reads: inline bytes, a URI, or a stored artifact's id. */
export interface MediaArtifact {
  readonly id?: string | undefined;
  readonly artifactId?: string | undefined;
  readonly mimeType: string;
  readonly dataBase64?: string | undefined;
  readonly uri?: string | undefined;
  readonly filename?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly sha256?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

/** Audio a transcription reads: inline base64 or a URI. */
export interface VoiceAudioArtifact {
  readonly mimeType: string;
  readonly format: string;
  readonly dataBase64?: string | undefined;
  readonly uri?: string | undefined;
  readonly sampleRateHz?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface VoiceSynthesisStreamLike {
  readonly providerId: string;
  readonly mimeType: string;
  readonly format: string;
  readonly chunks: AsyncIterable<{ readonly data: Uint8Array }>;
  readonly metadata: Record<string, unknown>;
}

export interface ConfigManagerLike {
  get(key: string): unknown;
}

export interface VoiceSynthesisInput {
  readonly text: string;
  readonly voiceId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly format?: string | undefined;
  readonly speed?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface VoiceTranscriptionInput {
  readonly audio: VoiceAudioArtifact;
  readonly language?: string | undefined;
  readonly modelId?: string | undefined;
  readonly prompt?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface VoiceRealtimeSessionInput {
  readonly modelId?: string | undefined;
  readonly voiceId?: string | undefined;
  readonly inputFormat?: string | undefined;
  readonly outputFormat?: string | undefined;
  readonly instructions?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * The service members are function-typed properties, so the platform's
 * services are checked against them strictly where the router passes them in.
 */
export interface VoiceServiceLike {
  readonly getStatus: (enabled: boolean) => Promise<{ readonly providers: readonly unknown[] }>;
  readonly listVoices: (providerId?: string) => Promise<readonly unknown[]>;
  readonly synthesize: (providerId: string | undefined, input: VoiceSynthesisInput) => Promise<unknown>;
  readonly synthesizeStream: (providerId: string | undefined, input: VoiceSynthesisInput) => Promise<VoiceSynthesisStreamLike>;
  readonly transcribe: (providerId: string | undefined, input: VoiceTranscriptionInput) => Promise<unknown>;
  readonly openRealtimeSession: (providerId: string | undefined, input: VoiceRealtimeSessionInput) => Promise<unknown>;
}

export interface WebSearchInput {
  readonly query: string;
  readonly providerId?: string | undefined;
  readonly maxResults?: number | undefined;
  readonly verbosity?: WebSearchVerbosity | undefined;
  readonly region?: string | undefined;
  readonly safeSearch?: WebSearchSafeSearch | undefined;
  readonly timeRange?: WebSearchTimeRange | undefined;
  readonly includeInstantAnswer?: boolean | undefined;
  readonly includeEvidence?: boolean | undefined;
  readonly evidenceTopN?: number | undefined;
  readonly evidenceExtract?: FetchExtractMode | undefined;
}

export interface WebSearchServiceLike {
  readonly getStatus: () => Promise<{ readonly providers: readonly unknown[]; readonly defaultProviderId: string | null }>;
  readonly search: (input: WebSearchInput) => Promise<unknown>;
}

export interface ArtifactStoreLike extends ArtifactStoreUploadLike {
  readonly list: () => readonly unknown[];
  readonly get: (artifactId: string) => unknown | null;
  /** Removes one artifact (its record and content); false when there was none. */
  readonly delete?: ((artifactId: string) => boolean) | undefined;
  readonly readContent: (artifactId: string) => Promise<{
    // `| undefined` is required: the real ArtifactRecord declares
    // `filename?: string | undefined`, and under exactOptionalPropertyTypes
    // `filename?: string` is a DIFFERENT type.
    readonly record: { readonly mimeType: string; readonly filename?: string | undefined };
    readonly buffer: ArrayBuffer | Uint8Array;
  }>;
}

export interface MediaAnalysisInput {
  readonly artifact: MediaArtifact;
  readonly prompt?: string | undefined;
  readonly modelId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface MediaTransformInput {
  readonly artifact: MediaArtifact;
  readonly operation: string;
  readonly outputMimeType?: string | undefined;
  readonly options?: Record<string, unknown> | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface MediaGenerationInput {
  readonly prompt: string;
  readonly outputMimeType?: string | undefined;
  readonly modelId?: string | undefined;
  readonly options?: Record<string, unknown> | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface MediaProviderLike {
  readonly analyze?: ((input: MediaAnalysisInput) => Promise<unknown>) | undefined;
  readonly transform?: ((input: MediaTransformInput) => Promise<unknown>) | undefined;
  readonly generate?: ((input: MediaGenerationInput) => Promise<unknown>) | undefined;
}

/** A kind of media a generation provider makes. */
export type MediaOutputKindLike = 'image' | 'video' | 'audio';

export interface MediaProviderRegistryLike {
  readonly status: () => Promise<unknown>;
  readonly findProvider: (
    capability: 'understand' | 'transform' | 'generate',
    providerId?: string,
  ) => MediaProviderLike | null;
  /**
   * findProvider after each candidate has read credentials it does not yet
   * know, narrowed to providers that make `output` when one is asked for.
   */
  readonly resolveProvider: (
    capability: 'understand' | 'transform' | 'generate',
    providerId?: string,
    filter?: { readonly output?: MediaOutputKindLike | undefined },
  ) => Promise<MediaProviderLike | null>;
  /** Registered providers, with what each generation provider makes. */
  readonly list: () => readonly {
    readonly id: string;
    readonly label: string;
    readonly capabilities: readonly string[];
    readonly outputs?: readonly MediaOutputKindLike[] | undefined;
  }[];
  /** Finishes a generation job an earlier generate answered as pending. */
  readonly collect: (
    task: { readonly providerId: string; readonly taskId: string; readonly resume?: Readonly<Record<string, string>> | undefined },
    options?: { readonly waitSeconds?: number | undefined },
    lifetime?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<unknown>;
}

/** A file to analyse when it is not a stored artifact; private hosts come only from the daemon's policy. */
export interface MultimodalArtifactInput {
  readonly artifactId?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly dataBase64?: string | undefined;
  readonly uri?: string | undefined;
  readonly allowPrivateHosts?: boolean | undefined;
  readonly filename?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface MultimodalAnalysisInput {
  readonly artifactId?: string | undefined;
  readonly artifact?: MultimodalArtifactInput | undefined;
  readonly prompt?: string | undefined;
  readonly imageProviderId?: string | undefined;
  readonly audioProviderId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly language?: string | undefined;
  readonly detail?: MultimodalDetail | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface MultimodalWritebackInput {
  readonly sessionId?: string | undefined;
  readonly title?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly folderPath?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface MultimodalServiceLike {
  readonly getStatus: () => Promise<unknown>;
  readonly listProviders: () => Promise<readonly unknown[]>;
  readonly analyze: (input: MultimodalAnalysisInput, options?: { readonly signal?: AbortSignal | undefined }) => Promise<MultimodalAnalysisResult>;
  readonly buildPacket: (analysis: MultimodalAnalysisResult, detail: MultimodalDetail, budgetLimit?: number) => unknown;
  readonly writeBackAnalysis: (
    analysis: MultimodalAnalysisResult,
    input: MultimodalWritebackInput,
    options?: { readonly signal?: AbortSignal | undefined; readonly assertCurrent?: (() => void) | undefined },
  ) => Promise<unknown>;
}

export interface DaemonMediaRouteContext {
  readonly artifactStore: ArtifactStoreLike;
  readonly configManager: ConfigManagerLike;
  readonly mediaProviders: MediaProviderRegistryLike;
  readonly multimodalService: MultimodalServiceLike;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly voiceService: VoiceServiceLike;
  readonly webSearchService: WebSearchServiceLike;
  /**
   * The principal the request authenticated as: kept on a file it stores (`metadata.createdBy`), which is who the file
   * belongs to (platform control-plane/caller-reach.ts). Absent: no maker is kept (the owner's only).
   */
  readonly callerPrincipal?: ((req: Request) => string | undefined) | undefined;
}
