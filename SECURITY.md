# Security Policy

## Supported Versions

Fixes land on `dev` and are released from `main` by merging `dev`. Reports are handled against the
current `dev` and the latest tagged release; older tags are not backported.

| Version                             | Supported  |
| ----------------------------------- | ---------- |
| `dev` (branch)                      | Yes        |
| `v0.2.0` (latest tagged release)    | Yes        |
| `0.2.1` (`CHANGELOG.md` entry, untagged) | See note |
| older tags                          | No         |

Note: `CHANGELOG.md` records `0.2.1` (2026-10-29) but no `v0.2.1` tag or GitHub release exists, so
`dev` is the line that carries fixes until that is reconciled.

## Reporting a Vulnerability

**Do not open a public issue, pull request or discussion for a suspected vulnerability.**

1. Open the repository's **Security** tab and choose **Report a vulnerability** (GitHub private
   vulnerability reporting).
2. Describe what you observed, the affected component, the version or commit, the deployment shape
   (OpenShift/Kubernetes or Podman/compose), and the steps or proof of concept.

The report stays private between you and the maintainers until an advisory is published.

## What to Include

- The affected component and the version, tag or commit.
- The deployment shape, and which prerequisites from
  [`docs/usage/deployment-security.md`](docs/usage/deployment-security.md) were in place.
- What you expected versus what happened.
- Reproduction steps or a proof of concept.
- Any suggested fix.
- Redact secrets — do not paste tokens, kubeconfigs or model data.

## What to Expect

A maintainer acknowledges the report in the private advisory thread. No fixed response or fix
timeline is promised. We confirm the report or explain why it is out of scope, and coordinate
disclosure in the advisory. There is no security contact address — use the form.

## Scope and Known Limitations

The platform's documented, accepted limitations — an unauthenticated inference port meant to sit
behind an authenticated gateway, plaintext in-namespace traffic, and weights treated as trusted
input — are described, with the control that bounds each, in the
[threat model](docs/architecture/threat-model.md). A deployment that omits the documented
prerequisites is not itself a vulnerability.
