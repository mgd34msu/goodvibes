import * as LSP from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
type LinterOptions = {
    executablePath: string;
    cwd?: string;
};
export type LintingResult = {
    diagnostics: LSP.Diagnostic[];
    codeActions: Record<string, LSP.CodeAction | undefined>;
};
export declare class Linter {
    private cwd;
    executablePath: string;
    private uriToDebouncedExecuteLint;
    private _canLint;
    constructor({ cwd, executablePath }: LinterOptions);
    get canLint(): boolean;
    /** Resolves `undefined` when a later lint of the same document superseded this one before it ran (GoodVibes patch). */
    lint(document: TextDocument, sourcePaths: string[], additionalShellCheckArguments?: string[]): Promise<LintingResult | undefined>;
    private executeLint;
    private runShellCheck;
}
export {};
