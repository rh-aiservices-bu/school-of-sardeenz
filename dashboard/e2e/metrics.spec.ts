import { test, expect, bffUrl } from './fixtures.js';
import { MockPrometheus } from './mocks/prometheus.js';

test.describe('Metrics Dashboard', () => {
  test.describe('Page structure', () => {
    test('metrics page renders heading', async ({ page, bffPort }) => {
      await page.goto(bffUrl(bffPort, '/metrics'));

      // getByRole name matching is a case-insensitive substring by default, so an unscoped
      // { name: 'Metrics' } also matches the "No metrics data available" empty-state headings
      // once charts with no data render — a strict-mode violation that only appears after those
      // headings mount. Require an exact, level-1 heading match to pin it to the page title.
      await expect(
        page.getByRole('heading', { name: 'Metrics', level: 1, exact: true }),
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
      await page.locator('#auto-refresh-switch-label').click();
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

      // Chart card titles should be present. Scope to the PatternFly card title element:
      // once the Victory chart mounts, it renders an SVG <title>/<desc> with the same text
      // (ariaTitle/ariaDesc), so an unscoped getByText() becomes a strict-mode violation
      // (3 matches) as soon as the chart finishes rendering.
      await expect(
        page.locator('.pf-v6-c-card__title').filter({ hasText: 'Request Latency (p50 / p95 / p99)' }),
      ).toBeVisible();
      await expect(
        page.locator('.pf-v6-c-card__title').filter({ hasText: 'Request Throughput' }),
      ).toBeVisible();
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

      await expect(
        page.locator('.pf-v6-c-card__title').filter({ hasText: 'Device Memory (Current)' }),
      ).toBeVisible();
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

      // Charts should show empty state / error state. All ten chart queries retry through
      // React Query's default backoff (3 retries, up to ~7s of delay) before settling into the
      // error state, which can exceed Playwright's 8s default assertion timeout under load —
      // give this one enough headroom to observe the deterministic end state rather than racing it.
      await expect(page.getByText('No metrics data available').first()).toBeVisible({
        timeout: 15_000,
      });
    });
  });
});
