// ============================================================================
// TAG FILTER PARSER - Parse filter expressions for advanced tag queries
// ============================================================================

import type { TagFilterExpression } from '../../shared/types/tag-types';
import type { Tag } from '../../shared/types/tag-types';

// ============================================================================
// Token Types
// ============================================================================

enum TokenType {
  TAG = 'TAG',
  AND = 'AND',
  OR = 'OR',
  NOT = 'NOT',
  LPAREN = 'LPAREN',
  RPAREN = 'RPAREN',
  EOF = 'EOF',
}

interface Token {
  type: TokenType;
  value: string;
  position: number;
}

// ============================================================================
// Error Types
// ============================================================================

export class ParseError extends Error {
  constructor(
    message: string,
    public position: number,
    public token?: Token
  ) {
    super(`Parse error at position ${position}: ${message}`);
    this.name = 'ParseError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(`Validation error: ${message}`);
    this.name = 'ValidationError';
  }
}

// ============================================================================
// Validation Result
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ============================================================================
// Tokenizer
// ============================================================================

/**
 * Tokenizes a filter expression string into an array of tokens.
 * Recognizes tags (#name or #123), operators (AND, OR, NOT), and parentheses.
 *
 * @param input - The filter expression string to tokenize
 * @returns Array of tokens
 * @throws {ParseError} If invalid syntax is encountered
 *
 * @example
 * ```typescript
 * const tokens = tokenize("#feature AND #bugfix");
 * // Returns: [
 * //   { type: TokenType.TAG, value: "feature", position: 0 },
 * //   { type: TokenType.AND, value: "AND", position: 9 },
 * //   { type: TokenType.TAG, value: "bugfix", position: 13 }
 * // ]
 * ```
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let position = 0;

  while (position < input.length) {
    const char = input[position];

    // Skip whitespace
    if (/\s/.test(char)) {
      position++;
      continue;
    }

    // Tag (starts with #)
    if (char === '#') {
      const start = position;
      position++; // Skip #

      // Collect tag name or ID
      let value = '';
      while (position < input.length && /[a-zA-Z0-9_-]/.test(input[position])) {
        value += input[position];
        position++;
      }

      if (value.length === 0) {
        throw new ParseError('Empty tag name after #', start);
      }

      tokens.push({ type: TokenType.TAG, value, position: start });
      continue;
    }

    // Left parenthesis
    if (char === '(') {
      tokens.push({ type: TokenType.LPAREN, value: '(', position });
      position++;
      continue;
    }

    // Right parenthesis
    if (char === ')') {
      tokens.push({ type: TokenType.RPAREN, value: ')', position });
      position++;
      continue;
    }

    // Keywords (AND, OR, NOT)
    if (/[a-zA-Z]/.test(char)) {
      const start = position;
      let value = '';
      while (position < input.length && /[a-zA-Z]/.test(input[position])) {
        value += input[position];
        position++;
      }

      const upperValue = value.toUpperCase();

      if (upperValue === 'AND') {
        tokens.push({ type: TokenType.AND, value: upperValue, position: start });
      } else if (upperValue === 'OR') {
        tokens.push({ type: TokenType.OR, value: upperValue, position: start });
      } else if (upperValue === 'NOT') {
        tokens.push({ type: TokenType.NOT, value: upperValue, position: start });
      } else {
        throw new ParseError(
          `Unknown keyword '${value}'. Expected AND, OR, or NOT`,
          start
        );
      }
      continue;
    }

    // Unknown character
    throw new ParseError(`Unexpected character '${char}'`, position);
  }

  tokens.push({ type: TokenType.EOF, value: '', position });
  return tokens;
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Parser class implementing recursive descent parsing for tag filter expressions.
 * Supports operator precedence: NOT > AND > OR
 */
class Parser {
  private tokens: Token[];
  private current = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  /**
   * Main entry point for parsing.
   * Grammar: expression = orExpression
   */
  parse(): TagFilterExpression {
    const expr = this.parseOrExpression();
    if (this.peek().type !== TokenType.EOF) {
      throw new ParseError(
        `Unexpected token '${this.peek().value}' after expression`,
        this.peek().position,
        this.peek()
      );
    }
    return expr;
  }

  /**
   * Parse OR expressions (lowest precedence).
   * Grammar: orExpression = andExpression ('OR' andExpression)*
   */
  private parseOrExpression(): TagFilterExpression {
    let left = this.parseAndExpression();

    while (this.match(TokenType.OR)) {
      const right = this.parseAndExpression();

      // Flatten consecutive ORs
      if (left.type === 'or' && left.children) {
        left.children.push(right);
      } else {
        left = {
          type: 'or',
          children: [left, right],
        };
      }
    }

    return left;
  }

  /**
   * Parse AND expressions (medium precedence).
   * Grammar: andExpression = notExpression ('AND' notExpression)*
   */
  private parseAndExpression(): TagFilterExpression {
    let left = this.parseNotExpression();

    while (this.match(TokenType.AND)) {
      const right = this.parseNotExpression();

      // Flatten consecutive ANDs
      if (left.type === 'and' && left.children) {
        left.children.push(right);
      } else {
        left = {
          type: 'and',
          children: [left, right],
        };
      }
    }

    return left;
  }

  /**
   * Parse NOT expressions (highest precedence).
   * Grammar: notExpression = 'NOT' notExpression | primary
   */
  private parseNotExpression(): TagFilterExpression {
    if (this.match(TokenType.NOT)) {
      const expr = this.parseNotExpression();
      return {
        type: 'not',
        children: [expr],
      };
    }

    return this.parsePrimary();
  }

  /**
   * Parse primary expressions (tags and parenthesized expressions).
   * Grammar: primary = TAG | '(' expression ')'
   */
  private parsePrimary(): TagFilterExpression {
    // Parenthesized expression
    if (this.match(TokenType.LPAREN)) {
      const expr = this.parseOrExpression();
      if (!this.match(TokenType.RPAREN)) {
        throw new ParseError(
          'Expected closing parenthesis',
          this.peek().position,
          this.peek()
        );
      }
      return expr;
    }

    // Tag
    if (this.peek().type === TokenType.TAG) {
      const token = this.advance();
      const value = token.value;
      
      // Check if it's a numeric ID
      const numericId = parseInt(value, 10);
      if (!isNaN(numericId) && String(numericId) === value) {
        // Direct numeric ID reference
        return {
          type: 'tag',
          tagId: numericId,
          children: undefined,
        };
      }
      
      // It's a tag name - store temporarily for later resolution
      // Use a custom property that resolveTagNames will handle
      return {
        type: 'tag',
        tagId: undefined, // Will be filled in by resolveTagNames
        children: undefined,
        _rawTagName: value, // Temporary field for resolution
      } as TagFilterExpression & { _rawTagName?: string };
    }

    throw new ParseError(
      `Expected tag or opening parenthesis, got '${this.peek().value}'`,
      this.peek().position,
      this.peek()
    );
  }

  /**
   * Check if current token matches the given type and advance if it does.
   */
  private match(type: TokenType): boolean {
    if (this.peek().type === type) {
      this.advance();
      return true;
    }
    return false;
  }

  /**
   * Get current token without advancing.
   */
  private peek(): Token {
    return this.tokens[this.current];
  }

  /**
   * Get current token and advance to next.
   */
  private advance(): Token {
    const token = this.tokens[this.current];
    if (this.current < this.tokens.length - 1) {
      this.current++;
    }
    return token;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Parse a filter expression string into a TagFilterExpression tree.
 * This is the main entry point for the parser.
 *
 * @param input - The filter expression string (e.g., "(#feature OR #bugfix) AND NOT #wip")
 * @returns The parsed TagFilterExpression tree
 * @throws {ParseError} If the input has syntax errors
 *
 * @example
 * ```typescript
 * const expr = parseFilter("#feature AND NOT #wip");
 * // Returns:
 * // {
 * //   type: 'and',
 * //   children: [
 * //     { type: 'tag', tagId: undefined },
 * //     { type: 'not', children: [{ type: 'tag', tagId: undefined }] }
 * //   ]
 * // }
 * ```
 */
export function parseFilter(input: string): TagFilterExpression {
  if (!input || input.trim().length === 0) {
    throw new ParseError('Empty filter expression', 0);
  }

  const tokens = tokenize(input);
  const parser = new Parser(tokens);
  return parser.parse();
}

/**
 * Parse filter expression tokens into a TagFilterExpression tree.
 * Lower-level API that works with pre-tokenized input.
 *
 * @param tokens - Array of tokens from tokenize()
 * @returns The parsed TagFilterExpression tree
 * @throws {ParseError} If the tokens form an invalid expression
 */
export function parseFilterExpression(tokens: Token[]): TagFilterExpression {
  const parser = new Parser(tokens);
  return parser.parse();
}

/**
 * Validate a TagFilterExpression tree for structural correctness.
 *
 * @param expr - The expression tree to validate
 * @returns ValidationResult with valid flag and any error messages
 *
 * @example
 * ```typescript
 * const result = validateExpression(expr);
 * if (!result.valid) {
 *   console.error('Validation errors:', result.errors);
 * }
 * ```
 */
export function validateExpression(expr: TagFilterExpression): ValidationResult {
  const errors: string[] = [];

  function validate(node: TagFilterExpression, path: string): void {
    // Check type validity
    if (!['tag', 'and', 'or', 'not'].includes(node.type)) {
      errors.push(`${path}: Invalid node type '${node.type}'`);
      return;
    }

    // Validate tag nodes
    if (node.type === 'tag') {
      if (node.children !== undefined && node.children.length > 0) {
        errors.push(`${path}: Tag nodes should not have children`);
      }
      // Note: tagId being undefined is OK before resolveTagNames is called
      return;
    }

    // Validate operator nodes
    if (!node.children || node.children.length === 0) {
      errors.push(`${path}: ${node.type.toUpperCase()} node must have children`);
      return;
    }

    // Validate NOT nodes (must have exactly 1 child)
    if (node.type === 'not' && node.children.length !== 1) {
      errors.push(
        `${path}: NOT node must have exactly 1 child, has ${node.children.length}`
      );
    }

    // Validate AND/OR nodes (must have at least 2 children)
    if ((node.type === 'and' || node.type === 'or') && node.children.length < 2) {
      errors.push(
        `${path}: ${node.type.toUpperCase()} node must have at least 2 children, has ${
          node.children.length
        }`
      );
    }

    // Recursively validate children
    if (node.children) {
      node.children.forEach((child, index) => {
        validate(child, `${path}[${index}]`);
      });
    }
  }

  validate(expr, 'root');

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Resolve tag names to tag IDs in an expression tree.
 * Modifies the tree in place, replacing tag name references with numeric IDs.
 *
 * @param expr - The expression tree to resolve
 * @param tokens - The original tokens containing tag names/IDs
 * @param getTagByName - Function to look up tags by name or numeric ID
 * @returns The same expression tree with tagIds populated
 * @throws {ValidationError} If a tag cannot be resolved
 *
 * @example
 * ```typescript
 * const tokens = tokenize("#feature AND #bugfix");
 * const expr = parseFilterExpression(tokens);
 * const resolved = resolveTagNames(expr, tokens, (name) => {
 *   return db.tags.find(t => t.name === name || t.id === parseInt(name, 10));
 * });
 * ```
 */
export function resolveTagNames(
  expr: TagFilterExpression,
  tokens: Token[],
  getTagByName: (name: string) => Tag | undefined
): TagFilterExpression {
  let tokenIndex = 0;

  function resolve(node: TagFilterExpression): TagFilterExpression {
    if (node.type === 'tag') {
      // Find the next TAG token
      while (tokenIndex < tokens.length && tokens[tokenIndex].type !== TokenType.TAG) {
        tokenIndex++;
      }

      if (tokenIndex >= tokens.length) {
        throw new ValidationError('Tag token mismatch during resolution');
      }

      const tagToken = tokens[tokenIndex];
      tokenIndex++;

      const tagValue = tagToken.value;

      // Check if it's a numeric ID
      const numericId = parseInt(tagValue, 10);
      if (!isNaN(numericId) && numericId.toString() === tagValue) {
        // Direct ID reference
        const tag = getTagByName(tagValue); // getTagByName should handle numeric IDs
        if (!tag) {
          throw new ValidationError(`Tag with ID ${tagValue} not found`);
        }
        return {
          ...node,
          tagId: tag.id,
        };
      }

      // Tag name lookup
      const tag = getTagByName(tagValue);
      if (!tag) {
        throw new ValidationError(`Tag '${tagValue}' not found`);
      }

      return {
        ...node,
        tagId: tag.id,
      };
    }

    // Recursively resolve children
    if (node.children) {
      return {
        ...node,
        children: node.children.map(resolve),
      };
    }

    return node;
  }

  return resolve(expr);
}

/**
 * Helper function to convert a TagFilterExpression back to a string.
 * Useful for debugging and displaying filter expressions.
 *
 * @param expr - The expression tree to stringify
 * @param getTagById - Optional function to look up tag names by ID
 * @returns A human-readable string representation
 *
 * @example
 * ```typescript
 * const str = stringifyExpression(expr, (id) => db.tags.find(t => t.id === id));
 * // Returns: "(#feature OR #bugfix) AND NOT #wip"
 * ```
 */
export function stringifyExpression(
  expr: TagFilterExpression,
  getTagById?: (id: number) => Tag | undefined
): string {
  if (expr.type === 'tag') {
    if (expr.tagId !== undefined && getTagById) {
      const tag = getTagById(expr.tagId);
      return tag ? `#${tag.name}` : `#${expr.tagId}`;
    }
    return expr.tagId !== undefined ? `#${expr.tagId}` : '#unknown';
  }

  if (expr.type === 'not') {
    const child = expr.children?.[0];
    if (!child) return 'NOT';
    const childStr = stringifyExpression(child, getTagById);
    // Add parentheses if child is a binary operator
    const needsParens = child.type === 'and' || child.type === 'or';
    return `NOT ${needsParens ? `(${childStr})` : childStr}`;
  }

  if (expr.type === 'and' || expr.type === 'or') {
    if (!expr.children || expr.children.length === 0) {
      return expr.type.toUpperCase();
    }

    const operator = expr.type.toUpperCase();
    const parts = expr.children.map((child) => {
      const childStr = stringifyExpression(child, getTagById);
      // Add parentheses if child is a lower-precedence operator
      // Precedence: NOT > AND > OR
      // Only add parens if parent has higher precedence than child
      const needsParens = expr.type === 'and' && child.type === 'or';
      return needsParens ? `(${childStr})` : childStr;
    });

    return parts.join(` ${operator} `);
  }

  return 'UNKNOWN';
}
