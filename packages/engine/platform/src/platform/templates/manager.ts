import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import { RefusalError, refusal, type Refusal } from '@goodvibes/engine/errors';
import { logger } from '../utils/logger.js';
import { storedNameStem } from '../utils/stored-name.js';

export type TemplateScope = 'project' | 'global';

/** What `save` did: the name the template is stored under, its file and scope, and whether it replaced one of that name. */
export interface TemplateSaveResult {
  readonly name: string;
  readonly path: string;
  readonly scope: TemplateScope;
  readonly replaced: boolean;
}

/**
 * The name a template is stored under (its file is `<name>.md`): lower case,
 * spaces as `-`, letters and digits of any script with `-` and `_` kept,
 * everything else dropped, so "My Plan" and "my-plan" are one template and
 * "会議メモ" and "計画" are two. Empty when nothing of the name can be stored.
 */
export function storedTemplateName(name: string): string {
  return storedNameStem(name);
}

export interface TemplateEntry {
  name: string;
  path: string;
  preview: string;
  scope: TemplateScope;
  /** True for a project template whose name also exists globally: the global copy is hidden here and loads again once this one is deleted. */
  shadowsGlobal: boolean;
}

/** What `delete` did. `stillLoadsFrom: 'global'` means a global template of the same name now answers to it. */
export type TemplateDeleteResult =
  | { readonly ok: true; readonly name: string; readonly scope: TemplateScope; readonly path: string; readonly stillLoadsFrom: 'global' | null }
  | { readonly ok: false; readonly name: string; readonly scope: TemplateScope; readonly refusal: Refusal };

export interface TemplateManagerRoots {
  projectRoot: string;
  homeDirectory: string;
  projectDirectory?: string | undefined;
  globalDirectory?: string | undefined;
}

/**
 * TemplateManager, save, load, list, delete and expand prompt templates.
 *
 * Storage search order:
 * - project templates
 * - global templates
 *
 * Variable syntax:
 * - {{var_name}} named variable
 * - {{1}}, {{2}} positional argument (1-based)
 * - {{template:name}} inline template expansion (max depth 3)
 */
export class TemplateManager {
  private readonly globalDir: string;
  private readonly projectDir: string;

  constructor(roots: TemplateManagerRoots) {
    this.globalDir = roots.globalDirectory ?? join(roots.homeDirectory, '.goodvibes', 'templates');
    this.projectDir = roots.projectDirectory ?? join(roots.projectRoot, '.goodvibes', 'templates');
  }

  /** When the project is the home directory both scopes are one folder; every template there is a project template. */
  private get sharedDirectory(): boolean {
    return resolve(this.projectDir) === resolve(this.globalDir);
  }

  /**
   * Saves the template in one scope (this project by default, or `'global'`
   * for every project) under its stored name ({@link storedTemplateName}) and
   * says whether it replaced a template of that name. Throws a refusal
   * (`TEMPLATE_NAME_UNSTORABLE`) for a name nothing of which can be stored.
   */
  save(name: string, content: string, scope: TemplateScope = 'project'): TemplateSaveResult {
    const safeName = storedTemplateName(name);
    if (safeName === '') {
      throw new RefusalError(refusal({
        code: 'TEMPLATE_NAME_UNSTORABLE',
        state: 'the template was not saved',
        reason: `Template name "${name}" keeps no characters once stored (letters and digits of any script, "-" and "_" are kept), so it was not saved`,
        next: ['Save again under a name with at least one letter or digit'],
      }));
    }
    const dir = scope === 'global' ? this.globalDir : this.projectDir;
    const path = join(dir, `${safeName}.md`);
    const replaced = existsSync(path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, content, 'utf-8');
    return { name: safeName, path, scope: scope === 'global' && this.sharedDirectory ? 'project' : scope, replaced };
  }

  load(name: string): string | null {
    const safeName = storedTemplateName(name);
    if (safeName === '') return null;
    const projectPath = join(this.projectDir, `${safeName}.md`);
    if (existsSync(projectPath)) {
      return readFileSync(projectPath, 'utf-8');
    }
    const globalPath = join(this.globalDir, `${safeName}.md`);
    if (existsSync(globalPath)) {
      return readFileSync(globalPath, 'utf-8');
    }
    return null;
  }

  list(): TemplateEntry[] {
    const projectNames = new Set<string>();
    const entries: TemplateEntry[] = [];
    const scopes: ReadonlyArray<readonly [string, TemplateScope]> = this.sharedDirectory
      ? [[this.projectDir, 'project']]
      : [[this.projectDir, 'project'], [this.globalDir, 'global']];

    for (const [dir, scope] of scopes) {
      if (!existsSync(dir)) continue;
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const name = basename(file, '.md');
        // load(), delete() and use address a template by its stored name, so a file
        // under any other name could be listed but never opened or removed.
        if (storedTemplateName(name) !== name) {
          logger.warn('TemplateManager: ignoring a template file whose name is not a stored template name; rename it to its stored name to use it', { file: join(dir, file), storedName: storedTemplateName(name) });
          continue;
        }
        if (scope === 'global' && projectNames.has(name)) {
          const shadowing = entries.find((entry) => entry.name === name);
          if (shadowing) shadowing.shadowsGlobal = true;
          continue;
        }
        if (scope === 'project') projectNames.add(name);
        const filePath = join(dir, file);
        let preview = '';
        try {
          const content = readFileSync(filePath, 'utf-8');
          preview = content.slice(0, 80).replace(/\n/g, ' ').trim();
        } catch {
          preview = '';
        }
        entries.push({ name, path: filePath, preview, scope, shadowsGlobal: false });
      }
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Deletes the template of that name in one scope, project by default. A global
   * template is shared by every project, so it is removed only when `scope` is
   * `'global'`; asking for the project copy of a global-only name is refused.
   */
  delete(name: string, scope: TemplateScope = 'project'): TemplateDeleteResult {
    const safeName = storedTemplateName(name);
    const projectPath = join(this.projectDir, `${safeName}.md`);
    const globalPath = join(this.globalDir, `${safeName}.md`);
    const shared = this.sharedDirectory;
    const targetPath = scope === 'global' ? globalPath : projectPath;

    if (safeName !== '' && existsSync(targetPath)) {
      rmSync(targetPath);
      const stillLoadsFrom = scope === 'project' && !shared && existsSync(globalPath) ? 'global' : null;
      return { ok: true, name: safeName, scope, path: targetPath, stillLoadsFrom };
    }

    if (safeName !== '' && scope === 'project' && !shared && existsSync(globalPath)) {
      return {
        ok: false,
        name: safeName,
        scope,
        refusal: refusal({
          code: 'TEMPLATE_ONLY_GLOBAL',
          state: `template "${safeName}" is global, not a project template`,
          reason: `"${safeName}" is shared by every project (${globalPath}), so it was not deleted from this project`,
          next: [`Delete it with the global scope to remove it for every project, or remove ${globalPath}`],
        }),
      };
    }

    return {
      ok: false,
      name: safeName,
      scope,
      refusal: refusal({
        code: 'TEMPLATE_NOT_FOUND',
        state: `no ${scope} template named "${safeName || name}"`,
        reason: safeName === '' ? `Template name "${name}" keeps no characters once stored, so no template has it` : `There is no ${targetPath}`,
        next: ['Your templates are listed in Memory and knowledge, Templates'],
      }),
    };
  }

  expand(
    template: string,
    args: Record<string, string>,
    depth = 0,
  ): string {
    if (depth >= 3) return template;

    let result = template;
    result = result.replace(/\{\{template:([^}]+)\}\}/g, (_match, refName: string) => {
      const refContent = this.load(refName.trim());
      if (refContent === null) return `{{template:${refName}}}`;
      return this.expand(refContent, args, depth + 1);
    });

    result = result.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
      const trimmedKey = key.trim();
      // Own keys only: `in` also finds inherited names such as `toString` and `constructor`.
      if (Object.hasOwn(args, trimmedKey)) {
        return args[trimmedKey]!;
      }
      return `{{${trimmedKey}}}`;
    });

    return result;
  }
}

export function parseTemplateArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  let positionalIndex = 1;

  for (const arg of args) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx > 0) {
      const key = arg.slice(0, eqIdx);
      const value = arg.slice(eqIdx + 1);
      result[key] = value;
    } else {
      result[String(positionalIndex)] = arg;
      positionalIndex += 1;
    }
  }

  return result;
}
