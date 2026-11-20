/**
 * method-catalog-skills.ts
 *
 * Contract descriptors for the daemon's skills CRUD gateway verbs
 * (skills.list / skills.get / skills.create / skills.update / skills.delete).
 * These expose the single canonical skill service (../skills, service.ts) over
 * the operator surface so a consumer drives one shared skill store through the
 * daemon instead of each carrying its own on-disk copy.
 *
 * Descriptors live here (static) so `buildOperatorContract` / api.md / the
 * generated contract artifacts see them whether or not a handler has been
 * attached yet; routes/skills.ts attaches the handlers at RuntimeServices
 * construction time. This mirrors the fleet.* descriptor/handler split.
 *
 * Progressive disclosure is expressed in the shapes: skills.list returns the
 * cheap index line (name + description + metadata, NO body), skills.get returns
 * the full record including the Markdown body. Every record says where the skill
 * lives (`origin`, `path`), and a name addresses the one skill listed under it.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  entityOutputSchema,
  listOutputSchema,
  methodDescriptor,
  objectSchema,
  stringEnumSchema,
} from './method-catalog-shared.js';
import { METADATA_SCHEMA } from './operator-contract-schemas-shared.js';

/** Where a skill was found: the project's skill directories, the home ones, or another directory. */
const SKILL_ORIGIN_SCHEMA = stringEnumSchema(['project-local', 'global', 'custom']);

/** The cheap index line of a skill: enough to decide whether to open it, no body. */
export const SKILL_INDEX_ENTRY_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  description: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  origin: SKILL_ORIGIN_SCHEMA,
  path: STRING_SCHEMA,
}, ['name', 'description', 'metadata']);

/** A fully-disclosed skill: its index line plus the Markdown body. */
export const SKILL_RECORD_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  description: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  origin: SKILL_ORIGIN_SCHEMA,
  path: STRING_SCHEMA,
  body: STRING_SCHEMA,
}, ['name', 'description', 'metadata', 'body']);

export const SKILLS_LIST_INPUT_SCHEMA = objectSchema({}, []);
export const SKILLS_LIST_OUTPUT_SCHEMA = listOutputSchema('skills', SKILL_INDEX_ENTRY_SCHEMA);

export const SKILLS_GET_INPUT_SCHEMA = objectSchema({ name: STRING_SCHEMA }, ['name']);
export const SKILLS_GET_OUTPUT_SCHEMA = entityOutputSchema('skill', SKILL_RECORD_SCHEMA);

export const SKILLS_CREATE_INPUT_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  description: STRING_SCHEMA,
  body: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['name', 'description', 'body']);
export const SKILLS_CREATE_OUTPUT_SCHEMA = entityOutputSchema('skill', SKILL_RECORD_SCHEMA);

export const SKILLS_UPDATE_INPUT_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  description: STRING_SCHEMA,
  body: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['name']);
export const SKILLS_UPDATE_OUTPUT_SCHEMA = entityOutputSchema('skill', SKILL_RECORD_SCHEMA);

export const SKILLS_DELETE_INPUT_SCHEMA = objectSchema({ name: STRING_SCHEMA }, ['name']);
export const SKILLS_DELETE_OUTPUT_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  deleted: BOOLEAN_SCHEMA,
  path: STRING_SCHEMA,
}, ['name', 'deleted']);

export const builtinGatewaySkillsMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'skills.list',
    title: 'List Skills',
    description: 'Return the index line (name, description, metadata, origin, path) of every skill a session loads: the project and home skill directories, flat <name>.md files and <folder>/SKILL.md folders, project skills first. A name a project skill uses hides the home skill of that name. Progressive disclosure: bodies are never returned here, call skills.get for the one skill you decide to open.',
    category: 'skills',
    effects: ['skills.read'],
    http: { method: 'GET', path: '/api/skills' },
    inputSchema: SKILLS_LIST_INPUT_SCHEMA,
    outputSchema: SKILLS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'skills.get',
    title: 'Get Skill',
    description: 'Return one skill in full, including its Markdown body, by the name skills.list shows (case does not matter). Returns 404 when no skill with that name exists.',
    category: 'skills',
    effects: ['skill-content.read'],
    http: { method: 'GET', path: '/api/skills/{name}' },
    inputSchema: SKILLS_GET_INPUT_SCHEMA,
    outputSchema: SKILLS_GET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'skills.create',
    repeat: 'safe',
    title: 'Create Skill',
    description: 'Create a new skill as ~/.goodvibes/skills/<name>.md from a name, one-line description, and Markdown body (plus optional frontmatter metadata). Fails with a conflict when any listed skill already has that name, use skills.update to change an existing one.',
    category: 'skills',
    effects: ['skills.write'],
    http: { method: 'POST', path: '/api/skills' },
    inputSchema: SKILLS_CREATE_INPUT_SCHEMA,
    outputSchema: SKILLS_CREATE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'skills.update',
    repeat: 'safe',
    title: 'Update Skill',
    description: 'Update an existing skill\'s description, body, and/or frontmatter metadata in the file skills.list names. Absent fields are left unchanged; a body-only change keeps the frontmatter exactly as written. Changing the description or metadata of a skill whose frontmatter uses YAML beyond one key: value per line is refused (400) so nothing the author wrote is lost. Returns 404 when no skill with that name exists.',
    category: 'skills',
    effects: ['skills.write'],
    http: { method: 'POST', path: '/api/skills/{name}/update' },
    inputSchema: SKILLS_UPDATE_INPUT_SCHEMA,
    outputSchema: SKILLS_UPDATE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'skills.delete',
    repeat: 'safe',
    effects: ['skills.write', 'record.destroy'],
    title: 'Delete Skill',
    description: 'Permanently delete a skill. Delete means delete: a <name>.md document is removed, and a folder skill is removed with its folder, not tombstoned; path names what was removed. Returns { deleted: false } when no skill with that name existed, an honest boolean, never a 200 that pretends a phantom skill was removed.',
    category: 'skills',
    http: { method: 'DELETE', path: '/api/skills/{name}' },
    inputSchema: SKILLS_DELETE_INPUT_SCHEMA,
    outputSchema: SKILLS_DELETE_OUTPUT_SCHEMA,
  }),
];
