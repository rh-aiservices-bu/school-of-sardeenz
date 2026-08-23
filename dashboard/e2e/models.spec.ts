import { test, expect, bffUrl } from './fixtures.js';
import type { MockModelInfo } from './fixtures.js';

const ACTIVE_MODEL: MockModelInfo = {
  modelName: 'meta-llama/Llama-3.1-8B-Instruct',
  state: 'ACTIVE',
  runnerType: 'vllm',
  requiredMemory: 16 * 1024 ** 3,
  currentMemory: 15 * 1024 ** 3,
  workerId: 'worker-a1b2',
  pinned: false,
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  lastInferenceAt: new Date(Date.now() - 60_000).toISOString(),
};

const SLEEPING_MODEL: MockModelInfo = {
  modelName: 'mistralai/Mistral-7B-Instruct-v0.3',
  state: 'SLEEPING',
  runnerType: 'vllm',
  requiredMemory: 8 * 1024 ** 3,
  currentMemory: 0,
  createdAt: new Date(Date.now() - 7200_000).toISOString(),
};

const STOPPED_MODEL: MockModelInfo = {
  modelName: 'stopped/model',
  state: 'STOPPED',
  runnerType: 'vllm',
  requiredMemory: 8 * 1024 ** 3,
  createdAt: new Date(Date.now() - 7200_000).toISOString(),
};

test.describe('Model Management', () => {
  test.describe('Model List', () => {
    test('renders model table when models exist', async ({ page, bffPort, mockControlPlane }) => {
      mockControlPlane.setModels([ACTIVE_MODEL, SLEEPING_MODEL]);

      await page.goto(bffUrl(bffPort, '/models'));

      await expect(page.locator('table[aria-label="Model list"]')).toBeVisible();
    });

    test('shows model names in the table', async ({ page, bffPort, mockControlPlane }) => {
      mockControlPlane.setModels([ACTIVE_MODEL, SLEEPING_MODEL]);

      await page.goto(bffUrl(bffPort, '/models'));

      await expect(page.getByText(ACTIVE_MODEL.modelName)).toBeVisible();
      await expect(page.getByText(SLEEPING_MODEL.modelName)).toBeVisible();
    });

    test('shows empty state when no models deployed', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([]);

      await page.goto(bffUrl(bffPort, '/models'));

      await expect(page.getByText('No models deployed')).toBeVisible();
    });

    test('shows Deploy Model button in toolbar when models exist', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([ACTIVE_MODEL]);

      await page.goto(bffUrl(bffPort, '/models'));

      await expect(page.getByRole('button', { name: 'Deploy Model' })).toBeVisible();
    });

    test('shows Deploy Model button in empty state', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([]);

      await page.goto(bffUrl(bffPort, '/models'));

      await expect(page.getByRole('button', { name: 'Deploy Model' })).toBeVisible();
    });

    test('Deploy Model button navigates to deploy form', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([ACTIVE_MODEL]);

      await page.goto(bffUrl(bffPort, '/models'));
      await page.getByRole('button', { name: 'Deploy Model' }).click();

      await expect(page).toHaveURL(/\/models\/deploy$/);
    });

    test('clicking model name navigates to model detail', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([ACTIVE_MODEL]);

      await page.goto(bffUrl(bffPort, '/models'));
      await page.getByText(ACTIVE_MODEL.modelName).click();

      await expect(page).toHaveURL(
        new RegExp(`/models/${encodeURIComponent(ACTIVE_MODEL.modelName).replace(/\//g, '%2F')}`),
      );
    });
  });

  test.describe('Deploy Form', () => {
    test('deploy form has model name field', async ({ page, bffPort }) => {
      await page.goto(bffUrl(bffPort, '/models/deploy'));
      await expect(page.getByLabel('Model Name')).toBeVisible();
    });

    test('deploy form has runner type field', async ({ page, bffPort }) => {
      await page.goto(bffUrl(bffPort, '/models/deploy'));
      await expect(page.locator('#runner-type')).toBeVisible();
    });

    test('deploy form has model path field', async ({ page, bffPort }) => {
      await page.goto(bffUrl(bffPort, '/models/deploy'));
      await expect(page.getByLabel('Model Path')).toBeVisible();
    });

    test('deploy form has required memory field', async ({ page, bffPort }) => {
      await page.goto(bffUrl(bffPort, '/models/deploy'));
      await expect(page.getByLabel('Required Memory (GiB)')).toBeVisible();
    });

    test('deploy form shows validation errors on empty submit', async ({ page, bffPort }) => {
      await page.goto(bffUrl(bffPort, '/models/deploy'));

      // Clear required memory field which has a default, and click deploy
      await page.locator('#required-memory').fill('');
      await page.getByRole('button', { name: 'Deploy' }).click();

      // Should show at least one validation error
      await expect(page.getByText('required', { exact: false }).first()).toBeVisible();
    });

    test('deploy form cancel returns to model list', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([]);

      await page.goto(bffUrl(bffPort, '/models/deploy'));
      await page.getByRole('button', { name: 'Cancel' }).click();

      await expect(page).toHaveURL(/\/models$/);
    });

    test('deploy flow: fill form and submit deploys model', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([]);

      await page.goto(bffUrl(bffPort, '/models/deploy'));

      await page.getByLabel('Model Name').fill('test-model/7b');
      await page.getByLabel('Model Path').fill('/models/test-model/7b');
      await page.getByLabel('Required Memory (GiB)').fill('8');

      await page.getByRole('button', { name: 'Deploy' }).click();

      // After successful deployment, the BFF posts to the mock CP which returns 201,
      // then the UI navigates to the model detail page
      await expect(page).toHaveURL(/\/models\/test-model/, { timeout: 10_000 });
    });
  });

  test.describe('Delete Flow', () => {
    test('model row has actions kebab menu', async ({ page, bffPort, mockControlPlane }) => {
      mockControlPlane.setModels([ACTIVE_MODEL]);

      await page.goto(bffUrl(bffPort, '/models'));

      const actionsButton = page.locator(
        `button[aria-label="Actions for ${ACTIVE_MODEL.modelName}"]`,
      );
      await expect(actionsButton).toBeVisible();
    });

    test('delete action shows confirmation modal', async ({ page, bffPort, mockControlPlane }) => {
      mockControlPlane.setModels([ACTIVE_MODEL]);

      await page.goto(bffUrl(bffPort, '/models'));

      // Open kebab menu
      await page.locator(`button[aria-label="Actions for ${ACTIVE_MODEL.modelName}"]`).click();
      // Click Delete
      await page.getByRole('menuitem', { name: 'Delete' }).click();

      // Confirmation modal should appear
      await expect(page.getByText('Delete model?')).toBeVisible();
    });

    test('delete confirmation removes model from list', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([ACTIVE_MODEL, SLEEPING_MODEL]);

      await page.goto(bffUrl(bffPort, '/models'));

      // Open kebab for the first model
      await page.locator(`button[aria-label="Actions for ${ACTIVE_MODEL.modelName}"]`).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();

      // Confirm deletion
      await page.getByRole('button', { name: 'Delete' }).click();

      // The model should no longer appear (BFF proxies DELETE to mock CP)
      await expect(page.getByText(ACTIVE_MODEL.modelName)).not.toBeVisible({ timeout: 5_000 });
    });

    test('cancel on delete modal keeps model in list', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([ACTIVE_MODEL]);

      await page.goto(bffUrl(bffPort, '/models'));

      await page.locator(`button[aria-label="Actions for ${ACTIVE_MODEL.modelName}"]`).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await page.getByRole('button', { name: 'Cancel' }).click();

      // Model should still be visible
      await expect(page.getByText(ACTIVE_MODEL.modelName)).toBeVisible();
    });
  });

  test.describe('Start / Stop Flow', () => {
    test('STOPPED model row offers Start and Delete, not Sleep/Wake', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([STOPPED_MODEL]);

      await page.goto(bffUrl(bffPort, '/models'));

      await page.locator(`button[aria-label="Actions for ${STOPPED_MODEL.modelName}"]`).click();

      await expect(page.getByRole('menuitem', { name: 'Start' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Sleep' })).not.toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Wake' })).not.toBeVisible();
    });

    test('Start action transitions the model out of STOPPED', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([STOPPED_MODEL]);

      await page.goto(bffUrl(bffPort, '/models'));

      await page.locator(`button[aria-label="Actions for ${STOPPED_MODEL.modelName}"]`).click();
      await page.getByRole('menuitem', { name: 'Start' }).click();

      // The mock CP flips the model to STARTING; the row should no longer show STOPPED.
      await expect(page.getByText('Stopped', { exact: false })).not.toBeVisible({
        timeout: 5_000,
      });
    });

    test('ACTIVE model row offers Stop, and Stop opens a confirmation', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([ACTIVE_MODEL]);

      await page.goto(bffUrl(bffPort, '/models'));

      await page.locator(`button[aria-label="Actions for ${ACTIVE_MODEL.modelName}"]`).click();
      await page.getByRole('menuitem', { name: 'Stop' }).click();

      await expect(page.getByText('Stop model?')).toBeVisible();
    });
  });

  test.describe('Model Detail', () => {
    test('model detail page shows model name', async ({ page, bffPort, mockControlPlane }) => {
      mockControlPlane.setModels([ACTIVE_MODEL]);

      const encodedName = encodeURIComponent(ACTIVE_MODEL.modelName);
      await page.goto(bffUrl(bffPort, `/models/${encodedName}`));

      await expect(page.getByText(ACTIVE_MODEL.modelName)).toBeVisible();
    });
  });
});
