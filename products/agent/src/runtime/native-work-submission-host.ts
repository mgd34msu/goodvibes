import { nativeSubmissionIdentity as identify, type NativeSubmissionHost } from '@goodvibes-jev/engine/terminal-shell/native-work-submission-host';
export * from '@goodvibes-jev/engine/terminal-shell/native-work-submission-host';
// Keep existing durable journal identities byte-stable.
export const nativeSubmissionIdentity = (host: NativeSubmissionHost, projectId: string) => identify(host, projectId, 'paired');
