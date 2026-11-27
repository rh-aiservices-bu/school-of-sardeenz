// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { redactUrlForLog, reqSerializer, REDACTED } from '../log-redaction.js';

describe('redactUrlForLog', () => {
  it('leaves a URL without a query string untouched', () => {
    expect(redactUrlForLog('/api/models')).toBe('/api/models');
  });

  it('leaves a query string without a token untouched, byte for byte', () => {
    const url = '/api/events?level=warn&since=2026-11-12T00%3A00%3A00Z';
    expect(redactUrlForLog(url)).toBe(url);
  });

  it('replaces the SSE fallback token value', () => {
    expect(redactUrlForLog('/api/events?token=eyJhbGciOi.payload.sig')).toBe(
      `/api/events?token=${encodeURIComponent(REDACTED)}`,
    );
  });

  it('keeps the other query parameters debuggable', () => {
    expect(redactUrlForLog('/api/models/x/logs?follow=1&token=secret')).toBe(
      `/api/models/x/logs?follow=1&token=${encodeURIComponent(REDACTED)}`,
    );
  });

  it('redacts every token occurrence, whatever the key case', () => {
    expect(redactUrlForLog('/api/events?Token=a&token=b&tokens=keep')).toBe(
      `/api/events?Token=${encodeURIComponent(REDACTED)}&token=${encodeURIComponent(REDACTED)}&tokens=keep`,
    );
  });

  it('preserves a fragment that follows the query', () => {
    expect(redactUrlForLog('/api/events?token=secret#frag')).toBe(
      `/api/events?token=${encodeURIComponent(REDACTED)}#frag`,
    );
  });

  it('replaces an OAuth (exchange or authorization) code value', () => {
    expect(redactUrlForLog('/oauth/callback?code=abc')).toBe(
      `/oauth/callback?code=${encodeURIComponent(REDACTED)}`,
    );
  });

  it('redacts the upstream authorization code and keeps the other parameters', () => {
    expect(redactUrlForLog('/api/auth/callback?code=upstream&state=s')).toBe(
      `/api/auth/callback?code=${encodeURIComponent(REDACTED)}&state=s`,
    );
  });

  it('leaves a code-prefixed key untouched (exact-key match)', () => {
    expect(redactUrlForLog('/api/events?codec=keep')).toBe('/api/events?codec=keep');
  });

  it('treats a bare "?" as an empty query', () => {
    expect(redactUrlForLog('/api/events?')).toBe('/api/events?');
  });
});

describe('reqSerializer', () => {
  it('mirrors Fastify’s default request fields with a redacted URL', () => {
    const req = {
      method: 'GET',
      url: '/api/models/a%2Fb/logs?token=secret',
      host: 'bff.test',
      ip: '10.0.0.7',
      socket: { remotePort: 41234 },
      headers: { 'accept-version': '1' },
    } as unknown as FastifyRequest;

    expect(reqSerializer(req)).toEqual({
      method: 'GET',
      url: `/api/models/a%2Fb/logs?token=${encodeURIComponent(REDACTED)}`,
      version: '1',
      host: 'bff.test',
      remoteAddress: '10.0.0.7',
      remotePort: 41234,
    });
  });

  it('survives a request without a socket', () => {
    const req = {
      method: 'POST',
      url: '/api/auth/login',
      host: 'bff.test',
      ip: '10.0.0.7',
      socket: undefined,
      headers: {},
    } as unknown as FastifyRequest;
    expect(reqSerializer(req)).toMatchObject({ url: '/api/auth/login', remotePort: undefined });
  });
});
