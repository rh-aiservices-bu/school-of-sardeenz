# Runner images

Runner OCI definitions are grouped first by engine, then by the exact upstream engine version:

```text
runners/
├── mlserver/
│   └── 1.6.1/
│       ├── Containerfile
│       └── README.md
└── vllm/
    └── 0.21.0/
        ├── Containerfile
        └── README.md
```

Each version directory is self-contained: its `Containerfile` pins the engine image and coupled
dependencies, while its `README.md` records compatibility and build instructions. Add a sibling
version directory when supporting another engine release; do not overwrite an existing version.

Build contexts remain the repository root because runner-contract shims are shared from
`runners/<engine>/`. See the parent [container guide](../README.md) for publishing and naming.
