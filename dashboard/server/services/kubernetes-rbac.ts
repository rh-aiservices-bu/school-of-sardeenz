import { existsSync, readFileSync } from 'node:fs';
import type { Config } from '../config.js';

const SERVICE_ACCOUNT_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const MARKER_API_GROUP = 'sardeenz.rh-aiservices-bu.io';

function serviceAccountToken(config: Config): string {
  if (config.serviceAccountToken) return config.serviceAccountToken;

  const path = config.serviceAccountTokenPath || SERVICE_ACCOUNT_TOKEN_PATH;
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (token) return token;
  }

  throw new Error(
    'ServiceAccount token not found. Set SERVICE_ACCOUNT_TOKEN or mount the Kubernetes ServiceAccount token.',
  );
}

async function hasMarkerRole(
  config: Config,
  username: string,
  groups: string[],
  resource: 'admin' | 'admin-readonly',
): Promise<boolean> {
  const response = await fetch(
    `${config.k8sApiUrl}/apis/authorization.k8s.io/v1/namespaces/${config.namespace}/localsubjectaccessreviews`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceAccountToken(config)}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'LocalSubjectAccessReview',
        metadata: { namespace: config.namespace },
        spec: {
          user: username,
          groups,
          resourceAttributes: {
            namespace: config.namespace,
            group: MARKER_API_GROUP,
            resource,
            verb: 'get',
          },
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`LocalSubjectAccessReview failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { status?: { allowed?: boolean } };
  return body.status?.allowed === true;
}

/** Resolve Sardeenz roles using the same namespace-scoped marker Roles as v1. */
export async function resolveSardeenzRoles(
  config: Config,
  username: string,
  groups: string[],
): Promise<Array<'admin' | 'admin-readonly'>> {
  const roles: Array<'admin' | 'admin-readonly'> = [];
  if (await hasMarkerRole(config, username, groups, 'admin')) roles.push('admin');
  if (await hasMarkerRole(config, username, groups, 'admin-readonly')) roles.push('admin-readonly');
  return roles;
}
