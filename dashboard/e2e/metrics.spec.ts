import { test, expect } from '@playwright/test';

test.describe('Metrics Dashboard', () => {
  test('metrics page loads with time range selector', async ({ page }) => {
    await page.goto('/metrics');
    await expect(page.getByText('Metrics')).toBeVisible();
    // Time range toggle should be present
    await expect(page.getByText('15m')).toBeVisible();
    await expect(page.getByText('1h')).toBeVisible();
    await expect(page.getByText('6h')).toBeVisible();
    await expect(page.getByText('24h')).toBeVisible();
  });

  test('can switch time range', async ({ page }) => {
    await page.goto('/metrics');
    const button6h = page.getByRole('button', { name: '6h' });
    await button6h.click();
    // The button should be selected (pressed)
    await expect(button6h).toHaveAttribute('aria-pressed', 'true');
  });
});
