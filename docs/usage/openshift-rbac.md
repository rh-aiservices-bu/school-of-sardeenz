# OpenShift OAuth RBAC

This guide configures Sardeenz dashboard access through OpenShift OAuth and Kubernetes-native,
namespace-scoped RBAC. It matches the Sardeenz v1 authorization model: users and groups receive
Sardeenz roles through ordinary RoleBindings, without receiving unrelated workload permissions.

## How authorization works

After OpenShift authenticates a user, the dashboard reads their username and groups from the
OpenShift Kubernetes API. Its
`sardeenz-dashboard` ServiceAccount submits a `LocalSubjectAccessReview` in the Sardeenz
namespace for each marker permission:

| Marker Role               | Checked permission                                | Dashboard access           |
| ------------------------- | ------------------------------------------------- | -------------------------- |
| `sardeenz-admin`          | `get admin.sardeenz.rh-aiservices-bu.io`          | Full administration        |
| `sardeenz-admin-readonly` | `get admin-readonly.sardeenz.rh-aiservices-bu.io` | Read-only dashboard access |

The marker resources do not exist and do not grant access to Pods, Secrets, or other Kubernetes
resources. A user with neither permission is denied login. `admin` also satisfies all
read-only dashboard routes.

The dashboard Kustomize base creates the ServiceAccount, both marker Roles, and the
`sardeenz-auth-reviewer` RoleBinding that permits the ServiceAccount to submit the reviews.
Operators only create bindings that assign the marker roles to users or groups.

## Prerequisites

- An OpenShift cluster with an OAuth identity provider.
- Permission to create the dashboard OAuth client and namespace RoleBindings.
- A current Sardeenz dashboard image and manifests, including `deployment/dashboard/rbac.yaml`.
- A TLS Route for the dashboard's public URL.

## Configure the OAuth client and dashboard secret

Create an OpenShift OAuth client. Its callback must exactly match the dashboard's public Route:

```yaml
apiVersion: oauth.openshift.io/v1
kind: OAuthClient
metadata:
  name: sardeenz
secret: <generate-a-random-client-secret>
redirectURIs:
  - https://sardeenz.apps.example.com/api/auth/callback
grantMethod: auto
```

Create or update the dashboard authentication Secret. Do not put any of these values in a Git
repository or a checked-in manifest.

```bash
oc -n sardeenz create secret generic sardeenz-dashboard-auth \
  --from-literal=AUTH_MODE=oauth \
  --from-literal=OAUTH_CLIENT_ID=sardeenz \
  --from-literal=OAUTH_CLIENT_SECRET='<OAuthClient secret>' \
  --from-literal=OAUTH_ISSUER_URL='https://oauth-openshift.apps.example.com/oauth' \
  --from-literal=SARDEENZ_PUBLIC_URL='https://sardeenz.apps.example.com' \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)"
```

If the Secret already exists, use `oc create secret generic ... --dry-run=client -o yaml | oc
apply -f -` rather than deleting it. The `OAUTH_ISSUER_URL` includes `/oauth`, because Sardeenz
appends `/authorize`, `/token`, and `/userinfo`.

## Deploy the dashboard RBAC resources

Apply the dashboard base or your normal overlay. It sets
`K8S_API_URL=https://kubernetes.default.svc`, trusts the projected service CA, and runs the
dashboard as the reviewer ServiceAccount.

```bash
oc apply -k deployment/dashboard/ -n sardeenz
oc rollout status deployment/sardeenz-dashboard -n sardeenz
```

For a custom namespace, apply the overlay that sets that namespace; marker Roles and RoleBindings
must live in the same namespace as the dashboard. Verify the required resources:

```bash
oc get serviceaccount sardeenz-dashboard -n sardeenz
oc get role sardeenz-admin sardeenz-admin-readonly sardeenz-auth-reviewer -n sardeenz
oc get rolebinding sardeenz-auth-reviewer -n sardeenz
```

## Grant access

Grant full administration to a user:

```bash
oc adm policy add-role-to-user sardeenz-admin alice@example.com \
  --role-namespace=sardeenz -n sardeenz
```

Grant full administration to a group:

```bash
oc adm policy add-role-to-group sardeenz-admin platform-admins \
  --role-namespace=sardeenz -n sardeenz
```

Grant read-only access to a group:

```bash
oc adm policy add-role-to-group sardeenz-admin-readonly viewers \
  --role-namespace=sardeenz -n sardeenz
```

To allow every OpenShift-authenticated user read-only access:

```bash
oc adm policy add-role-to-group sardeenz-admin-readonly system:authenticated \
  --role-namespace=sardeenz -n sardeenz
```

`--role-namespace` is required: without it, `oc adm policy` assumes the named role is a
ClusterRole. `-n` alone sets only the RoleBinding namespace.

Cluster administrators match the `sardeenz-admin` marker permission through their wildcard RBAC
rights, so they do not need an additional RoleBinding.

## Verify access

Check a user's effective marker permissions before asking them to sign in:

```bash
oc auth can-i get admin.sardeenz.rh-aiservices-bu.io \
  -n sardeenz --as=alice@example.com
oc auth can-i get admin-readonly.sardeenz.rh-aiservices-bu.io \
  -n sardeenz --as=alice@example.com
```

After changing a binding, sign out and sign in again. Sardeenz puts the resolved role in its own
session JWT, so a current session does not change until the next login.

## Troubleshooting

- **`Access denied` after a successful OpenShift login:** check both `oc auth can-i` commands,
  and confirm the user name and group names reported by the identity provider match the binding.
- **`Kubernetes RBAC role resolution failed`:** confirm the dashboard is using the
  `sardeenz-dashboard` ServiceAccount and that the `sardeenz-auth-reviewer` RoleBinding exists.
  Check that `K8S_API_URL` is set and the projected service CA is available at
  `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`.
- **OAuth callback fails before RBAC:** confirm the OAuth client redirect URI exactly matches
  `<SARDEENZ_PUBLIC_URL>/api/auth/callback` and that the client secret is current.
- **Bindings appear ineffective:** ensure they were created in the Sardeenz namespace, then log
  out and back in to refresh the Sardeenz session.

## Security notes

The reviewer's only Kubernetes permission is to create `LocalSubjectAccessReview` objects in its
own namespace. It cannot create workloads or read Secrets. Keep the dashboard's Kubernetes API
endpoint internal, use a dedicated namespace, and grant marker roles to groups where practical.
