import { describe, it, expect } from 'vitest';
import type { ControlPlaneComponents } from '@sardeenz/types';
import { openaiBaseUrl, oipBaseUrl, buildChatCurl, buildV2InferCurl, runnerProtocol } from '../../utils/inference';

type CatalogItem = ControlPlaneComponents['schemas']['CatalogItem'];

describe('openaiBaseUrl', () => {
  it('appends /openai/v1 to a bare base URL', () => {
    expect(openaiBaseUrl('http://localhost:8080')).toBe('http://localhost:8080/openai/v1');
  });

  it('trims a trailing slash before appending /openai/v1', () => {
    expect(openaiBaseUrl('http://localhost:8080/')).toBe('http://localhost:8080/openai/v1');
  });

  it('does not double an already-present /openai/v1', () => {
    expect(openaiBaseUrl('http://localhost:8080/openai/v1')).toBe('http://localhost:8080/openai/v1');
  });

  it('does not double /openai/v1 when the base URL has a trailing slash after it', () => {
    expect(openaiBaseUrl('http://localhost:8080/openai/v1/')).toBe('http://localhost:8080/openai/v1');
  });
});

describe('oipBaseUrl', () => {
  it('appends /oip to a bare base URL', () => {
    expect(oipBaseUrl('http://localhost:8080')).toBe('http://localhost:8080/oip');
  });

  it('does not double an already-present /oip', () => {
    expect(oipBaseUrl('http://localhost:8080/oip')).toBe('http://localhost:8080/oip');
  });

  it('trims a trailing slash', () => {
    expect(oipBaseUrl('http://localhost:8080/oip/')).toBe('http://localhost:8080/oip');
  });
});

describe('buildChatCurl', () => {
  it('builds a curl snippet with the /openai/v1/chat/completions URL and the routing name', () => {
    const curl = buildChatCurl('http://localhost:8080', 'llama-3-8b');
    expect(curl).toContain('http://localhost:8080/openai/v1/chat/completions');
    expect(curl).toContain('"model":"llama-3-8b"');
    expect(curl.startsWith('curl ')).toBe(true);
  });
});

describe('buildV2InferCurl', () => {
  it('builds a curl snippet with the /oip/v2/models/{name}/infer URL and an inputs body', () => {
    const curl = buildV2InferCurl('http://localhost:8080', 'iris');
    expect(curl).toContain('http://localhost:8080/oip/v2/models/iris/infer');
    expect(curl).toContain('"inputs"');
    expect(curl.startsWith('curl ')).toBe(true);
  });

  it('URL-encodes a slashed model name', () => {
    const curl = buildV2InferCurl('http://localhost:8080', 'org/model');
    expect(curl).toContain('/oip/v2/models/org%2Fmodel/infer');
  });
});

function catalogItem(runnerType: string, protocol: 'openai' | 'oip'): CatalogItem {
  return {
    entry: {
      id: runnerType,
      title: runnerType,
      description: '',
      runnerType,
      version: '1',
      image: 'oras://x',
      sifName: runnerType,
      protocol: protocol as CatalogItem['entry']['protocol'],
      maxTensorParallelism: 1,
      kvCacheElasticSharing: false,
    },
    status: { id: runnerType, state: 'IMPORTED' as CatalogItem['status']['state'] },
    updateAvailable: false,
  };
}

describe('runnerProtocol', () => {
  it('resolves oip for a runnerType whose catalog entry is oip', () => {
    const catalog = [catalogItem('mlserver', 'oip'), catalogItem('vllm', 'openai')];
    expect(runnerProtocol('mlserver', catalog)).toBe('oip');
  });

  it('resolves openai for a runnerType whose catalog entry is openai', () => {
    const catalog = [catalogItem('vllm', 'openai')];
    expect(runnerProtocol('vllm', catalog)).toBe('openai');
  });

  it('defaults to openai for an unknown runnerType', () => {
    const catalog = [catalogItem('vllm', 'openai')];
    expect(runnerProtocol('triton', catalog)).toBe('openai');
  });

  it('defaults to openai when the catalog is undefined', () => {
    expect(runnerProtocol('mlserver', undefined)).toBe('openai');
  });
});
