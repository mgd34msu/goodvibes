/**
 * template-session.ts, what the program holding the conversation supplies for
 * the template capabilities that run there (platform capabilities/builtin/
 * templates.ts): the templates of its project, its conversation (a template
 * sent as the next message, the last message kept as one) and the person's
 * editor. The same in both terminal programs.
 */
import { TemplateManager } from '@goodvibes/engine/platform/platform/templates';
import type { TemplateSessionCapabilityServices } from '@goodvibes/engine/platform/platform/capabilities';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';

export interface TemplateSessionContext {
  readonly workspace: { readonly shellPaths?: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'> | null | undefined };
  readonly session: { readonly conversationManager: { getLastUserMessage(): string | null | undefined } };
  readonly submitTurn?: ((text: string) => void) | undefined;
  readonly openFileInEditor?: ((path: string) => Promise<boolean>) | undefined;
  readonly print: (message: string) => void;
}

/** This program's services for the template capabilities that run here; undefined with no working directory. */
export function templateSessionServices(ctx: TemplateSessionContext): TemplateSessionCapabilityServices['templateSession'] {
  const paths = ctx.workspace.shellPaths;
  if (!paths) return undefined;
  return {
    manager: () => new TemplateManager({ projectRoot: paths.workingDirectory, homeDirectory: paths.homeDirectory }),
    submit: (text) => {
      if (!ctx.submitTurn) return false;
      ctx.submitTurn(text);
      return true;
    },
    lastUserMessage: () => ctx.session.conversationManager.getLastUserMessage() ?? '',
    edit: (path, name) => {
      if (!ctx.openFileInEditor) return `No editor can be opened here. The template is the file ${path}; edit it there, or set $VISUAL or $EDITOR.`;
      void ctx.openFileInEditor(path).then((exited) => {
        if (exited) ctx.print(`Edited template ${name} (${path}); using it reads the saved file.`);
      });
      return undefined;
    },
  };
}
