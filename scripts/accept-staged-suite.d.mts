export interface StagedAsset {
  path: string; revision: string; size: number;
}
export interface AdmittedStagedAssets {
  root: string; entries: Map<string, StagedAsset>;
  assertCurrent(name: string): StagedAsset;
}
export function admitStagedAssets(directory: string, signal?: AbortSignal): Promise<AdmittedStagedAssets>;
export function startStagedReleaseFeed(admitted: AdmittedStagedAssets, tag: string): Promise<{
  url: string; assertCurrent(): void; close(): Promise<void>;
}>;
export function acceptStagedSuite(input: {
  tag: string; source: string; target: string; directory: string;
  scenario?: 'fresh' | 'upgrade-v3.1.1'; signal?: AbortSignal;
}): Promise<void>;
