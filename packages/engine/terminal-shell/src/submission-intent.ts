export type SubmissionIntentKind = 'empty' | 'prompt' | 'slash-command' | 'delegation' | 'orchestration' | 'plan' | 'review' | 'view-action' | 'shell' | 'memory-pin';
export interface SubmissionIntent {
    readonly kind: SubmissionIntentKind;
    readonly label: string;
    readonly commandName?: string | undefined;
    readonly hasAttachments: boolean;
}
