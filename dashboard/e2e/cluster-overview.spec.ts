import { test, expect } from '@playwright/test';

test.describe('Cluster Overview', () => {
  test('shows summary cards', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Workers')).toBeVisible();
    await expect(page.getByText('Models')).toBeVisible();
    await expect(page.getByText('GPU Memory')).toBeVisible();
    await expect(page.getByText('Alerts')).toBeVisible();
  });

  test('shows VRAM usage section', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('VRAM Usage')).toBeVisible();
  });

  test('shows model state breakdown', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Model State Breakdown')).toBeVisible();
  });

  test('shows recent events section', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Recent Events')).toBeVisible();
  });
});
