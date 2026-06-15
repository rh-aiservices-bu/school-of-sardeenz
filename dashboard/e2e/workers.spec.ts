import { test, expect } from '@playwright/test';

test.describe('Workers', () => {
  test('worker list page loads', async ({ page }) => {
    await page.goto('/workers');
    // Should show either a worker table or empty state
    const hasTable = await page.locator('table').count();
    const hasEmptyState = await page.getByText('No workers').count();
    expect(hasTable + hasEmptyState).toBeGreaterThan(0);
  });
});
