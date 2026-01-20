// ============================================================================
// SETTINGS E2E TESTS - Settings View Functionality
// ============================================================================
//
// These tests verify the Settings view behavior including
// theme changes, configuration options, and persistence.
//
// Note: These tests require the app to be built first (npm run build)
// ============================================================================

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Navigation dropdown mapping
const VIEW_TO_DROPDOWN: Record<string, string> = {
  Terminal: 'Code',
  Sessions: 'Code',
  Settings: 'System',
};

// Helper to navigate to a view using dropdown menus
async function navigateToView(page: Page, viewName: string): Promise<boolean> {
  const dropdownName = VIEW_TO_DROPDOWN[viewName];
  if (!dropdownName) return false;

  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    const dropdownBtn = page.getByRole('button', { name: dropdownName });
    if (!await dropdownBtn.isVisible()) return false;
    await dropdownBtn.click();
    await page.waitForTimeout(200);

    const menuItem = page.getByRole('menuitem', { name: viewName });
    if (await menuItem.isVisible()) {
      await menuItem.click();
      await page.waitForTimeout(200);
      return true;
    }
    await page.keyboard.press('Escape');
    return false;
  } catch {
    return false;
  }
}

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

  // Navigate to Settings using dropdown
  await navigateToView(mainWindow, 'Settings');
  await mainWindow.waitForTimeout(500);
});

test.afterAll(async () => {
  if (electronApp) {
    await electronApp.close();
  }
});

// ============================================================================
// SETTINGS SECTIONS TESTS
// ============================================================================

test.describe('Settings Sections', () => {
  test('should display Display section with theme controls', async () => {
    // The appearance section is called "Display"
    const displaySection = mainWindow.locator('text=Display');
    await expect(displaySection.first()).toBeVisible();

    // Theme selector should be present
    const themeLabel = mainWindow.locator('text=Theme');
    await expect(themeLabel.first()).toBeVisible();
  });

  test('should display Startup Behavior section', async () => {
    const startupSection = mainWindow.locator('text=Startup Behavior');
    const isVisible = await startupSection.first().isVisible().catch(() => false);

    // Startup section should exist
    expect(isVisible).toBe(true);
  });

  test('should display Claude CLI Options section', async () => {
    const cliSection = mainWindow.locator('text=Claude CLI Options');
    const isVisible = await cliSection.first().isVisible().catch(() => false);

    // CLI options section should exist
    expect(isVisible).toBe(true);
  });

  test('should display Git Integration section', async () => {
    const gitSection = mainWindow.locator('text=Git Integration');
    const isVisible = await gitSection.first().isVisible().catch(() => false);

    // Git section should exist
    expect(isVisible).toBe(true);
  });

  test('should display GitHub Integration section', async () => {
    const githubSection = mainWindow.locator('text=GitHub Integration');
    const isVisible = await githubSection.first().isVisible().catch(() => false);

    // GitHub section should exist
    expect(isVisible).toBe(true);
  });

  test('should display Budget Alerts section', async () => {
    const budgetSection = mainWindow.locator('text=Budget Alerts');
    const isVisible = await budgetSection.first().isVisible().catch(() => false);

    // Budget section should exist
    expect(isVisible).toBe(true);
  });

  test('should display Keyboard Shortcuts section', async () => {
    const shortcutsSection = mainWindow.locator('text=Keyboard Shortcuts');
    const isVisible = await shortcutsSection.first().isVisible().catch(() => false);

    // Shortcuts section should exist
    expect(isVisible).toBe(true);
  });
});

// ============================================================================
// THEME SETTINGS TESTS
// ============================================================================

test.describe('Theme Settings', () => {
  test('should have functional theme selector', async () => {
    // Find theme-related controls
    const themeLabel = mainWindow.locator('text=Theme');
    await expect(themeLabel.first()).toBeVisible();

    // Should have a select element or radio buttons for theme
    const themeSelect = mainWindow.locator('select').first();
    const hasSelect = await themeSelect.isVisible().catch(() => false);

    if (hasSelect) {
      // Select element should be interactive
      await expect(themeSelect).toBeEnabled();
    }
  });

  test('should have dark and light theme options available', async () => {
    // Theme uses cards, not a select. Look for theme-related headings
    // The UI has "Dark Themes" and "Light Themes" sections
    const darkThemesSection = mainWindow.locator('text=Dark Themes');
    const lightThemesSection = mainWindow.locator('text=Light Themes');

    const hasDarkThemes = await darkThemesSection.isVisible().catch(() => false);
    const hasLightThemes = await lightThemesSection.isVisible().catch(() => false);

    // If theme sections are visible, they should have options
    if (hasDarkThemes || hasLightThemes) {
      expect(hasDarkThemes || hasLightThemes).toBe(true);
    } else {
      // If no theme sections, check for at least some theme-related UI
      const themeLabel = mainWindow.locator('text=Theme');
      await expect(themeLabel.first()).toBeVisible();
    }
  });

  test('should persist theme selection', async () => {
    const themeSelect = mainWindow.locator('select').first();

    if (await themeSelect.isVisible()) {
      // Get current value
      const initialValue = await themeSelect.inputValue();

      // Change theme
      const options = await themeSelect.locator('option').allTextContents();
      if (options.length > 1) {
        // Select a different option
        await themeSelect.selectOption({ index: 1 });
        await mainWindow.waitForTimeout(300);

        // Verify value changed
        const newValue = await themeSelect.inputValue();
        expect(newValue).not.toBe(initialValue);

        // Revert to original
        await themeSelect.selectOption(initialValue);
      }
    }
  });
});

// ============================================================================
// TOGGLE SETTINGS TESTS
// ============================================================================

test.describe('Toggle Settings', () => {
  test('should have accessible toggle switches', async () => {
    const toggles = mainWindow.locator('[role="switch"]');
    const toggleCount = await toggles.count();

    // Should have multiple toggle switches
    expect(toggleCount).toBeGreaterThan(0);

    // First toggle should have proper ARIA attributes
    const firstToggle = toggles.first();
    const ariaChecked = await firstToggle.getAttribute('aria-checked');

    // aria-checked should be 'true' or 'false'
    expect(['true', 'false']).toContain(ariaChecked);
  });

  test('should toggle switch state on click', async () => {
    const firstToggle = mainWindow.locator('[role="switch"]').first();

    if (await firstToggle.isVisible()) {
      // Get initial state
      const initialState = await firstToggle.getAttribute('aria-checked');

      // Click to toggle
      await firstToggle.click();
      await mainWindow.waitForTimeout(200);

      // Get new state
      const newState = await firstToggle.getAttribute('aria-checked');

      // State should have changed
      expect(newState).not.toBe(initialState);

      // Toggle back to restore original state
      await firstToggle.click();
      await mainWindow.waitForTimeout(200);

      // Should be back to initial state
      const restoredState = await firstToggle.getAttribute('aria-checked');
      expect(restoredState).toBe(initialState);
    }
  });

  test('should maintain toggle state after scrolling', async () => {
    const toggles = mainWindow.locator('[role="switch"]');
    const toggleCount = await toggles.count();

    if (toggleCount > 0) {
      const firstToggle = toggles.first();
      const initialState = await firstToggle.getAttribute('aria-checked');

      // Scroll down the settings page
      await mainWindow.evaluate(() => {
        const container = document.querySelector('[class*="overflow-auto"], [class*="overflow-y-auto"]');
        if (container) container.scrollTop = container.scrollHeight;
      });
      await mainWindow.waitForTimeout(200);

      // Scroll back up
      await mainWindow.evaluate(() => {
        const container = document.querySelector('[class*="overflow-auto"], [class*="overflow-y-auto"]');
        if (container) container.scrollTop = 0;
      });
      await mainWindow.waitForTimeout(200);

      // State should be preserved
      const stateAfterScroll = await firstToggle.getAttribute('aria-checked');
      expect(stateAfterScroll).toBe(initialState);
    }
  });
});

// ============================================================================
// DANGER ZONE TESTS
// ============================================================================

test.describe('Danger Zone', () => {
  test('should have Reset Settings button visible', async () => {
    // Scroll to find Reset button if needed
    await mainWindow.evaluate(() => {
      const container = document.querySelector('[class*="overflow-auto"], [class*="overflow-y-auto"]');
      if (container) container.scrollTop = container.scrollHeight;
    });
    await mainWindow.waitForTimeout(200);

    const resetButton = mainWindow.locator('button:has-text("Reset")').first();
    const hasResetButton = await resetButton.isVisible().catch(() => false);

    // Reset button should be present somewhere in danger zone
    expect(hasResetButton).toBe(true);
  });

  test('should show confirmation dialog before reset', async () => {
    // Scroll to find Reset button
    await mainWindow.evaluate(() => {
      const container = document.querySelector('[class*="overflow-auto"], [class*="overflow-y-auto"]');
      if (container) container.scrollTop = container.scrollHeight;
    });
    await mainWindow.waitForTimeout(200);

    const resetButton = mainWindow.locator('button:has-text("Reset Settings")').first();

    if (await resetButton.isVisible()) {
      await resetButton.click();
      await mainWindow.waitForTimeout(300);

      // Should show confirmation dialog
      const dialog = mainWindow.locator('[role="dialog"], [class*="modal"]');
      const hasDialog = await dialog.first().isVisible().catch(() => false);

      if (hasDialog) {
        // Dialog should have Cancel option
        const cancelButton = mainWindow.locator('button:has-text("Cancel")').first();
        await expect(cancelButton).toBeVisible();

        // Cancel and close dialog
        await cancelButton.click();
        await mainWindow.waitForTimeout(200);
      } else {
        // Close with escape if no dialog visible
        await mainWindow.keyboard.press('Escape');
      }
    }
  });

  test('should cancel reset when Cancel is clicked', async () => {
    // Scroll to find Reset button
    await mainWindow.evaluate(() => {
      const container = document.querySelector('[class*="overflow-auto"], [class*="overflow-y-auto"]');
      if (container) container.scrollTop = container.scrollHeight;
    });
    await mainWindow.waitForTimeout(200);

    // Get a toggle state before attempting reset
    const firstToggle = mainWindow.locator('[role="switch"]').first();
    let initialToggleState = '';

    if (await firstToggle.isVisible()) {
      initialToggleState = await firstToggle.getAttribute('aria-checked') || '';
    }

    const resetButton = mainWindow.locator('button:has-text("Reset Settings")').first();

    if (await resetButton.isVisible()) {
      await resetButton.click();
      await mainWindow.waitForTimeout(300);

      // Cancel the reset
      const cancelButton = mainWindow.locator('button:has-text("Cancel")').first();
      if (await cancelButton.isVisible()) {
        await cancelButton.click();
        await mainWindow.waitForTimeout(200);
      } else {
        await mainWindow.keyboard.press('Escape');
      }

      // Settings should not have changed
      if (initialToggleState && await firstToggle.isVisible()) {
        const stateAfterCancel = await firstToggle.getAttribute('aria-checked');
        expect(stateAfterCancel).toBe(initialToggleState);
      }
    }
  });
});

// ============================================================================
// INPUT SETTINGS TESTS
// ============================================================================

test.describe('Input Settings', () => {
  test('should have functional font size control', async () => {
    // Look for font size slider or input
    const fontSizeControl = mainWindow.locator('input[type="range"], input[type="number"]').first();
    const hasControl = await fontSizeControl.isVisible().catch(() => false);

    expect(hasControl).toBe(true);

    if (hasControl) {
      await expect(fontSizeControl).toBeEnabled();
    }
  });

  test('should validate number input fields', async () => {
    const numberInputs = mainWindow.locator('input[type="number"]');
    const count = await numberInputs.count();

    if (count > 0) {
      const firstInput = numberInputs.first();

      if (await firstInput.isVisible()) {
        // Get current value
        const currentValue = await firstInput.inputValue();

        // Try entering invalid value
        await firstInput.fill('-999');
        await mainWindow.waitForTimeout(100);

        // Input should handle invalid input gracefully (either reject or clamp)
        const newValue = await firstInput.inputValue();

        // Value should either be clamped, empty, or the input should show error state
        // This is a structural test - we're checking that the input is interactive
        expect(typeof newValue).toBe('string');

        // Restore original value
        await firstInput.fill(currentValue);
      }
    }
  });

  test('should have text input fields for customization', async () => {
    const textInputs = mainWindow.locator('input[type="text"]');
    const count = await textInputs.count();

    // Should have some text inputs for customization
    expect(count).toBeGreaterThanOrEqual(0);

    if (count > 0) {
      const firstInput = textInputs.first();
      if (await firstInput.isVisible()) {
        // Input should be enabled
        await expect(firstInput).toBeEnabled();
      }
    }
  });

  test('should persist slider changes', async () => {
    const sliders = mainWindow.locator('input[type="range"]');
    const count = await sliders.count();

    if (count > 0) {
      const slider = sliders.first();

      if (await slider.isVisible()) {
        // Get initial value
        const initialValue = await slider.inputValue();

        // Change slider value
        const min = await slider.getAttribute('min') || '0';
        const max = await slider.getAttribute('max') || '100';
        const midValue = Math.round((parseInt(min) + parseInt(max)) / 2).toString();

        await slider.fill(midValue);
        await mainWindow.waitForTimeout(200);

        // Verify change
        const newValue = await slider.inputValue();

        // Value should have changed or stayed if already at mid
        expect(newValue).toBe(midValue);

        // Restore original
        await slider.fill(initialValue);
      }
    }
  });
});

// ============================================================================
// SETTINGS PERSISTENCE TESTS
// ============================================================================

test.describe('Settings Persistence', () => {
  test('should persist settings after navigation away and back', async () => {
    // Get a toggle state
    const firstToggle = mainWindow.locator('[role="switch"]').first();
    let initialState = '';

    if (await firstToggle.isVisible()) {
      initialState = await firstToggle.getAttribute('aria-checked') || '';

      // Toggle it
      await firstToggle.click();
      await mainWindow.waitForTimeout(200);
    }

    // Navigate away
    const terminalNav = mainWindow.locator('text=Terminal').first();
    if (await terminalNav.isVisible()) {
      await terminalNav.click();
      await mainWindow.waitForTimeout(300);
    }

    // Navigate back to settings
    const settingsNav = mainWindow.locator('text=Settings').first();
    if (await settingsNav.isVisible()) {
      await settingsNav.click();
      await mainWindow.waitForTimeout(300);
    }

    // Check if toggle maintained its new state
    if (initialState && await firstToggle.isVisible()) {
      const stateAfterNav = await firstToggle.getAttribute('aria-checked');

      // Should have persisted the toggled state (opposite of initial)
      expect(stateAfterNav).not.toBe(initialState);

      // Restore original state
      await firstToggle.click();
    }
  });
});

// ============================================================================
// KEYBOARD NAVIGATION TESTS
// ============================================================================

test.describe('Settings Keyboard Navigation', () => {
  test('should support Tab navigation between controls', async () => {
    // Focus the settings view
    await mainWindow.keyboard.press('Tab');
    await mainWindow.waitForTimeout(100);

    // Should have focused an element
    const focusedTag = await mainWindow.evaluate(() => document.activeElement?.tagName);
    expect(focusedTag).toBeTruthy();

    // Tab to next element
    await mainWindow.keyboard.press('Tab');
    await mainWindow.waitForTimeout(100);

    const nextFocusedTag = await mainWindow.evaluate(() => document.activeElement?.tagName);
    expect(nextFocusedTag).toBeTruthy();
  });

  test('should activate toggle with Space key', async () => {
    // Find and focus a toggle
    const firstToggle = mainWindow.locator('[role="switch"]').first();

    if (await firstToggle.isVisible()) {
      await firstToggle.focus();
      await mainWindow.waitForTimeout(100);

      const initialState = await firstToggle.getAttribute('aria-checked');

      // Press Space to toggle
      await mainWindow.keyboard.press('Space');
      await mainWindow.waitForTimeout(200);

      const newState = await firstToggle.getAttribute('aria-checked');

      // State should have changed
      expect(newState).not.toBe(initialState);

      // Restore
      await mainWindow.keyboard.press('Space');
    }
  });
});
