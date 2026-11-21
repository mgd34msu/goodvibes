import { MODAL_TONES } from './modal-theme.ts';
import { infoRow, headerRow } from './modal-surface-helpers.ts';
import type { ConfigModalActionContext, ConfigModalRow, ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import { discoverSkills, type SkillOrigin, type SkillRecord } from '../skills-discovery.ts';
import type { EcosystemCatalogPathOptions, ShellPathService } from '@/runtime/index.ts';

// ---------------------------------------------------------------------------
// Skills → config-modal surface. Browse-only: lists the skills a session loads,
// read through the same discovery `/skills` uses (platform/skills underneath, so
// the daemon's skills.list sees the same skills). The directories are read when
// the modal opens and on refresh, never in buildView. Each row folds the skill's
// origin, description, dependency and include counts and marketplace provenance
// into its label.
// ---------------------------------------------------------------------------

export interface SkillsModalDeps {
  readonly shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;
  readonly ecosystemPaths?: EcosystemCatalogPathOptions;
  /** Reads the skills; defaults to the TUI's skill discovery. */
  readonly discover?: (
    shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>,
    ecosystemPaths?: EcosystemCatalogPathOptions,
  ) => Promise<SkillRecord[]>;
}

/** The Skills surface plus a way to wait for the read the last open or refresh started. */
export interface SkillsModalReadSurface extends ConfigModalSurface {
  whenLoaded(): Promise<void>;
}

function originLabel(origin: SkillOrigin): string {
  switch (origin) {
    case 'project-local':
      return 'project';
    case 'global':
      return 'global';
    case 'custom':
      return 'custom';
  }
}

class SkillsModalSurface implements SkillsModalReadSurface {
  readonly name = 'skills-modal';
  readonly title = 'Skills';
  /** Null until the first read finishes. */
  private cached: SkillRecord[] | null = null;
  private loadError: string | null = null;
  private generation = 0;
  private pendingLoad: Promise<void> = Promise.resolve();
  private requestRender: () => void = () => {};

  constructor(private readonly deps: SkillsModalDeps) {}

  readonly actions = [{ key: 'r', id: 'refresh', label: 'refresh' }];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    this.refresh();
  }

  onClose(): void {
    this.requestRender = () => {};
  }

  whenLoaded(): Promise<void> {
    return this.pendingLoad;
  }

  private refresh(): void {
    const generation = ++this.generation;
    const discover = this.deps.discover ?? discoverSkills;
    this.pendingLoad = discover(this.deps.shellPaths, this.deps.ecosystemPaths).then(
      (records) => {
        if (generation !== this.generation) return;
        this.cached = records;
        this.loadError = null;
        this.requestRender();
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        this.loadError = error instanceof Error ? error.message : String(error);
        this.requestRender();
      },
    );
  }

  buildView(): ConfigModalView {
    const rows: ConfigModalRow[] = [];
    if (this.loadError !== null) {
      rows.push(infoRow('error:0', `Could not read the skill directories: ${this.loadError}`, { fg: MODAL_TONES.warn }));
      rows.push(infoRow('error:next', 'Press Ctrl+R to read them again.', { fg: MODAL_TONES.dim }));
      return { title: 'Skills', tabs: [{ id: 'skills', label: 'Skills', rows, emptyText: '' }] };
    }
    if (this.cached === null) {
      return { title: 'Skills', tabs: [{ id: 'skills', label: 'Skills', rows, emptyText: 'Reading skill directories…' }] };
    }
    if (this.cached.length === 0) {
      rows.push(infoRow('empty:0', 'No skills discovered.'));
      rows.push(headerRow('empty:title', 'Next steps'));
      rows.push(
        infoRow('empty:dir', '.goodvibes/skills       — place skill .md files here (project-local) or ~/.goodvibes/skills (global)', {
          fg: MODAL_TONES.dim,
        }),
      );
      rows.push(
        infoRow('empty:registry', '/skills origins         — see which skill directories are read and where each skill comes from', { fg: MODAL_TONES.dim }),
      );
      return { title: 'Skills', tabs: [{ id: 'skills', label: 'Skills', rows, emptyText: '' }] };
    }

    const projectCount = this.cached.filter((s) => s.origin === 'project-local').length;
    const globalCount = this.cached.filter((s) => s.origin === 'global').length;
    const header = [`skills ${this.cached.length}  project ${projectCount}  global ${globalCount}`];

    for (const skill of this.cached) {
      const badge = skill.marketplaceProvenance ? '★' : ' ';
      const dot = skill.origin === 'project-local' ? '◆' : '•';
      const detail = [
        `[${originLabel(skill.origin)}]`,
        skill.description || 'No description provided.',
        skill.dependencies.length > 0 ? `deps ${skill.dependencies.length}` : null,
        skill.includes.length > 0 ? `inc ${skill.includes.length}` : null,
        skill.marketplaceProvenance ?? null,
      ]
        .filter((s): s is string => s !== null)
        .join(' · ');
      rows.push({
        id: skill.path,
        label: `${dot} ${badge} ${skill.name.padEnd(24)} ${detail}`,
        ...(skill.marketplaceProvenance ? { style: { fg: MODAL_TONES.info } } : {}),
      });
    }

    return { title: 'Skills', tabs: [{ id: 'skills', label: 'Skills', header, rows }] };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') {
      this.refresh();
      ctx.setStatus('Reading skill directories…');
    }
  }
}

export function createSkillsModalSurface(deps: SkillsModalDeps): SkillsModalReadSurface {
  return new SkillsModalSurface(deps);
}
