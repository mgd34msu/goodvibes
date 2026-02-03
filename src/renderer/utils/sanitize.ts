// ============================================================================
// HTML SANITIZATION UTILITY
// Provides XSS-safe HTML sanitization using DOMPurify
// ============================================================================

import DOMPurify, { type Config } from 'dompurify';

/**
 * Configuration for DOMPurify that allows only safe HTML elements and attributes
 * commonly used in syntax highlighting and code display.
 */
const SANITIZE_CONFIG: Config = {
  // Allow only specific tags used in syntax highlighting
  ALLOWED_TAGS: ['span', 'code', 'pre', 'br', 'div'],
  // Allow only class attribute for styling
  ALLOWED_ATTR: ['class'],
  // Don't allow any URI attributes
  ALLOW_DATA_ATTR: false,
  // Remove any potentially dangerous elements/attributes
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'a'],
  FORBID_ATTR: ['onclick', 'onerror', 'onload', 'onmouseover', 'onfocus', 'onblur', 'href', 'src', 'srcdoc'],
  // Return string instead of TrustedHTML
  RETURN_TRUSTED_TYPE: false,
};

/**
 * Sanitizes HTML content to prevent XSS attacks.
 * Use this for any content that will be rendered via dangerouslySetInnerHTML.
 *
 * @param dirty - The potentially unsafe HTML string
 * @returns A sanitized HTML string safe for DOM insertion
 */
export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, SANITIZE_CONFIG) as string;
}

/**
 * Creates a sanitized HTML object suitable for React's dangerouslySetInnerHTML.
 *
 * @param dirty - The potentially unsafe HTML string
 * @returns An object with sanitized __html property
 */
export function createSanitizedHtml(dirty: string): { __html: string } {
  return { __html: sanitizeHtml(dirty) };
}

/**
 * Escapes HTML special characters to prevent XSS.
 * Use this when you want to display text literally without any HTML rendering.
 *
 * @param text - The text to escape
 * @returns The escaped text safe for display
 */
export function escapeHtmlStrict(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/`/g, '&#x60;')
    .replace(/\//g, '&#x2F;');
}
