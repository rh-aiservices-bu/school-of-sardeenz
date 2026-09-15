// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSardeenzRoles } from '../../services/kubernetes-rbac.js';
import type { Config } from '../../config.js';

const config = {
  k8sApiUrl: 'https://kubernetes.default.svc',
  namespace: 'sardeenz',
  serviceAccountToken: 'service-account-token',
} as Config;

afterEach(() => vi.unstubAllGlobals());

describe('resolveSardeenzRoles', () => {
  it('uses namespace-scoped marker-role access reviews for the OAuth user and groups', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: { allowed: true } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: { allowed: true } })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveSardeenzRoles(config, 'alice', ['platform-admins'])).resolves.toEqual([
      'admin',
      'admin-readonly',
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0];
    expect(first?.[0]).toBe(
      'https://kubernetes.default.svc/apis/authorization.k8s.io/v1/namespaces/sardeenz/localsubjectaccessreviews',
    );
    expect(first?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer service-account-token' },
    });
    expect(JSON.parse((first?.[1] as RequestInit).body as string)).toMatchObject({
      kind: 'LocalSubjectAccessReview',
      spec: {
        user: 'alice',
        groups: ['platform-admins'],
        resourceAttributes: {
          group: 'sardeenz.rh-aiservices-bu.io',
          resource: 'admin',
          verb: 'get',
        },
      },
    });
  });

  it('rejects an API error rather than silently treating it as read-only access', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 })));

    await expect(resolveSardeenzRoles(config, 'alice', [])).rejects.toThrow(
      'LocalSubjectAccessReview failed: 403 forbidden',
    );
  });
});
