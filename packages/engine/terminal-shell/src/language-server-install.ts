/**
 * `/intelligence install <file|language>`: the owner's explicit action that
 * installs a language server into the user's GoodVibes bin directory. A code
 * lookup never installs one; its "no server" answer names this command, so
 * both terminal apps run the same install and print the same result.
 */
import type { LanguageServerInstallOutcome } from '@goodvibes-jev/engine/platform/platform/intelligence';

export const LANGUAGE_SERVER_INSTALL_USAGE = '/intelligence install <file|language>';

/** What the install needs from the app: where to print, how to read a path, and a hold on the workspace's code intelligence. */
export interface LanguageServerInstallDeps {
  readonly print: (text: string) => void;
  /** A file argument as an absolute workspace path. */
  readonly resolvePath: (target: string) => string;
  readonly hold: () => {
    readonly intelligence: { installLanguageServer(fileOrLanguage: string): Promise<LanguageServerInstallOutcome> };
    release(): Promise<void>;
  };
  /** The step this app offers once a server is installed. */
  readonly nextAfterInstall: string;
}

/** The lines one install outcome prints. */
export function languageServerInstallLines(outcome: LanguageServerInstallOutcome, nextAfterInstall: string): string[] {
  return [
    `Intelligence Install: ${outcome.langId}`,
    `  ${outcome.status}: ${outcome.reason}`,
    ...(outcome.path ? [`  path: ${outcome.path}`] : []),
    ...(outcome.status === 'installed' || outcome.status === 'already-installed'
      ? [`  next: ${nextAfterInstall}`] : []),
  ];
}

/** Install the language server for a file's language or a language id, printing progress and the outcome. */
export async function runLanguageServerInstall(target: string | undefined, deps: LanguageServerInstallDeps): Promise<void> {
  if (!target) {
    deps.print(`Intelligence Install\n  Usage: ${LANGUAGE_SERVER_INSTALL_USAGE}  (installs the language server for that language into your GoodVibes bin directory)`);
    return;
  }
  const hold = deps.hold();
  try {
    const subject = target.includes('.') || target.includes('/') ? deps.resolvePath(target) : target;
    deps.print(`Intelligence Install: ${target}\n  installing (up to 3 minutes)...`);
    const outcome = await hold.intelligence.installLanguageServer(subject);
    deps.print(languageServerInstallLines(outcome, deps.nextAfterInstall).join('\n'));
  } finally {
    await hold.release();
  }
}
