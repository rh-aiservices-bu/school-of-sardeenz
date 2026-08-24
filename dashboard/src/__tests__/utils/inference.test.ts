import { describe, it, expect } from 'vitest';
import { openaiBaseUrl, buildChatCurl } from '../../utils/inference';

describe('openaiBaseUrl', () => {
  it('appends /v1 to a bare base URL', () => {
    expect(openaiBaseUrl('http://localhost:8080')).toBe('http://localhost:8080/v1');
  });

  it('trims a trailing slash before appending /v1', () => {
    expect(openaiBaseUrl('http://localhost:8080/')).toBe('http://localhost:8080/v1');
  });

  it('does not double an already-present /v1', () => {
    expect(openaiBaseUrl('http://localhost:8080/v1')).toBe('http://localhost:8080/v1');
  });

  it('does not double /v1 when the base URL has a trailing slash after it', () => {
    expect(openaiBaseUrl('http://localhost:8080/v1/')).toBe('http://localhost:8080/v1');
  });
});

describe('buildChatCurl', () => {
  it('builds a curl snippet with the /v1/chat/completions URL and the routing name', () => {
    const curl = buildChatCurl('http://localhost:8080', 'llama-3-8b');
    expect(curl).toContain('http://localhost:8080/v1/chat/completions');
    expect(curl).toContain('"model":"llama-3-8b"');
    expect(curl.startsWith('curl ')).toBe(true);
  });
});
