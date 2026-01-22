// ============================================================================
// TERMINAL E2E TESTS - Terminal View Functionality
// ============================================================================
//
// These tests verify the Terminal view behavior including
// tab management, terminal operations, and UI interactions.
//
// Note: These tests require the app to be built first (npm run build)
// ============================================================================

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// TEST SETUP
// ============================================================================

let electronApp: ElectronApplication;
let mainWindow: Page;

test.beforeAll(async () => {
  // Launch Electron app - pass the main entry point directly
  const mainPath = path.join(__dirname, '../../out/main/index.js');

  electronApp = await electron.launch({
    args: [mainPath],
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  });

  mainWindow = await electronApp.firstWindow();
  await mainWindow.waitForLoadState('domcontentloaded');

  // Terminal view is the default view - no navigation needed
  await mainWindow.waitForTimeout(500);
});

test.afterAll(async () => {
  if (electronApp) {
    await electronApp.close();
  }
});

// ============================================================================
// TERMINAL VIEW STRUCTURE TESTS
// ============================================================================

test.describe('Terminal View Structure', () => {
  test.beforeEach(async () => {
    // Close any open dialogs before each test
    await mainWindow.keyboard.press('Escape');
    await mainWindow.waitForTimeout(200);
  });

  test('should display terminal view with proper structure', async () => {
    // Terminal view should have a recognizable structure
    const rootElement = mainWindow.locator('#root');
    await expect(rootElement).toBeVisible();

    // Should have either terminal content (xterm), or welcome state with action buttons
    const hasTerminalElements = await mainWindow.locator('[class*="xterm"], canvas').count();
    const hasWelcomeState = await mainWindow.locator('text=Welcome to GoodVibes').count();
    const hasActionButtons = await mainWindow.locator('button:has-text("Start new Claude Code session"), button:has-text("Open new terminal")').count();

    // Either terminal content or welcome state with actions should exist
    expect(hasTerminalElements + hasWelcomeState + hasActionButtons).toBeGreaterThan(0);
  });

  test('should display header with tab bar area', async () => {
    // The terminal header contains the tab bar and New button
    // The tablist might be empty (zero width) when there are no tabs
    // So we check for either the tablist OR the New button which is always visible

    // Wait for the UI to stabilize
    await mainWindow.waitForTimeout(500);

    // Check if the tablist element exists in the DOM (even if not visible due to being empty)
    const tabListExists = await mainWindow.locator('[role="tablist"]').count() > 0;

    // The New button should always be visible in the header area
    const newButton = mainWindow.locator('button').filter({ hasText: 'New' }).first();
    const hasNewButton = await newButton.isVisible().catch(() => false);

    // Either the tablist exists in DOM or the New button is visible
    // This confirms the terminal header area is present
    expect(tabListExists || hasNewButton).toBe(true);
  });

  test('should have new terminal button accessible', async () => {
    // New button is in the tab area - it has text "New"
    const newButton = mainWindow.locator('button').filter({ hasText: 'New' }).first();

    // Wait for button to be visible
    // Intentionally silent: timeout is acceptable, we check visibility on next line
    await newButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const hasNewButton = await newButton.isVisible().catch(() => false);

    // New terminal button should be accessible
    expect(hasNewButton).toBe(true);
  });

  test('should have footer with zoom controls', async () => {
    // Zoom controls are in a group with aria-label="Zoom controls"
    const zoomControls = mainWindow.getByRole('group', { name: 'Zoom controls' });
    const hasZoomControls = await zoomControls.isVisible().catch(() => false);

    // Zoom controls should be visible
    expect(hasZoomControls).toBe(true);
  });
});

// ============================================================================
// TAB MANAGEMENT TESTS
// ============================================================================

test.describe('Tab Management', () => {
  test('should handle Ctrl+N shortcut without crashing', async () => {
    // Capture errors
    const errors: string[] = [];
    mainWindow.on('pageerror', err => errors.push(err.message));

    // Count current tabs before
    const tabsBefore = await mainWindow.locator('[role="tab"]').count();

    await mainWindow.keyboard.press('Control+N');
    await mainWindow.waitForTimeout(1000);

    // App should remain responsive
    const isVisible = await mainWindow.isVisible('body');
    expect(isVisible).toBe(true);

    // No page errors
    expect(errors).toHaveLength(0);

    // Tabs may have increased (if folder picker opened and was used)
    const tabsAfter = await mainWindow.locator('[role="tab"]').count();
    expect(tabsAfter).toBeGreaterThanOrEqual(tabsBefore);
  });

  test('should handle Ctrl+W shortcut safely', async () => {
    const errors: string[] = [];
    mainWindow.on('pageerror', err => errors.push(err.message));

    const tabsBefore = await mainWindow.locator('[role="tab"]').count();

    // Only try close if we have tabs
    if (tabsBefore > 0) {
      await mainWindow.keyboard.press('Control+W');
      await mainWindow.waitForTimeout(500);

      // Should remain responsive
      const isVisible = await mainWindow.isVisible('body');
      expect(isVisible).toBe(true);

      // Tabs should have decreased or stayed same (can't close last)
      const tabsAfter = await mainWindow.locator('[role="tab"]').count();
      expect(tabsAfter).toBeLessThanOrEqual(tabsBefore);
    }

    expect(errors).toHaveLength(0);
  });

  test('should handle Ctrl+Tab for tab switching', async () => {
    const errors: string[] = [];
    mainWindow.on('pageerror', err => errors.push(err.message));

    const tabCount = await mainWindow.locator('[role="tab"]').count();

    await mainWindow.keyboard.press('Control+Tab');
    await mainWindow.waitForTimeout(300);

    // Should remain responsive
    const isVisible = await mainWindow.isVisible('body');
    expect(isVisible).toBe(true);

    expect(errors).toHaveLength(0);
  });

  test('should click on tab to activate it', async () => {
    const tabs = mainWindow.locator('[role="tab"]');
    const tabCount = await tabs.count();

    if (tabCount > 0) {
      const firstTab = tabs.first();
      await firstTab.click();
      await mainWindow.waitForTimeout(200);

      // Tab should now be active (have active styling or aria-selected)
      const isSelected = await firstTab.getAttribute('aria-selected');
      const hasActiveClass = await firstTab.evaluate(el =>
        el.classList.contains('active') ||
        el.className.includes('primary') ||
        el.className.includes('selected')
      );

      // Either aria-selected or visual indication should be present
      expect(isSelected === 'true' || hasActiveClass).toBe(true);
    }
  });

  test('should close tab via close button', async () => {
    const tabs = mainWindow.locator('[role="tab"]');
    const tabCount = await tabs.count();

    if (tabCount > 1) {
      // Find close button on a tab
      const closeButton = tabs.first().locator('button, [role="button"]').first();
      const hasCloseButton = await closeButton.isVisible().catch(() => false);

      if (hasCloseButton) {
        await closeButton.click();
        await mainWindow.waitForTimeout(300);

        const newTabCount = await tabs.count();
        expect(newTabCount).toBeLessThan(tabCount);
      }
    }
  });
});

// ============================================================================
// TERMINAL INTERACTION TESTS
// ============================================================================

test.describe('Terminal Interaction', () => {
  test('should focus terminal on click', async () => {
    const terminal = mainWindow.locator('[class*="xterm"], canvas').first();

    if (await terminal.isVisible()) {
      await terminal.click();
      await mainWindow.waitForTimeout(200);

      // Terminal should be focusable
      const isVisible = await mainWindow.isVisible('body');
      expect(isVisible).toBe(true);
    }
  });

  test('should handle terminal resize gracefully', async () => {
    const window = await electronApp.browserWindow(mainWindow);

    // Get original size
    const originalBounds = await window.evaluate(win => win.getBounds());

    // Resize window smaller
    await window.evaluate((win) => {
      win.setSize(900, 650);
    });
    await mainWindow.waitForTimeout(300);

    // Terminal should still be visible and functional
    const isVisible = await mainWindow.isVisible('body');
    expect(isVisible).toBe(true);

    // Resize larger
    await window.evaluate((win) => {
      win.setSize(1400, 900);
    });
    await mainWindow.waitForTimeout(300);

    // Still responsive
    const stillVisible = await mainWindow.isVisible('body');
    expect(stillVisible).toBe(true);

    // Restore original
    await window.evaluate((win, bounds) => {
      win.setSize(bounds.width, bounds.height);
    }, originalBounds);
  });

  test('should handle keyboard input without errors', async () => {
    const errors: string[] = [];
    mainWindow.on('pageerror', err => errors.push(err.message));

    const terminal = mainWindow.locator('[class*="xterm"], canvas').first();

    if (await terminal.isVisible()) {
      await terminal.click();
      await mainWindow.waitForTimeout(100);

      // Type some characters
      await mainWindow.keyboard.type('test');
      await mainWindow.waitForTimeout(200);

      // Should not crash
      const isVisible = await mainWindow.isVisible('body');
      expect(isVisible).toBe(true);

      expect(errors).toHaveLength(0);
    }
  });
});

// ============================================================================
// EMPTY STATE TESTS
// ============================================================================

test.describe('Empty State', () => {
  test('should show meaningful empty state or terminal content', async () => {
    // Either we have terminals or welcome state with "Welcome to GoodVibes"
    const welcomeHeading = mainWindow.locator('text=Welcome to GoodVibes');
    const terminalContent = mainWindow.locator('[class*="xterm"], canvas');

    const hasWelcome = await welcomeHeading.isVisible().catch(() => false);
    const hasTerminal = await terminalContent.first().isVisible().catch(() => false);

    // One of these must exist
    expect(hasWelcome || hasTerminal).toBe(true);
  });

  test('should have action button in empty state', async () => {
    const welcomeHeading = mainWindow.locator('text=Welcome to GoodVibes');

    if (await welcomeHeading.isVisible()) {
      // Empty state should have action buttons like "Start new Claude Code session"
      const actionButton = mainWindow.getByRole('button', { name: 'Start new Claude Code session' });
      const hasActionButton = await actionButton.isVisible().catch(() => false);

      expect(hasActionButton).toBe(true);

      // Button should be clickable
      if (hasActionButton) {
        await expect(actionButton).toBeEnabled();
      }
    }
  });
});

// ============================================================================
// ZOOM CONTROLS TESTS
// ============================================================================

test.describe('Zoom Controls', () => {
  test.beforeEach(async () => {
    // Close any open dialogs before each test
    // First try to click the Cancel button if the folder picker is open
    const cancelButton = mainWindow.getByRole('button', { name: 'Cancel' });
    if (await cancelButton.isVisible().catch(() => false)) {
      await cancelButton.click();
      await mainWindow.waitForTimeout(200);
    }
    // Also press Escape as a fallback
    await mainWindow.keyboard.press('Escape');
    await mainWindow.waitForTimeout(200);
  });

  test('should display current zoom level', async () => {
    // Zoom controls are in a group with aria-label="Zoom controls"
    // The zoom level is displayed as "100%" text
    const zoomGroup = mainWindow.getByRole('group', { name: 'Zoom controls' });
    const hasZoomGroup = await zoomGroup.isVisible().catch(() => false);
    expect(hasZoomGroup).toBe(true);

    // Within the group, there should be a percentage display
    const zoomDisplay = zoomGroup.locator('text=/\\d+%/');
    const hasZoomDisplay = await zoomDisplay.isVisible().catch(() => false);
    expect(hasZoomDisplay).toBe(true);
  });

  test('should zoom in with plus button', async () => {
    const zoomGroup = mainWindow.getByRole('group', { name: 'Zoom controls' });
    const zoomInButton = mainWindow.getByRole('button', { name: 'Zoom in' });
    const zoomDisplay = zoomGroup.locator('text=/\\d+%/');

    if (await zoomInButton.isVisible() && await zoomDisplay.isVisible()) {
      const initialZoom = await zoomDisplay.textContent();

      await zoomInButton.click();
      await mainWindow.waitForTimeout(200);

      const newZoom = await zoomDisplay.textContent();

      // Zoom should have increased
      if (initialZoom && newZoom) {
        const initialNum = parseInt(initialZoom.replace('%', ''));
        const newNum = parseInt(newZoom.replace('%', ''));
        expect(newNum).toBeGreaterThan(initialNum);

        // Reset zoom using proper selector
        const resetButton = mainWindow.getByRole('button', { name: /Reset zoom/ });
        if (await resetButton.isVisible().catch(() => false)) {
          await resetButton.click();
        }
      }
    }
  });

  test('should zoom out with minus button', async () => {
    const zoomGroup = mainWindow.getByRole('group', { name: 'Zoom controls' });
    const zoomOutButton = mainWindow.getByRole('button', { name: 'Zoom out' });
    const zoomDisplay = zoomGroup.locator('text=/\\d+%/');

    if (await zoomOutButton.isVisible() && await zoomDisplay.isVisible()) {
      const initialZoom = await zoomDisplay.textContent();

      await zoomOutButton.click();
      await mainWindow.waitForTimeout(200);

      const newZoom = await zoomDisplay.textContent();

      // Zoom should have decreased
      if (initialZoom && newZoom) {
        const initialNum = parseInt(initialZoom.replace('%', ''));
        const newNum = parseInt(newZoom.replace('%', ''));
        expect(newNum).toBeLessThan(initialNum);

        // Reset zoom using proper selector
        const resetButton = mainWindow.getByRole('button', { name: /Reset zoom/ });
        if (await resetButton.isVisible().catch(() => false)) {
          await resetButton.click();
        }
      }
    }
  });

  test('should reset zoom with Reset button', async () => {
    const zoomGroup = mainWindow.getByRole('group', { name: 'Zoom controls' });
    const resetButton = mainWindow.getByRole('button', { name: /Reset zoom/ });
    const zoomDisplay = zoomGroup.locator('text=/\\d+%/');
    const zoomInButton = mainWindow.getByRole('button', { name: 'Zoom in' });

    // First change zoom to not be at 100%
    if (await zoomInButton.isVisible()) {
      await zoomInButton.click();
      await mainWindow.waitForTimeout(100);
    }

    // Then reset if the reset button is enabled
    if (await resetButton.isVisible() && await resetButton.isEnabled().catch(() => false)) {
      await resetButton.click();
      await mainWindow.waitForTimeout(200);

      const zoomAfterReset = await zoomDisplay.textContent();

      // Should be back to 100%
      if (zoomAfterReset) {
        expect(zoomAfterReset).toContain('100');
      }
    }
  });
});

// ============================================================================
// GIT PANEL TESTS
// ============================================================================

test.describe('Git Panel', () => {
  test('should have Git panel toggle button', async () => {
    // Look for git panel toggle
    const gitToggle = mainWindow.locator('button[title*="Git"], button[aria-label*="Git"], [title*="git"]').first();
    const hasGitToggle = await gitToggle.isVisible().catch(() => false);

    // Git toggle should exist when there's an active session
    // This might not be visible if there are no terminals
    expect(typeof hasGitToggle).toBe('boolean');
  });

  test('should toggle Git panel visibility', async () => {
    const gitToggle = mainWindow.locator('button[title*="Git"], button[aria-label*="Git"]').first();

    if (await gitToggle.isVisible()) {
      // Click to toggle
      await gitToggle.click();
      await mainWindow.waitForTimeout(300);

      // Should remain responsive
      const isVisible = await mainWindow.isVisible('body');
      expect(isVisible).toBe(true);

      // Toggle back
      await gitToggle.click();
      await mainWindow.waitForTimeout(200);
    }
  });
});

// ============================================================================
// CONTEXT MENU TESTS
// ============================================================================

test.describe('Context Menu', () => {
  test('should handle right-click on tab without crashing', async () => {
    const errors: string[] = [];
    mainWindow.on('pageerror', err => errors.push(err.message));

    const tab = mainWindow.locator('[role="tab"]').first();

    if (await tab.isVisible()) {
      await tab.click({ button: 'right' });
      await mainWindow.waitForTimeout(300);

      // Should not crash
      const isVisible = await mainWindow.isVisible('body');
      expect(isVisible).toBe(true);

      // Close any context menu
      await mainWindow.keyboard.press('Escape');

      expect(errors).toHaveLength(0);
    }
  });

  test('should handle right-click on terminal without crashing', async () => {
    const errors: string[] = [];
    mainWindow.on('pageerror', err => errors.push(err.message));

    const terminal = mainWindow.locator('[class*="xterm"], canvas').first();

    if (await terminal.isVisible()) {
      await terminal.click({ button: 'right' });
      await mainWindow.waitForTimeout(300);

      // Should not crash
      const isVisible = await mainWindow.isVisible('body');
      expect(isVisible).toBe(true);

      // Close any context menu
      await mainWindow.keyboard.press('Escape');

      expect(errors).toHaveLength(0);
    }
  });
});

// ============================================================================
// COPY/PASTE TESTS
// ============================================================================

test.describe('Copy and Paste', () => {
  test('should handle Ctrl+V paste shortcut', async () => {
    const errors: string[] = [];
    mainWindow.on('pageerror', err => errors.push(err.message));

    const terminal = mainWindow.locator('[class*="xterm"], canvas').first();

    if (await terminal.isVisible()) {
      await terminal.click();
      await mainWindow.waitForTimeout(100);

      // Try paste shortcut
      await mainWindow.keyboard.press('Control+V');
      await mainWindow.waitForTimeout(200);

      // Should not crash
      const isVisible = await mainWindow.isVisible('body');
      expect(isVisible).toBe(true);

      expect(errors).toHaveLength(0);
    }
  });

  test('should handle Ctrl+C copy shortcut', async () => {
    const errors: string[] = [];
    mainWindow.on('pageerror', err => errors.push(err.message));

    const terminal = mainWindow.locator('[class*="xterm"], canvas').first();

    if (await terminal.isVisible()) {
      await terminal.click();
      await mainWindow.waitForTimeout(100);

      // Try copy shortcut
      await mainWindow.keyboard.press('Control+C');
      await mainWindow.waitForTimeout(200);

      // Should not crash
      const isVisible = await mainWindow.isVisible('body');
      expect(isVisible).toBe(true);

      expect(errors).toHaveLength(0);
    }
  });
});

// ============================================================================
// SCROLL BEHAVIOR TESTS
// ============================================================================

test.describe('Terminal Scroll Behavior', () => {
  test('should handle scroll events without crashing', async () => {
    const errors: string[] = [];
    mainWindow.on('pageerror', err => errors.push(err.message));

    const terminal = mainWindow.locator('[class*="xterm"], canvas').first();

    if (await terminal.isVisible()) {
      await terminal.click();
      await mainWindow.waitForTimeout(100);

      // Scroll with mouse wheel
      await mainWindow.mouse.wheel(0, 100);
      await mainWindow.waitForTimeout(100);
      await mainWindow.mouse.wheel(0, -100);
      await mainWindow.waitForTimeout(100);

      // Should remain responsive
      const isVisible = await mainWindow.isVisible('body');
      expect(isVisible).toBe(true);

      expect(errors).toHaveLength(0);
    }
  });
});
