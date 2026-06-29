import { test, expect, bffUrl } from './fixtures.js';
import { MockPrometheus } from './mocks/prometheus.js';

test.describe('Metrics Dashboard', () => {
  test.describe('Page structure', () => {
    test('metrics page renders heading', async ({ page, bffPort }) => {
      await page.goto(bffUrl(bffPort, '/metrics'));

      await expect(
        page
          .getByRole('heading', { name: 'Metrics' })
          .or(page.locator('h1').filter({ hasText: 'Metrics' })),
      ).toBeVisible();
    });

    test('shows time range selector with all options', async ({ page, bffPort }) => {
      await page.goto(bffUrl(bffPort, '/metrics'));

      await expect(page.getByRole('button', { name: '15m' })).toBeVisible();
      await expect(page.getByRole('button', { name: '1h' })).toBeVisible();
      await expect(page.getByRole('button', { name: '6h' })).toBeVisible();
      await expect(page.getByRole('button', { name: '24h' })).toBeVisible();
      await expect(page.getByRole('button', { name: '7d' })).toBeVisible();
    });

    test('1h time range is selected by default', async ({ page, bffPort }) => {
      await page.goto(bffUrl(bffPort, '/metrics'));

      const btn1h = page.getByRole('button', { name: '1h' });
      await expect(btn1h).toHaveAttribute('aria-pressed', 'true');
    });

    test('can switch to 6h time range', async ({ page, bffPort }) => {
      await page.goto(bffUrl(bffPort, '/metrics'));

      await page.getByRole('button', { name: '6h' }).click();
      await expect(page.getByRole('button', { name: '6h' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      // Previous selection should no longer be active
      await expect(page.getByRole('button', { name: '1h' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    test('auto-refresh switch is visible and on by default', async ({ page, bffPort }) => {
      await page.goto(bffUrl(bffPort, '/metrics'));

      const autoRefreshSwitch = page.locator('#auto-refresh-switch');
      await expect(autoRefreshSwitch).toBeVisible();
      await expect(autoRefreshSwitch).toBeChecked();
    });

    test('can toggle auto-refresh off', async ({ page, bffPort }) => {
      await page.goto(bffUrl(bffPort, '/metrics'));

      const autoRefreshSwitch = page.locator('#auto-refresh-switch');
      await autoRefreshSwitch.click();
      await expect(autoRefreshSwitch).not.toBeChecked();
    });
  });

  test.describe('Empty state (no Prometheus data)', () => {
    test('shows empty state when Prometheus returns no results', async ({
      page,
      bffPort,
      mockPrometheus,
    }) => {
      // Default state: Prometheus returns empty results
      mockPrometheus.reset();

      await page.goto(bffUrl(bffPort, '/metrics'));

      // At least one empty state should be visible for charts with no data
      await expect(page.getByText('No metrics data available').first()).toBeVisible();
    });
  });

  test.describe('With Prometheus data', () => {
    test('renders chart sections when Prometheus returns latency data', async ({
      page,
      bffPort,
      mockPrometheus,
    }) => {
      mockPrometheus.setRangeFactory(
        MockPrometheus.latencyRangeFactory(['meta-llama/Llama-3.1-8B-Instruct']),
      );

      await page.goto(bffUrl(bffPort, '/metrics'));

      // Chart card titles should be present
      await expect(page.getByText('Request Latency (p50 / p95 / p99)')).toBeVisible();
      await expect(page.getByText('Request Throughput')).toBeVisible();
    });

    test('memory section renders when instant data available', async ({
      page,
      bffPort,
      mockPrometheus,
    }) => {
      mockPrometheus.setInstantFactory(
        MockPrometheus.memoryInstantFactory([
          { label: 'GPU 0', bytes: 24 * 1024 ** 3 },
          { label: 'GPU 1', bytes: 20 * 1024 ** 3 },
        ]),
      );

      await page.goto(bffUrl(bffPort, '/metrics'));

      await expect(page.getByText('Device Memory (Current)')).toBeVisible();
    });
  });

  test.describe('Error state', () => {
    test('shows empty state when Prometheus is unreachable', async ({
      page,
      bffPort,
      mockPrometheus,
    }) => {
      mockPrometheus.setErrorMode(true);

      await page.goto(bffUrl(bffPort, '/metrics'));

      // Charts should show empty state / error state
      await expect(page.getByText('No metrics data available').first()).toBeVisible();
    });
  });
});
