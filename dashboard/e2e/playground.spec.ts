/**
 * Chatbot Playground E2E (v1-parity workspace): sidebar grouping, sessions, layouts, streaming
 * and non-streaming chat through the BFF against a tiny OpenAI-compatible mock inference server.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, bffUrl } from './fixtures.js';
import type { MockClusterMemory, MockModelInfo } from './mocks/control-plane.js';

const REPLY_WORDS = ['The ', 'sky ', 'is ', 'blue ', 'because ', 'of ', 'Rayleigh ', 'scattering.'];
const REPLY = REPLY_WORDS.join('');

let inference: Server;
/** Bodies received by the mock inference server, oldest first. */
const receivedBodies: Record<string, unknown>[] = [];

test.beforeAll(async () => {
  inference = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      receivedBodies.push(body);

      if (body['stream'] === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: REPLY_WORDS.length },
          }),
        );
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let i = 0;
      const timer = setInterval(() => {
        if (i < REPLY_WORDS.length) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: REPLY_WORDS[i] } }] })}\n\n`,
          );
          i += 1;
          return;
        }
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
      }, 20);
      res.on('close', () => clearInterval(timer));
    });
  });
  await new Promise<void>((resolve) => inference.listen(0, '127.0.0.1', resolve));
  const { port } = inference.address() as AddressInfo;
  // The BFF fixture spawns with process.env, so this is picked up by every test's BFF.
  process.env['SARDEENZ_INFERENCE_URL'] = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => inference.close(() => resolve()));
});

const LLAMA: MockModelInfo = {
  modelName: 'llama-8b',
  displayName: 'Llama 3.1 8B',
  state: 'ACTIVE',
  runnerType: 'vllm',
  requiredMemory: 16 * 1024 ** 3,
  currentMemory: 15 * 1024 ** 3,
  workerId: 'worker-a',
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
};

const MISTRAL: MockModelInfo = {
  modelName: 'mistral-7b',
  state: 'SLEEPING',
  runnerType: 'vllm',
  requiredMemory: 8 * 1024 ** 3,
  workerId: 'worker-a',
  createdAt: new Date(Date.now() - 7200_000).toISOString(),
};

const STOPPED: MockModelInfo = {
  modelName: 'stopped-model',
  state: 'STOPPED',
  runnerType: 'vllm',
  requiredMemory: 8 * 1024 ** 3,
  createdAt: new Date(Date.now() - 7200_000).toISOString(),
};

const device = (deviceIndex: number) => ({
  deviceIndex,
  deviceType: 'cuda',
  memoryTotalBytes: 24 * 1024 ** 3,
  memoryUsedBytes: 15 * 1024 ** 3,
  memoryAvailableBytes: 9 * 1024 ** 3,
});

const MEMORY: MockClusterMemory = {
  workers: [
    {
      workerId: 'worker-a',
      devices: [device(0), device(1)],
      models: [
        { modelName: 'llama-8b', displayName: 'Llama 3.1 8B', state: 'ACTIVE', deviceIndices: [0] },
        { modelName: 'mistral-7b', state: 'SLEEPING', deviceIndices: [1] },
      ],
    },
  ],
  summary: {
    totalBytes: 48 * 1024 ** 3,
    usedBytes: 15 * 1024 ** 3,
    availableBytes: 33 * 1024 ** 3,
  },
};

const shots = 'test-results/playground-shots';

test.describe('Chatbot Playground', () => {
  test.beforeEach(({ mockControlPlane }) => {
    receivedBodies.length = 0;
    mockControlPlane.setModels([LLAMA, MISTRAL, STOPPED]);
    mockControlPlane.setClusterMemory(MEMORY);
  });

  test('sidebar lists chattable models grouped by GPU with an empty workspace', async ({
    page,
    bffPort,
  }) => {
    await page.goto(bffUrl(bffPort, '/playground'));

    await expect(page.getByRole('heading', { name: 'Chatbot Playground', level: 1 })).toBeVisible();
    const sidebar = page.getByRole('region', { name: 'Model list' });
    await expect(sidebar.getByText('2 available')).toBeVisible();
    await expect(sidebar.getByText('GPU 0')).toBeVisible();
    await expect(sidebar.getByText('GPU 1')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: /Llama 3.1 8B/ })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: /mistral-7b/ })).toBeVisible();
    await expect(sidebar.getByText('Sleeping')).toBeVisible();
    await expect(sidebar.getByText('stopped-model')).toHaveCount(0);

    await expect(page.getByRole('heading', { name: 'No sessions open' })).toBeVisible();
    await page.screenshot({ path: `${shots}/01-empty.png`, fullPage: true });
  });

  test('opens a session, streams a reply with metrics, and shows the Open badge', async ({
    page,
    bffPort,
  }) => {
    await page.goto(bffUrl(bffPort, '/playground'));
    const sidebar = page.getByRole('region', { name: 'Model list' });
    await sidebar.getByRole('button', { name: /Llama 3.1 8B/ }).click();

    await expect(page.getByRole('tab', { name: 'Llama 3.1 8B tab' })).toBeVisible();
    await expect(sidebar.getByText('Open')).toBeVisible();
    await expect(page.getByText('Chat with Llama 3.1 8B')).toBeVisible();

    const input = page.getByRole('textbox', { name: /prompt|message/i }).first();
    await expect(input).toHaveValue('Why is the sky blue?');
    await page.screenshot({ path: `${shots}/02-session-welcome.png`, fullPage: true });

    await page.getByRole('button', { name: /send/i }).first().click();
    await expect(page.getByText(REPLY)).toBeVisible();
    await expect(page.getByText(/TTFT: \d+ms/)).toBeVisible();
    await expect(page.getByText(/tok\/s/)).toBeVisible();
    await expect(input).toHaveValue('');
    await page.screenshot({ path: `${shots}/03-streamed-reply.png`, fullPage: true });

    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0]).toMatchObject({
      model: 'llama-8b',
      stream: true,
      max_tokens: 512,
      temperature: 0.7,
      messages: [{ role: 'user', content: 'Why is the sky blue?' }],
    });

    // Clear wipes the transcript and brings the welcome prompt back.
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByText('Chat with Llama 3.1 8B')).toBeVisible();
  });

  test('non-streaming turn goes through stream:false and renders the JSON reply', async ({
    page,
    bffPort,
  }) => {
    await page.goto(bffUrl(bffPort, '/playground'));
    await page.getByRole('button', { name: /Llama 3.1 8B/ }).click();
    await page.getByRole('checkbox', { name: 'Streaming' }).uncheck();
    await page.getByRole('button', { name: /send/i }).first().click();

    await expect(page.getByText(REPLY)).toBeVisible();
    expect(receivedBodies[0]).toMatchObject({ stream: false });
    await expect(page.getByText(/TTFT/)).toHaveCount(0);
  });

  test('split layout shows two sessions side by side and tabs switch/close them', async ({
    page,
    bffPort,
  }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(bffUrl(bffPort, '/playground'));
    const sidebar = page.getByRole('region', { name: 'Model list' });
    await sidebar.getByRole('button', { name: /Llama 3.1 8B/ }).click();
    await sidebar.getByRole('button', { name: /mistral-7b/ }).click();

    await expect(page.getByRole('tab', { name: 'Llama 3.1 8B tab' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'mistral-7b tab' })).toBeVisible();
    // Single layout: the newest session is active and the only pane.
    await expect(page.getByText('Chat with mistral-7b')).toBeVisible();
    await expect(page.getByText('Chat with Llama 3.1 8B')).toHaveCount(0);

    await page.getByRole('button', { name: 'Split view (2 models)' }).click();
    await expect(page.getByText('Chat with Llama 3.1 8B')).toBeVisible();
    await expect(page.getByText('Chat with mistral-7b')).toBeVisible();
    await page.screenshot({ path: `${shots}/04-split.png`, fullPage: true });

    await page.getByRole('button', { name: 'Single view' }).click();
    await page.getByRole('tab', { name: 'Llama 3.1 8B tab' }).click();
    await expect(page.getByText('Chat with Llama 3.1 8B')).toBeVisible();

    await page.getByRole('button', { name: 'Close Llama 3.1 8B' }).click();
    await expect(page.getByRole('tab', { name: 'Llama 3.1 8B tab' })).toHaveCount(0);
    await expect(page.getByText('Chat with mistral-7b')).toBeVisible();
  });

  test('sessions survive navigating away and a reload; sidebar toggle and close-all work', async ({
    page,
    bffPort,
  }) => {
    await page.goto(bffUrl(bffPort, '/playground'));
    await page.getByRole('button', { name: /Llama 3.1 8B/ }).click();
    await expect(page.getByRole('tab', { name: 'Llama 3.1 8B tab' })).toBeVisible();

    await page.locator('nav').getByText('Models', { exact: true }).click();
    await expect(page).toHaveURL(/\/models$/);
    await page.locator('nav').getByText('Playground', { exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Llama 3.1 8B tab' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('tab', { name: 'Llama 3.1 8B tab' })).toBeVisible();

    await page.getByRole('button', { name: 'Hide sidebar' }).click();
    await expect(page.getByRole('region', { name: 'Model list' })).toBeHidden();
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await expect(page.getByRole('region', { name: 'Model list' })).toBeVisible();

    await page.getByRole('button', { name: 'Close all sessions' }).click();
    await expect(page.getByRole('heading', { name: 'No sessions open' })).toBeVisible();
  });
});
