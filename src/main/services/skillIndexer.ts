// ============================================================================
// SKILL INDEXER SERVICE
// ============================================================================
//
// Parses and indexes SKILL.md files from the agency directory.
// Extracts metadata, triggers, and relationships for full-text search.
//
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { formatTimestamp } from '../../shared/dateUtils.js';
import {
  createAgencyIndexTables,
  upsertCategory,
  upsertIndexedSkill,
  getAllIndexedSkills,
  clearIndexedSkills,
  getSkillCount,
  getCategoryByPath,
  type IndexedSkill,
  type AgencyCategory,
} from '../database/agencyIndex.js';

const logger = new Logger('SkillIndexer');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Parsed skill metadata from YAML frontmatter
 */
interface SkillFrontmatter {
  name: string;
  description?: string;
  triggers?: string[];
  tags?: string[];
  agent?: string;  // Related agent slug
}

/**
 * Parsed skill data
 */
interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  content: string;
  filePath: string;
  slug: string;
  categoryPath: string;
}

/**
 * Indexer configuration
 */
interface SkillIndexerConfig {
  agencyPath: string;  // Root path to agency directory
  skillSubpath: string;  // Subpath to skills (e.g., ".claude/skills/webdev")
}

// ============================================================================
// SKILL INDEXER
// ============================================================================

export class SkillIndexer extends EventEmitter {
  private config: SkillIndexerConfig;
  private indexing: boolean = false;
  private lastIndexTime: Date | null = null;

  constructor(config: SkillIndexerConfig) {
    super();
    this.config = config;
  }

  /**
   * Get the full path to the skills directory
   */
  getSkillsPath(): string {
    return path.join(this.config.agencyPath, this.config.skillSubpath);
  }

  /**
   * Check if the skills directory exists
   */
  async validatePath(): Promise<boolean> {
    const skillsPath = this.getSkillsPath();
    try {
      const stats = await fs.promises.stat(skillsPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Perform full index of all skills
   */
  async indexAll(): Promise<{ success: boolean; count: number; errors: string[] }> {
    if (this.indexing) {
      return { success: false, count: 0, errors: ['Indexing already in progress'] };
    }

    this.indexing = true;
    const errors: string[] = [];

    try {
      // Ensure tables exist
      createAgencyIndexTables();

      const skillsPath = this.getSkillsPath();
      logger.info(`Starting skill indexing from: ${skillsPath}`);

      // Scan for all SKILL.md files
      this.emit('progress', { current: 0, total: 0, currentFile: '', phase: 'scanning' });
      const skillFiles = await this.scanSkillFiles(skillsPath);
      logger.info(`Found ${skillFiles.length} skill files`);

      if (skillFiles.length === 0) {
        return { success: true, count: 0, errors: [] };
      }

      // Clear existing skills (full reindex)
      clearIndexedSkills();

      // Parse and index each skill
      const categoryCache = new Map<string, AgencyCategory>();
      let indexed = 0;

      for (let i = 0; i < skillFiles.length; i++) {
        const filePath = skillFiles[i];
        const relativePath = path.relative(skillsPath, filePath);

        this.emit('progress', {
          current: i + 1,
          total: skillFiles.length,
          currentFile: relativePath,
          phase: 'indexing',
        });

        try {
          const parsed = await this.parseSkillFile(filePath, skillsPath);
          if (parsed) {
            // Ensure category exists
            const category = await this.ensureCategory(parsed.categoryPath, categoryCache);

            // Index the skill
            upsertIndexedSkill({
              name: parsed.frontmatter.name,
              slug: parsed.slug,
              description: parsed.frontmatter.description || null,
              content: parsed.content,
              categoryId: category.id,
              categoryPath: parsed.categoryPath,
              filePath: parsed.filePath,
              agentSlug: parsed.frontmatter.agent || this.inferAgentFromPath(parsed.categoryPath),
              triggers: parsed.frontmatter.triggers || this.extractTriggers(parsed.content, parsed.frontmatter),
              tags: parsed.frontmatter.tags || this.extractTags(parsed.content),
              lastIndexed: formatTimestamp(),
            });
            indexed++;
          }
        } catch (err) {
          const error = err as Error;
          errors.push(`Failed to index ${relativePath}: ${error.message}`);
          logger.warn(`Failed to index ${relativePath}: ${error.message}`);
        }
      }

      this.lastIndexTime = new Date();
      this.emit('progress', { current: indexed, total: indexed, currentFile: '', phase: 'complete' });

      logger.info(`Skill indexing complete: ${indexed} skills indexed`);
      return { success: true, count: indexed, errors };
    } catch (err) {
      const error = err as Error;
      logger.error(`Skill indexing failed: ${error.message}`);
      errors.push(`Fatal error: ${error.message}`);
      return { success: false, count: 0, errors };
    } finally {
      this.indexing = false;
    }
  }

  /**
   * Index a single skill file
   */
  async indexSingle(filePath: string): Promise<IndexedSkill | null> {
    try {
      const skillsPath = this.getSkillsPath();
      const parsed = await this.parseSkillFile(filePath, skillsPath);

      if (!parsed) {
        return null;
      }

      // Ensure category exists
      const categoryCache = new Map<string, AgencyCategory>();
      const category = await this.ensureCategory(parsed.categoryPath, categoryCache);

      // Index the skill
      return upsertIndexedSkill({
        name: parsed.frontmatter.name,
        slug: parsed.slug,
        description: parsed.frontmatter.description || null,
        content: parsed.content,
        categoryId: category.id,
        categoryPath: parsed.categoryPath,
        filePath: parsed.filePath,
        agentSlug: parsed.frontmatter.agent || this.inferAgentFromPath(parsed.categoryPath),
        triggers: parsed.frontmatter.triggers || this.extractTriggers(parsed.content, parsed.frontmatter),
        tags: parsed.frontmatter.tags || this.extractTags(parsed.content),
        lastIndexed: formatTimestamp(),
      });
    } catch (err) {
      const error = err as Error;
      logger.error(`Failed to index single skill ${filePath}: ${error.message}`);
      return null;
    }
  }

  /**
   * Scan directory recursively for SKILL.md files
   */
  private async scanSkillFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    async function scan(currentDir: string): Promise<void> {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          // Skip hidden directories
          if (!entry.name.startsWith('.')) {
            await scan(fullPath);
          }
        } else if (entry.isFile() && entry.name === 'SKILL.md') {
          files.push(fullPath);
        }
      }
    }

    await scan(dir);
    return files;
  }

  /**
   * Parse a SKILL.md file
   */
  private async parseSkillFile(filePath: string, skillsPath: string): Promise<ParsedSkill | null> {
    const content = await fs.promises.readFile(filePath, 'utf-8');

    // Extract frontmatter if present
    const frontmatter = this.parseFrontmatter(content);
    if (!frontmatter.name) {
      // Try to infer name from directory name
      const dirName = path.basename(path.dirname(filePath));
      frontmatter.name = dirName
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }

    // Calculate category path from directory structure
    // The SKILL.md file is in a directory named after the skill
    const relativePath = path.relative(skillsPath, path.dirname(filePath));
    const categoryPath = relativePath.replace(/\\/g, '/');

    // Generate slug from directory name
    const slug = path.basename(path.dirname(filePath));

    // Strip frontmatter from content
    const contentWithoutFrontmatter = this.stripFrontmatter(content);

    return {
      frontmatter,
      content: contentWithoutFrontmatter,
      filePath,
      slug,
      categoryPath,
    };
  }

  /**
   * Parse YAML frontmatter from markdown content
   */
  private parseFrontmatter(content: string): SkillFrontmatter {
    const result: SkillFrontmatter = { name: '' };

    // Check for YAML frontmatter
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      // Try to extract name from first heading
      const headingMatch = content.match(/^#\s+(.+)$/m);
      if (headingMatch) {
        result.name = headingMatch[1].trim();
      }
      return result;
    }

    const yamlContent = frontmatterMatch[1];

    // Parse YAML manually (avoiding external dependency)
    const lines = yamlContent.split('\n');
    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.*)$/);
      if (match) {
        const [, key, value] = match;

        switch (key.toLowerCase()) {
          case 'name':
            result.name = value.trim();
            break;
          case 'description':
            result.description = value.trim();
            break;
          case 'agent':
            result.agent = value.trim();
            break;
          case 'triggers':
            if (value.startsWith('[')) {
              result.triggers = value
                .slice(1, -1)
                .split(',')
                .map(s => s.trim().replace(/['"]/g, ''))
                .filter(s => s.length > 0);
            }
            break;
          case 'tags':
            if (value.startsWith('[')) {
              result.tags = value
                .slice(1, -1)
                .split(',')
                .map(s => s.trim().replace(/['"]/g, ''))
                .filter(s => s.length > 0);
            }
            break;
        }
      }
    }

    return result;
  }

  /**
   * Strip YAML frontmatter from content
   */
  private stripFrontmatter(content: string): string {
    return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
  }

  /**
   * Extract trigger keywords from content and frontmatter
   */
  private extractTriggers(content: string, frontmatter: SkillFrontmatter): string[] {
    const triggers: Set<string> = new Set();

    // Add from description if it mentions triggers
    const description = frontmatter.description || '';
    const triggerMatch = description.match(/triggers?\s+on\s+(.+?)(?:\.|$)/i);
    if (triggerMatch) {
      const triggerText = triggerMatch[1];
      // Split by common delimiters
      triggerText.split(/,\s*|\s+or\s+|\s+and\s+/).forEach(t => {
        const cleaned = t.trim().toLowerCase();
        if (cleaned.length > 2) {
          triggers.add(cleaned);
        }
      });
    }

    // Extract from "When to Use" or similar sections
    const whenToUseMatch = content.match(/##\s*When to Use\s*\n([\s\S]*?)(?=\n##|\n$)/i);
    if (whenToUseMatch) {
      const section = whenToUseMatch[1];
      // Extract bullet points
      const bullets = section.match(/^[-*]\s+(.+)$/gm);
      if (bullets) {
        bullets.forEach(bullet => {
          const text = bullet.replace(/^[-*]\s+/, '').toLowerCase();
          // Extract key phrases
          const keywords = text.match(/\b(?:when|for|if|need|want|implementing|building|creating)\s+(.+?)(?:\.|$)/i);
          if (keywords && keywords[1]) {
            triggers.add(keywords[1].trim());
          }
        });
      }
    }

    // Add the skill name itself as a trigger
    if (frontmatter.name) {
      triggers.add(frontmatter.name.toLowerCase());
    }

    return Array.from(triggers).slice(0, 10); // Limit to 10 triggers
  }

  /**
   * Extract tags from content by analyzing headings and code blocks
   */
  private extractTags(content: string): string[] {
    const tags: Set<string> = new Set();

    // Extract from code block languages
    const codeBlockMatches = content.matchAll(/```(\w+)/g);
    for (const match of codeBlockMatches) {
      const lang = match[1].toLowerCase();
      if (lang !== 'bash' && lang !== 'shell' && lang !== 'text' && lang !== 'markdown') {
        tags.add(lang);
      }
    }

    // Extract technology names from common patterns
    const techPatterns = [
      /\b(React|Vue|Angular|Svelte|Next\.?js|Nuxt|Remix)\b/gi,
      /\b(TypeScript|JavaScript|Python|Go|Rust|Ruby|Java|C#)\b/gi,
      /\b(Node\.?js|Deno|Bun)\b/gi,
      /\b(PostgreSQL|MySQL|MongoDB|Redis|SQLite)\b/gi,
      /\b(Docker|Kubernetes|AWS|GCP|Azure)\b/gi,
      /\b(GraphQL|REST|gRPC|WebSocket)\b/gi,
      /\b(Tailwind|SCSS|CSS|Styled-Components)\b/gi,
      /\b(Prisma|Drizzle|TypeORM|Sequelize)\b/gi,
      /\b(Clerk|Auth0|NextAuth|Firebase)\b/gi,
      /\b(Vercel|Netlify|Railway|Render)\b/gi,
      /\b(OpenAI|Anthropic|Claude|GPT)\b/gi,
    ];

    for (const pattern of techPatterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        tags.add(match[1].toLowerCase());
      }
    }

    return Array.from(tags);
  }

  /**
   * Infer agent slug from category path
   * e.g., "ai-ml/implementing-anthropic-patterns" -> "anthropic-api"
   */
  private inferAgentFromPath(categoryPath: string): string | null {
    // The parent directory might indicate the agent
    const parts = categoryPath.split('/');
    if (parts.length >= 1) {
      // First part is usually the category (e.g., "ai-ml", "backend")
      // This could be used to suggest a related agent
      return parts[0];
    }
    return null;
  }

  /**
   * Ensure a category exists in the database
   */
  private async ensureCategory(
    categoryPath: string,
    cache: Map<string, AgencyCategory>
  ): Promise<AgencyCategory> {
    // Check cache first
    const cached = cache.get(categoryPath);
    if (cached) {
      return cached;
    }

    // Check database
    const existing = getCategoryByPath(`skill:${categoryPath}`);
    if (existing) {
      cache.set(categoryPath, existing);
      return existing;
    }

    // Create category and parent categories
    const parts = categoryPath.split('/').filter(p => p.length > 0);
    let parentId: number | null = null;
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const fullPath = `skill:${currentPath}`;

      let category = getCategoryByPath(fullPath);
      if (!category) {
        category = upsertCategory({
          name: part.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
          path: fullPath,
          parentId,
          type: 'skill',
          itemCount: 0,
        });
      }

      parentId = category.id;
      cache.set(currentPath, category);
    }

    const result = cache.get(categoryPath);
    if (!result) {
      throw new Error(`Failed to create category for path: ${categoryPath}`);
    }
    return result;
  }

  /**
   * Get indexing status
   */
  getStatus(): {
    indexing: boolean;
    lastIndexTime: Date | null;
    skillCount: number;
  } {
    return {
      indexing: this.indexing,
      lastIndexTime: this.lastIndexTime,
      skillCount: getSkillCount(),
    };
  }

  /**
   * Get all indexed skills
   */
  getAllSkills(): IndexedSkill[] {
    return getAllIndexedSkills();
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let indexerInstance: SkillIndexer | null = null;

/**
 * Get or create the skill indexer instance
 */
export function getSkillIndexer(config?: SkillIndexerConfig): SkillIndexer {
  if (!indexerInstance && config) {
    indexerInstance = new SkillIndexer(config);
  }
  if (!indexerInstance) {
    throw new Error('SkillIndexer not initialized. Provide config on first call.');
  }
  return indexerInstance;
}

/**
 * Initialize the skill indexer with configuration
 */
export function initializeSkillIndexer(config: SkillIndexerConfig): SkillIndexer {
  indexerInstance = new SkillIndexer(config);
  return indexerInstance;
}
