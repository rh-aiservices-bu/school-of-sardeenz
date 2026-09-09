import { test, expect, bffUrl } from './fixtures.js';

test.describe('Runner Catalog', () => {
  test('shows catalog freshness, image digest, and digest update state', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setCatalog({
      source: 'mock://runners.yaml',
      fetchedAt: '2026-09-09T08:00:00Z',
      runners: [
        {
          entry: {
            id: 'vllm-0.21',
            title: 'vLLM 0.21',
            description: 'vLLM reference runner (mock).',
            engine: 'vLLM',
            runnerType: 'vllm',
            version: '0.21',
            image:
              'oras://quay.io/example/vllm@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
            sifName: 'vllm-0.21',
            protocol: 'openai',
          },
          status: { id: 'vllm-0.21', state: 'IMPORTED' },
          updateAvailable: true,
        },
      ],
      unmanagedModules: [],
    });

    await page.goto(bffUrl(bffPort, '/catalog'));

    await expect(page.getByText(/Fetched at:/)).toBeVisible();
    await expect(page.getByText('Image digest: abcdef')).toBeVisible();
    await expect(page.getByText('Update available')).toBeVisible();
  });

  test('Refresh sends a POST and displays the returned fetch time', async ({ page, bffPort }) => {
    await page.goto(bffUrl(bffPort, '/catalog'));
    await expect(page.getByText(/Fetched at:/)).toBeVisible();

    const refreshRequest = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/catalog/refresh'),
    );
    await page.getByRole('button', { name: 'Refresh' }).click();
    await refreshRequest;

    await expect(page.getByText(/Fetched at:/)).toBeVisible();
  });
});
