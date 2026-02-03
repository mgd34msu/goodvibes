// ============================================================================
// AGENT INDEXER SERVICE
// ============================================================================
//
// Parses and indexes agent markdown files from the agency directory.
// Extracts metadata, content, and relationships for full-text search.
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
  upsertIndexedAgent,
  getAllIndexedAgents,
  clearIndexedAgents,
  getAgentCount,
  getCategoryByPath,
  type IndexedAgent,
  type AgencyCategory,
} from '../database/agencyIndex.js';

const logger = new Logger('AgentIndexer');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Parsed agent metadata from YAML frontmatter
 */
interface AgentFrontmatter {
  name: string;
  description?: string;
  skills?: string[];
  tags?: string[];
}

/**
 * Parsed agent data
 */
interface ParsedAgent {
  frontmatter: AgentFrontmatter;
  content: string;
  filePath: string;
  slug: string;
  categoryPath: string;
}

/**
 * Indexer configuration
 */
interface AgentIndexerConfig {
  agencyPath: string;  // Root path to agency directory
  agentSubpath: string;  // Subpath to agents (e.g., ".claude/agents/webdev")
}

// ============================================================================
// AGENT INDEXER
// ============================================================================

export class AgentIndexer extends EventEmitter {
  private config: AgentIndexerConfig;
  private indexing: boolean = false;
  private lastIndexTime: Date | null = null;

  constructor(config: AgentIndexerConfig) {
    super();
    this.config = config;
  }

  /**
   * Get the full path to the agents directory
   */
  getAgentsPath(): string {
    return path.join(this.config.agencyPath, this.config.agentSubpath);
  }

  /**
   * Check if the agents directory exists
   */
  async validatePath(): Promise<boolean> {
    const agentsPath = this.getAgentsPath();
    try {
      const stats = await fs.promises.stat(agentsPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Perform full index of all agents
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

      const agentsPath = this.getAgentsPath();
      logger.info(`Starting agent indexing from: ${agentsPath}`);

      // Scan for all .md files
      this.emit('progress', { current: 0, total: 0, currentFile: '', phase: 'scanning' });
      const agentFiles = await this.scanAgentFiles(agentsPath);
      logger.info(`Found ${agentFiles.length} agent files`);

      if (agentFiles.length === 0) {
        return { success: true, count: 0, errors: [] };
      }

      // Clear existing agents (full reindex)
      clearIndexedAgents();

      // Parse and index each agent
      const categoryCache = new Map<string, AgencyCategory>();
      let indexed = 0;

      for (let i = 0; i < agentFiles.length; i++) {
        const filePath = agentFiles[i];
        const relativePath = path.relative(agentsPath, filePath);

        this.emit('progress', {
          current: i + 1,
          total: agentFiles.length,
          currentFile: relativePath,
          phase: 'indexing',
        });

        try {
          const parsed = await this.parseAgentFile(filePath, agentsPath);
          if (parsed) {
            // Ensure category exists
            const category = await this.ensureCategory(parsed.categoryPath, categoryCache);

            // Index the agent
            upsertIndexedAgent({
              name: parsed.frontmatter.name,
              slug: parsed.slug,
              description: parsed.frontmatter.description || null,
              content: parsed.content,
              categoryId: category.id,
              categoryPath: parsed.categoryPath,
              filePath: parsed.filePath,
              skills: parsed.frontmatter.skills || [],
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

      logger.info(`Agent indexing complete: ${indexed} agents indexed`);
      return { success: true, count: indexed, errors };
    } catch (err) {
      const error = err as Error;
      logger.error(`Agent indexing failed: ${error.message}`);
      errors.push(`Fatal error: ${error.message}`);
      return { success: false, count: 0, errors };
    } finally {
      this.indexing = false;
    }
  }

  /**
   * Index a single agent file
   */
  async indexSingle(filePath: string): Promise<IndexedAgent | null> {
    try {
      const agentsPath = this.getAgentsPath();
      const parsed = await this.parseAgentFile(filePath, agentsPath);

      if (!parsed) {
        return null;
      }

      // Ensure category exists
      const categoryCache = new Map<string, AgencyCategory>();
      const category = await this.ensureCategory(parsed.categoryPath, categoryCache);

      // Index the agent
      return upsertIndexedAgent({
        name: parsed.frontmatter.name,
        slug: parsed.slug,
        description: parsed.frontmatter.description || null,
        content: parsed.content,
        categoryId: category.id,
        categoryPath: parsed.categoryPath,
        filePath: parsed.filePath,
        skills: parsed.frontmatter.skills || [],
        tags: parsed.frontmatter.tags || this.extractTags(parsed.content),
        lastIndexed: formatTimestamp(),
      });
    } catch (err) {
      const error = err as Error;
      logger.error(`Failed to index single agent ${filePath}: ${error.message}`);
      return null;
    }
  }

  /**
   * Scan directory recursively for agent .md files
   */
  private async scanAgentFiles(dir: string): Promise<string[]> {
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
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // Skip SKILL.md files (those are handled by SkillIndexer)
          if (entry.name !== 'SKILL.md' && entry.name !== 'README.md') {
            files.push(fullPath);
          }
        }
      }
    }

    await scan(dir);
    return files;
  }

  /**
   * Parse an agent markdown file
   */
  private async parseAgentFile(filePath: string, agentsPath: string): Promise<ParsedAgent | null> {
    const content = await fs.promises.readFile(filePath, 'utf-8');

    // Extract frontmatter if present
    const frontmatter = this.parseFrontmatter(content);
    if (!frontmatter.name) {
      // Try to infer name from filename
      frontmatter.name = path.basename(filePath, '.md')
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }

    // Calculate category path from directory structure
    const relativePath = path.relative(agentsPath, filePath);
    const categoryPath = path.dirname(relativePath).replace(/\\/g, '/');

    // Generate slug from filename
    const slug = path.basename(filePath, '.md');

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
  private parseFrontmatter(content: string): AgentFrontmatter {
    const result: AgentFrontmatter = { name: '' };

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
          case 'skills':
            // Handle array format: skills: [skill1, skill2]
            if (value.startsWith('[')) {
              result.skills = value
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
   * Extract tags from content by analyzing headings and code blocks
   */
  private extractTags(content: string): string[] {
    const tags: Set<string> = new Set();

    // Extract from code block languages
    const codeBlockMatches = content.matchAll(/```(\w+)/g);
    for (const match of codeBlockMatches) {
      const lang = match[1].toLowerCase();
      if (lang !== 'bash' && lang !== 'shell' && lang !== 'text') {
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
    const existing = getCategoryByPath(`agent:${categoryPath}`);
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
      const fullPath = `agent:${currentPath}`;

      let category = getCategoryByPath(fullPath);
      if (!category) {
        category = upsertCategory({
          name: part.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
          path: fullPath,
          parentId,
          type: 'agent',
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
    agentCount: number;
  } {
    return {
      indexing: this.indexing,
      lastIndexTime: this.lastIndexTime,
      agentCount: getAgentCount(),
    };
  }

  /**
   * Get all indexed agents
   */
  getAllAgents(): IndexedAgent[] {
    return getAllIndexedAgents();
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let indexerInstance: AgentIndexer | null = null;

/**
 * Get or create the agent indexer instance
 */
export function getAgentIndexer(config?: AgentIndexerConfig): AgentIndexer {
  if (!indexerInstance && config) {
    indexerInstance = new AgentIndexer(config);
  }
  if (!indexerInstance) {
    throw new Error('AgentIndexer not initialized. Provide config on first call.');
  }
  return indexerInstance;
}

/**
 * Initialize the agent indexer with configuration
 */
export function initializeAgentIndexer(config: AgentIndexerConfig): AgentIndexer {
  indexerInstance = new AgentIndexer(config);
  return indexerInstance;
}
