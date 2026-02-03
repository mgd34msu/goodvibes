// ============================================================================
// DATABASE - Tag Filter SQL Builder
// ============================================================================
//
// Converts TagFilterExpression trees to SQL WHERE clauses for filtering
// sessions by tags. Supports nested AND/OR/NOT logic with proper SQL
// optimization using UNION/INTERSECT/EXCEPT operations.
//
// ============================================================================

import Database from 'better-sqlite3';
import type { TagFilterExpression } from '../../shared/types/index.js';
import { Logger } from '../services/logger.js';
import { getTag } from './tags.js';

const logger = new Logger('Database:TagFilters');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Result of building a tag filter query
 */
export interface FilterResult {
  /** SQL WHERE clause (e.g., "WHERE s.id IN (...)" or "WHERE 1=1") */
  whereClause: string;
  /** Parameters for the WHERE clause in order */
  params: (string | number)[];
}

/**
 * Validation result for tag IDs in a filter expression
 */
export interface ValidationResult {
  /** Whether all tag IDs exist in the database */
  valid: boolean;
  /** List of tag IDs that don't exist */
  missingIds: number[];
}

// ============================================================================
// MAIN QUERY BUILDER
// ============================================================================

/**
 * Converts a TagFilterExpression into a SQL WHERE clause with parameters.
 * Returns a FilterResult containing the clause and parameter array.
 *
 * The generated SQL uses subqueries with UNION/INTERSECT/EXCEPT for
 * efficient filtering without multiple JOINs.
 *
 * @param expression - Filter expression tree to convert
 * @returns FilterResult with whereClause and params array
 *
 * @example
 * // Single tag: #feature (tagId=1)
 * buildTagFilterQuery({ type: 'tag', tagId: 1 })
 * // => { whereClause: "WHERE s.id IN (SELECT session_id FROM session_tags WHERE tag_id = ?)", params: [1] }
 *
 * @example
 * // AND expression: #feature AND #bugfix
 * buildTagFilterQuery({
 *   type: 'and',
 *   children: [
 *     { type: 'tag', tagId: 1 },
 *     { type: 'tag', tagId: 2 }
 *   ]
 * })
 * // => Uses INTERSECT for efficient AND logic
 */
export function buildTagFilterQuery(expression: TagFilterExpression): FilterResult {
  const params: (string | number)[] = [];
  const subquery = buildSubquery(expression, params);
  
  // If we got an empty subquery, return a WHERE clause that matches all
  if (!subquery) {
    return {
      whereClause: 'WHERE 1=1',
      params: []
    };
  }
  
  return {
    whereClause: `WHERE s.id IN (${subquery})`,
    params
  };
}

// ============================================================================
// SUBQUERY BUILDER (RECURSIVE)
// ============================================================================

/**
 * Recursively builds SQL subquery for a filter expression.
 * Accumulates parameters in the params array.
 *
 * @param expression - Current node in the filter tree
 * @param params - Accumulated parameters array (mutated)
 * @returns SQL subquery string or null if expression is invalid
 */
function buildSubquery(
  expression: TagFilterExpression,
  params: (string | number)[]
): string | null {
  switch (expression.type) {
    case 'tag':
      return buildTagSubquery(expression, params);
    
    case 'or':
      return buildOrSubquery(expression, params);
    
    case 'and':
      return buildAndSubquery(expression, params);
    
    case 'not':
      return buildNotSubquery(expression, params);
    
    default:
      logger.warn('Unknown expression type', { type: expression.type });
      return null;
  }
}

/**
 * Build subquery for a single tag match.
 * Returns all session IDs that have this tag.
 */
function buildTagSubquery(
  expression: TagFilterExpression,
  params: (string | number)[]
): string | null {
  if (expression.tagId === undefined) {
    logger.warn('Tag expression missing tagId');
    return null;
  }
  
  params.push(expression.tagId);
  return 'SELECT session_id FROM session_tags WHERE tag_id = ?';
}

/**
 * Build subquery for OR expression.
 * Uses UNION to combine results from all children.
 */
function buildOrSubquery(
  expression: TagFilterExpression,
  params: (string | number)[]
): string | null {
  const children = expression.children || [];
  
  if (children.length === 0) {
    logger.warn('OR expression has no children');
    return null;
  }
  
  const subqueries = children
    .map(child => buildSubquery(child, params))
    .filter((sq): sq is string => sq !== null);
  
  if (subqueries.length === 0) {
    return null;
  }
  
  if (subqueries.length === 1) {
    return subqueries[0];
  }
  
  // Use UNION to combine results (automatically deduplicates)
  return subqueries.join(' UNION ');
}

/**
 * Build subquery for AND expression.
 * Uses INTERSECT to find sessions that match ALL children.
 */
function buildAndSubquery(
  expression: TagFilterExpression,
  params: (string | number)[]
): string | null {
  const children = expression.children || [];
  
  if (children.length === 0) {
    logger.warn('AND expression has no children');
    return null;
  }
  
  const subqueries = children
    .map(child => buildSubquery(child, params))
    .filter((sq): sq is string => sq !== null);
  
  if (subqueries.length === 0) {
    return null;
  }
  
  if (subqueries.length === 1) {
    return subqueries[0];
  }
  
  // Use INTERSECT to find sessions in all subqueries
  return subqueries.join(' INTERSECT ');
}

/**
 * Build subquery for NOT expression.
 * Returns all sessions EXCEPT those matching the child expression.
 */
function buildNotSubquery(
  expression: TagFilterExpression,
  params: (string | number)[]
): string | null {
  const children = expression.children || [];
  
  if (children.length === 0) {
    logger.warn('NOT expression has no children');
    return null;
  }
  
  // NOT should only have one child, but we'll handle the first one
  const childSubquery = buildSubquery(children[0], params);
  
  if (!childSubquery) {
    return null;
  }
  
  // Select all sessions, then exclude those matching the child
  return `SELECT id FROM sessions EXCEPT ${childSubquery}`;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get session IDs that match a filter expression.
 * Executes the query and returns the list of session IDs.
 *
 * @param db - Database instance
 * @param expression - Filter expression to evaluate
 * @returns Array of session IDs matching the filter
 *
 * @example
 * const sessionIds = getFilteredSessionIds(db, {
 *   type: 'and',
 *   children: [
 *     { type: 'tag', tagId: 1 },
 *     { type: 'not', children: [{ type: 'tag', tagId: 3 }] }
 *   ]
 * });
 */
export function getFilteredSessionIds(
  db: Database.Database,
  expression: TagFilterExpression
): string[] {
  const { whereClause, params } = buildTagFilterQuery(expression);
  
  // Build full query selecting from sessions table
  const query = `SELECT s.id FROM sessions s ${whereClause}`;
  
  try {
    const rows = db.prepare(query).all(...params) as Array<{ id: string }>;
    return rows.map(row => row.id);
  } catch (error) {
    logger.error('Failed to execute filter query', error, { query, params });
    throw error;
  }
}

/**
 * Validate that all tag IDs in a filter expression exist in the database.
 * Recursively traverses the expression tree to collect all tag IDs.
 *
 * @param expression - Filter expression to validate
 * @returns Validation result with valid flag and list of missing IDs
 *
 * @example
 * const result = validateTagIds({
 *   type: 'and',
 *   children: [
 *     { type: 'tag', tagId: 1 },
 *     { type: 'tag', tagId: 999 } // doesn't exist
 *   ]
 * });
 * // => { valid: false, missingIds: [999] }
 */
export function validateTagIds(
  expression: TagFilterExpression
): ValidationResult {
  const tagIds = collectTagIds(expression);
  const missingIds: number[] = [];
  
  // Convert Set to Array to avoid downlevelIteration requirement
  const tagIdArray = Array.from(tagIds);
  
  for (const tagId of tagIdArray) {
    const tag = getTag(tagId);
    if (!tag) {
      missingIds.push(tagId);
    }
  }
  
  return {
    valid: missingIds.length === 0,
    missingIds
  };
}

/**
 * Recursively collect all tag IDs from a filter expression.
 *
 * @param expression - Expression to traverse
 * @returns Set of unique tag IDs found in the expression
 */
function collectTagIds(expression: TagFilterExpression): Set<number> {
  const tagIds = new Set<number>();
  
  if (expression.type === 'tag' && expression.tagId !== undefined) {
    tagIds.add(expression.tagId);
  }
  
  if (expression.children) {
    for (const child of expression.children) {
      const childIds = collectTagIds(child);
      childIds.forEach(id => tagIds.add(id));
    }
  }
  
  return tagIds;
}
