# deployment/

Kubernetes/OpenShift manifests for Sardeenz.

## Manifest format (decision)

**Kustomize, raw YAML bases.** These are the repo's first cluster manifests, so the convention is
set here:

- **Kustomize** (not Helm) — bases under `deployment/<component>/`, overlaid per environment. Helm
  is not adopted anywhere in the repo; avoid it unless that changes.
- **Plain YAML** resources, one file per resource kind where practical, aggregated by a
  `kustomization.yaml`.
- **Namespace:** set by the overlay via `kustomization.yaml` `namespace:` (bases are
  namespace-light). Default `sardeenz`.
- **Naming:** all resources are prefixed `sardeenz-` (e.g. `sardeenz-sif-runner` SCC,
  `sardeenz-worker` SA/Deployment, `sardeenz-modules`/`sardeenz-weights` PVCs).
- **Cluster prerequisites** (self-managed OpenShift/OKD **4.15+**, tested on 4.21): `crun`
  runtime, a shared RWX StorageClass, rights to create a custom SCC, and the
  `io.kubernetes.cri-o.Devices: "/dev/fuse"` pod annotation (no device plugin on 4.15+).

## Layout

```
deployment/
├── README.md               # this file (format decision)
├── sif-runner/             # worker security posture + worker Deployment (Task 8)
└── librarian/              # SIF build/sign/convert Job + signing keys (Task 7)
```

Apply a base with `oc apply -k deployment/sif-runner/` (or via an overlay). See each directory's
`README.md` for what it contains and the order to apply.
