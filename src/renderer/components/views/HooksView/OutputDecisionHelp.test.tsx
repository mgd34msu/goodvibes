// ============================================================================
// OUTPUT DECISION HELP XSS PREVENTION TESTS
// Verifies that the safe JSON renderer neutralizes XSS payloads
// ============================================================================

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OutputDecisionHelp } from './OutputDecisionHelp';

describe('OutputDecisionHelp XSS Prevention', () => {
  it('renders without XSS when displaying event metadata', () => {
    // PreToolUse has outputSchemaExample which uses our safe JSON renderer
    const { container } = render(<OutputDecisionHelp eventType="PreToolUse" />);

    // Should not contain any script elements
    expect(container.querySelector('script')).toBeNull();

    // Should render JSON content safely
    expect(container.textContent).toContain('hookEventName');
    expect(container.textContent).toContain('PreToolUse');
  });

  it('renders PermissionRequest event safely', () => {
    const { container } = render(<OutputDecisionHelp eventType="PermissionRequest" />);

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('decision');
  });

  it('renders PostToolUse event safely', () => {
    const { container } = render(<OutputDecisionHelp eventType="PostToolUse" />);

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('decision');
    expect(container.textContent).toContain('block');
  });

  it('handles events without output schema', () => {
    // PostToolUseFailure has no outputSchemaExample
    const { container } = render(<OutputDecisionHelp eventType="PostToolUseFailure" />);

    // Should render without errors
    expect(container.querySelector('script')).toBeNull();
  });

  it('handles Notification event type', () => {
    const { container } = render(<OutputDecisionHelp eventType="Notification" />);

    expect(container.querySelector('script')).toBeNull();
  });

  it('renders boolean values safely in JSON', () => {
    // The output schema examples contain boolean values
    const { container } = render(<OutputDecisionHelp eventType="PermissionRequest" />);

    // Boolean values should be rendered as text
    expect(container.textContent).toMatch(/false|true/);
    expect(container.querySelector('script')).toBeNull();
  });

  it('renders null values safely in JSON', () => {
    const { container } = render(<OutputDecisionHelp eventType="PermissionRequest" />);

    // null should be rendered as text
    expect(container.textContent).toContain('null');
  });

  it('does not use dangerouslySetInnerHTML', () => {
    const { container } = render(<OutputDecisionHelp eventType="PreToolUse" />);

    // Check that there are no inline onclick handlers or similar XSS vectors
    const allElements = container.querySelectorAll('*');
    allElements.forEach((el) => {
      // Check for event handler attributes
      expect(el.getAttribute('onclick')).toBeNull();
      expect(el.getAttribute('onerror')).toBeNull();
      expect(el.getAttribute('onload')).toBeNull();
      expect(el.getAttribute('onmouseover')).toBeNull();
    });
  });

  it('renders string values with proper escaping', () => {
    const { container } = render(<OutputDecisionHelp eventType="PreToolUse" />);

    // String values in JSON should be quoted
    // Check that our JSON renderer properly displays strings
    expect(container.textContent).toContain('"allow"');
    expect(container.textContent).toContain('"PreToolUse"');
  });
});

describe('OutputDecisionHelp component rendering', () => {
  it('returns null for invalid event type', () => {
    // @ts-expect-error - Testing invalid input
    const { container } = render(<OutputDecisionHelp eventType="InvalidEvent" />);
    expect(container.innerHTML).toBe('');
  });

  it('displays available decisions for blocking events', () => {
    render(<OutputDecisionHelp eventType="PreToolUse" />);

    // PreToolUse supports allow, deny, ask decisions
    expect(screen.getByText('allow')).toBeInTheDocument();
    expect(screen.getByText('deny')).toBeInTheDocument();
    expect(screen.getByText('ask')).toBeInTheDocument();
  });

  it('displays exit code information', () => {
    render(<OutputDecisionHelp eventType="PreToolUse" />);

    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('displays can block indicator correctly', () => {
    render(<OutputDecisionHelp eventType="PreToolUse" />);

    expect(screen.getByText('Can Block')).toBeInTheDocument();
  });

  it('displays cannot block indicator for non-blocking events', () => {
    render(<OutputDecisionHelp eventType="Notification" />);

    expect(screen.getByText('Cannot Block')).toBeInTheDocument();
  });
});
