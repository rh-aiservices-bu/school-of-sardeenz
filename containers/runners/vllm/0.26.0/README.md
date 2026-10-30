# vLLM 0.26.0 rhaiv.9 runner

This image packages the Sardeenz vLLM runner shim and kvcached on top of the `rhaiv.9` downstream
build of the upstream vLLM CUDA image. It is an OCI build input for the librarian pipeline, which
converts it to a SIF for workers to launch with `apptainer exec --nv`; it is not deployed as a
container directly.

## Version pins

| Input                | Value                                                                     | Reason                                              |
| -------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| Base image           | `quay.io/vllm/vllm-cuda:0.26.0_rhaiv.9`                                   | Downstream `rhaiv.9` build of vLLM 0.26.0           |
| Base OCI index       | `sha256:a16d7271e3f717a26b6eb5041757e5c7d4488ec8ff8df89e14f481730e7addfe` | Immutable pin; amd64 runtime image only             |
| Upstream vLLM        | `0.26.0`                                                                  | Version packaged by the base                        |
| Python               | `3.12`                                                                    | Version supplied by the base                        |
| CUDA toolkit         | `13.0.2` (torch `2.11.0+cu130`)                                           | Versions supplied by the base                       |
| CUDA driver stub RPM | `cuda-driver-devel-13-0-13.0.96-1`                                        | Matches the base's CUDA 13.0 component build        |
| kvcached commit      | `2235a9ecbcdeb79f805c48b051d8d536d06c427f` (v0.1.6)                       | First release supporting vLLM 0.26+                 |
| posix_ipc / wrapt    | `1.3.2` / `2.4.0`                                                         | kvcached runtime deps the 0.26 base no longer ships |

The base contains the matching CUDA compiler and headers, C/C++ toolchain, Ninja, and Python
development files needed to compile kvcached, but it omits the `libcuda.so` link-time stub. The
builder installs the exact matching `cuda-driver-devel` RPM; that stage is discarded after the
wheels are built, so no development RPMs are added to the runtime image. Build-time assertions
verify the CUDA major/minor, `cuda-toolkit`, vLLM and PyTorch CUDA versions, required build tools,
and driver stub before compiling.

Unlike the 0.24 base, this base does not ship kvcached's `posix_ipc` and `wrapt` dependencies, so
the builder also builds their wheels and the runtime stage installs everything with `--no-index`
from `/wheels`.

## Build

The build context must be the repository root because the runner shim is copied from
`runners/vllm/`:

```bash
podman build \
  -f containers/runners/vllm/0.26.0/Containerfile \
  -t quay.io/rh-aiservices-bu/sardeenz-runner-images/vllm:0.26.0-rhaiv.9 \
  .
```

For librarian publication, set
`CONTAINERFILE=containers/runners/vllm/0.26.0/Containerfile` and use versioned OCI, SIF, and ORAS
tags (`vllm-0.26` as the SIF/module name). Add the SIF to `runners.yaml` only after publication,
using its digest-pinned ORAS reference.

## Runtime notes

- The worker supplies writable cache directories under `/scratch`; the SIF itself is read-only.
- `HF_HUB_OFFLINE=1` is intentional because weights are pre-staged.
- `ENABLE_KVCACHED=true` and `KVCACHED_AUTOPATCH=1` enable import-time vLLM patching. kvcached
  v0.1.6 arms the patch hooks from a `site-packages` `.pth` at interpreter startup, which is why
  `wrapt` must be importable in the runtime image.
- `VLLM_USE_V2_MODEL_RUNNER=0` forces vLLM Model Runner V1. kvcached only patches the Model
  Runner V2 path from vLLM 0.28 onwards, so a 0.26 engine must stay on V1. The worker also passes
  this variable explicitly when launching `vllm-0.26.sif`, allowing an already-published SIF to
  work after a worker upgrade.
- Re-run the kvcached co-tenancy gate (spike Gate 9d) before publishing any change to the base or
  the kvcached pin.
