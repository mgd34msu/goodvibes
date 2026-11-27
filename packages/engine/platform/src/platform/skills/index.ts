/**
 * platform/skills, the one owner of skills: where they live, how they are read, and how
 * they are changed. The daemon's skills.* verbs, the terminal apps' discovery and the TUI
 * Skills modal all read through here, so each sees the same skills under the same names.
 *
 * - `roots.ts`    , the skill directories for a product surface, in search order.
 * - `discovery.ts`, reads those directories in both formats (`<name>.md` and
 *                   `<folder>/SKILL.md`): index lines from the frontmatter alone, or
 *                   whole skills with their bodies.
 * - `model.ts`    , the Markdown + frontmatter skill document: index-line parse,
 *                   full parse, serialization, and the rules for rewriting it.
 * - `store.ts`    , the injectable storage seam, the filesystem store over the skill
 *                   roots, and an in-memory store.
 * - `service.ts`  , the transport-neutral service that owns validation and honest
 *                   absence; the daemon skills.* gateway verbs adapt over it.
 */

export {
  frontmatterIsComplete,
  frontmatterRewriteProblem,
  isValidSkillName,
  parseSkill,
  parseSkillIndex,
  replaceSkillBody,
  serializeSkill,
  toSkillIndexEntry,
  SKILL_NAME_PATTERN,
  type Skill,
  type SkillFrontmatter,
  type SkillFrontmatterValue,
  type SkillIndexEntry,
} from './model.js';
export {
  compareSkillsByOrigin,
  resolveSkillRoots,
  type SkillOrigin,
  type SkillRoot,
  type SkillRootPaths,
} from './roots.js';
export {
  findSkill,
  listSkillIndex,
  listSkills,
  readLocatedSkill,
  SKILL_FOLDER_DOCUMENT,
  type LocatedSkill,
  type LocatedSkillIndex,
  type SkillDocumentSource,
  type SkillFormat,
} from './discovery.js';
export {
  FileSystemSkillStore,
  InMemorySkillStore,
  SkillAlreadyExistsError,
  SkillNotRewritableError,
  type FileSystemSkillStoreOptions,
  type SkillStore,
} from './store.js';
export {
  SkillLibrary,
  SKILL_LIBRARY_FILE,
  agentSkillStorePath,
  buildAgentSkillRequirements,
  copiedFromProvenance,
  wasCopiedIn,
  evaluateAgentSkillBundleReadiness,
  evaluateAgentSkillReadiness,
  formatAgentSkillRequirement,
  normalizeAgentSkillRequirements,
  parseSkillStandardMarkdown,
  renderSkillStandardMarkdown,
  skillLibraryPath,
  skillMayLoad,
  locatedSkillMayLoad,
  skillStandardFilePath,
  type SkillLibraryOptions,
  type SkillLibraryWriteEffects,
  type SkillStandardParsed,
} from './library.js';
export type * from './library-types.js';
export {
  SkillService,
  SkillServiceError,
  type CreateSkillInput,
  type DeleteSkillResult,
  type SkillErrorCode,
  type UpdateSkillInput,
} from './service.js';
