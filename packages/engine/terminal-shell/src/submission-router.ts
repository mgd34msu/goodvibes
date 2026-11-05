import type { SubmissionIntent } from './submission-intent.js';
export interface SubmissionRouterInput {
    readonly text: string;
    readonly commandMode?: boolean | undefined;
    readonly hasAttachments?: boolean | undefined;
}
export interface SubmissionCommandRule {
    readonly commands: readonly string[];
    readonly kind: SubmissionIntent['kind'];
    readonly label: string;
}
/** Product command vocabularies are data; prefix parsing and routing have one owner. */
export function createSubmissionRouter(rules: readonly SubmissionCommandRule[]): (input: SubmissionRouterInput) => SubmissionIntent {
    const commands = new Map(rules.flatMap(rule => rule.commands.map(command => [command, { kind: rule.kind, label: rule.label }] as const)));
    return input => routeSubmissionIntent(input, commands);
}
export function routeSubmissionIntent(input: SubmissionRouterInput, commands: ReadonlyMap<string, Pick<SubmissionIntent, 'kind' | 'label'>>): SubmissionIntent {
    const trimmed = input.text.trim();
    const hasAttachments = input.hasAttachments ?? false;
    if (!trimmed) {
        return { kind: 'empty', label: 'prompt', hasAttachments };
    }
    if (trimmed.startsWith('!#')) {
        return { kind: 'memory-pin', label: 'memory pin', hasAttachments };
    }
    if (trimmed.startsWith('!')) {
        return { kind: 'shell', label: 'shell', hasAttachments };
    }
    if (input.commandMode || trimmed.startsWith('/')) {
        const commandName = trimmed.replace(/^\//, '').split(/\s+/, 1)[0] ?? '';
        const match = commands.get(commandName);
        if (match)
            return { ...match, commandName, hasAttachments };
        return { kind: 'slash-command', label: 'command', commandName, hasAttachments };
    }
    return { kind: 'prompt', label: 'prompt', hasAttachments };
}
