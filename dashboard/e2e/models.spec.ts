import { test, expect } from '@playwright/test';

test.describe('Model Management', () => {
  test('model list page loads', async ({ page }) => {
    await page.goto('/models');
    // Should show either a model table or empty state
    const hasTable = await page.locator('table').count();
    const hasEmptyState = await page.getByText('No models deployed').count();
    expect(hasTable + hasEmptyState).toBeGreaterThan(0);
  });

  test('deploy form navigates from model list', async ({ page }) => {
    await page.goto('/models');
    // Click deploy button (either in toolbar or empty state)
    const deployButton = page.getByRole('link', { name: /deploy/i }).or(
      page.getByRole('button', { name: /deploy/i })
    );
    if (await deployButton.count() > 0) {
      await deployButton.first().click();
      await expect(page).toHaveURL('/models/deploy');
    }
  });

  test('deploy form has required fields', async ({ page }) => {
    await page.goto('/models/deploy');
    await expect(page.getByLabel(/model name/i)).toBeVisible();
    await expect(page.getByLabel(/runner type/i)).toBeVisible();
    await expect(page.getByLabel(/model path/i)).toBeVisible();
    await expect(page.getByLabel(/required memory/i)).toBeVisible();
  });

  test('deploy form validates required fields on submit', async ({ page }) => {
    await page.goto('/models/deploy');
    // Try to submit empty form
    await page.getByRole('button', { name: /deploy/i }).click();
    // Should show validation errors
    await expect(page.getByText(/required/i).first()).toBeVisible();
  });

  test('deploy form cancel returns to model list', async ({ page }) => {
    await page.goto('/models/deploy');
    await page.getByRole('button', { name: /cancel/i }).click();
    await expect(page).toHaveURL('/models');
  });
});
