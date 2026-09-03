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

      await expect(page.getByRole('grid', { name: 'Models' })).toBeVisible();
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

      await expect(page.getByRole('button', { name: 'Deploy Model' }).first()).toBeVisible();
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

    test('model row shows the instances count column', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([{ ...ACTIVE_MODEL, instanceCount: 2 }]);

      await page.goto(bffUrl(bffPort, '/models'));

      await expect(page.getByRole('grid', { name: 'Models' })).toBeVisible();
      // Instances column renders a link with the pluralized count (models.json list.instances.count).
      await expect(page.getByRole('link', { name: '2 instance(s)' })).toBeVisible();
    });

    test('Add instance action increments the model instance count', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([ACTIVE_MODEL]); // auto-derives 1 instance

      await page.goto(bffUrl(bffPort, '/models'));
      await expect(page.getByRole('link', { name: '1 instance(s)' })).toBeVisible();

      await page.locator(`button[aria-label="Actions for ${ACTIVE_MODEL.modelName}"]`).click();
      await page.getByRole('menuitem', { name: 'Add instance' }).click();

      // POST /instances -> 202, mutation invalidates ['models'] -> refetch shows the new count.
      await expect(page.getByRole('link', { name: '2 instance(s)' })).toBeVisible({
        timeout: 5_000,
      });
    });
  });

  test.describe('Deploy Form', () => {
    test('deploy form has model name field', async ({ page, bffPort }) => {
      await page.goto(bffUrl(bffPort, '/models/deploy'));
      // #model-name, not getByLabel — "Served Model Name" (ADR-020) is a substring superset of
      // "Model Name", and the required-field "*" suffix in the accessible name defeats exact
      // matching too, so an id locator is the unambiguous choice here.
      await expect(page.locator('#model-name')).toBeVisible();
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

      await page.locator('#model-name').fill('test-model/7b');
      await page.getByLabel('Model Path').fill('/models/test-model/7b');
      await page.getByLabel('Required Memory (GiB)').fill('8');

      await page.locator('#runtime-module').selectOption('vllm-0.21');

      await page.getByRole('button', { name: 'Deploy' }).click();

      // Deploy opens the launch-logs modal; navigation happens on close.
      await page.getByRole('button', { name: 'Close' }).last().click();

      // After successful deployment, the BFF posts to the mock CP which returns 201,
      // then closing the launch-logs modal navigates to the model detail page.
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
      await expect(page.getByRole('link', { name: ACTIVE_MODEL.modelName })).not.toBeVisible({
        timeout: 5_000,
      });
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
      await expect(page.getByText('Stopped', { exact: true })).not.toBeVisible({
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

      await expect(
        page.getByRole('heading', { level: 1, name: ACTIVE_MODEL.modelName }),
      ).toBeVisible();
    });
  });

  test.describe('Model Detail — Instances (#120)', () => {
    test('detail page shows the per-instance table with a row per instance', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([ACTIVE_MODEL]);
      mockControlPlane.setInstances(ACTIVE_MODEL.modelName, [
        { instanceId: 'inst-alpha', state: 'ACTIVE', workerId: 'worker-a1b2' },
        { instanceId: 'inst-beta', state: 'SLEEPING' },
      ]);

      const encodedName = encodeURIComponent(ACTIVE_MODEL.modelName);
      await page.goto(bffUrl(bffPort, `/models/${encodedName}`));

      await expect(page.getByRole('heading', { level: 2, name: 'Instances' })).toBeVisible();
      const instancesGrid = page.getByRole('grid', { name: 'Instances' });
      await expect(instancesGrid).toBeVisible();
      await expect(instancesGrid.getByText('inst-alpha')).toBeVisible();
      await expect(instancesGrid.getByText('inst-beta')).toBeVisible();
      // Header row + 2 instance rows.
      await expect(instancesGrid.getByRole('row')).toHaveCount(3);
    });

    test('Add instance button on the detail page adds an instance row', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([ACTIVE_MODEL]); // auto-derives 1 instance
      mockControlPlane.setWorkers([]);

      const encodedName = encodeURIComponent(ACTIVE_MODEL.modelName);
      await page.goto(bffUrl(bffPort, `/models/${encodedName}`));

      const instancesGrid = page.getByRole('grid', { name: 'Instances' });
      await expect(instancesGrid.getByRole('row')).toHaveCount(2); // header + 1

      await page.getByRole('button', { name: 'Add instance' }).click();

      await expect(instancesGrid.getByRole('row')).toHaveCount(3, { timeout: 5_000 }); // header + 2
    });
  });

  test.describe('Display Name', () => {
    test('deploying with a display name shows it primary in the list and detail header, with modelName as the secondary identifier', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setModels([]);

      await page.goto(bffUrl(bffPort, '/models/deploy'));

      await page.getByLabel('Display Name').fill('Qwen test 1');
      await page.locator('#model-name').fill('test-model/displayname');
      await page.getByLabel('Model Path').fill('/models/test-model/displayname');
      await page.getByLabel('Required Memory (GiB)').fill('8');

      await page.locator('#runtime-module').selectOption('vllm-0.21');

      await page.getByRole('button', { name: 'Deploy' }).click();

      await page.getByRole('button', { name: 'Close' }).last().click();

      await expect(page).toHaveURL(/\/models\/test-model/, { timeout: 10_000 });

      // Detail header shows the display name; modelName still appears (subtitle + breadcrumb).
      await expect(page.getByRole('heading', { name: 'Qwen test 1' })).toBeVisible();
      await expect(page.getByText('test-model/displayname').first()).toBeVisible();

      // List shows the display name as the primary/linked text, modelName as a secondary line.
      await page.goto(bffUrl(bffPort, '/models'));
      await expect(page.getByRole('link', { name: 'Qwen test 1' })).toBeVisible();
      await expect(page.getByText('test-model/displayname')).toBeVisible();
    });
  });
});
