# vLLM 0.24.0 rhaiv.9 runner

This image packages the Sardeenz vLLM runner shim and kvcached on top of the `rhaiv.9` downstream
build of the upstream vLLM CUDA image. It is an OCI build input for the librarian pipeline, which
converts it to a SIF for workers to launch with `apptainer exec --nv`; it is not deployed as a
container directly.

## Version pins

| Input                | Value                                                                     | Reason                                       |
| -------------------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| Base image           | `quay.io/vllm/vllm-cuda:0.24.0_rhaiv.9`                                   | Downstream `rhaiv.9` build of vLLM 0.24.0    |
| Base OCI index       | `sha256:bc6496d84e810a7ef2be2ba05f68c987db2bb007399881671ac7519934be2979` | Immutable pin; amd64 runtime image only      |
| Upstream vLLM        | `0.24.0`                                                                  | Version packaged by the base                 |
| Python               | `3.12`                                                                    | Version supplied by the base                 |
| CUDA toolkit         | `13.0.2`                                                                  | Version supplied by the base                 |
| CUDA driver stub RPM | `cuda-driver-devel-13-0-13.0.96-1`                                        | Matches the base's CUDA 13.0 component build |
| kvcached commit      | `60cad949389af6bbf1d65c4eddf325113df5a9eb`                                | Includes vLLM 0.24/0.25 compatibility fixes  |

The base contains the matching CUDA compiler and headers, C/C++ toolchain, Ninja, and Python
development files needed to compile kvcached, but it omits the `libcuda.so` link-time stub. The
builder installs the exact matching `cuda-driver-devel` RPM; that stage is discarded after the
wheel is built, so no development RPMs are added to the runtime image. Build-time assertions verify
the CUDA major/minor, vLLM and PyTorch CUDA versions, required build tools, and driver stub before
compiling the wheel.

## Build

The build context must be the repository root because the runner shim is copied from
`runners/vllm/`:

```bash
podman build \
  -f containers/runners/vllm/0.24.0/Containerfile \
  -t quay.io/rh-aiservices-bu/sardeenz-runner-images/vllm:0.24.0-rhaiv.9 \
  .
```

For librarian publication, set
`CONTAINERFILE=containers/runners/vllm/0.24.0/Containerfile` and use versioned OCI, SIF, and ORAS
tags. Add the SIF to `runners.yaml` only after publication, using its digest-pinned ORAS reference.

## Runtime notes

- The worker supplies writable cache directories under `/scratch`; the SIF itself is read-only.
- `HF_HUB_OFFLINE=1` is intentional because weights are pre-staged.
- `ENABLE_KVCACHED=true` and `KVCACHED_AUTOPATCH=1` enable import-time vLLM patching.
- `VLLM_USE_V2_MODEL_RUNNER=0` forces vLLM Model Runner V1. kvcached does not support the
  Model Runner V2 path introduced in this vLLM line. The worker also passes this variable
  explicitly when launching `vllm-0.24.sif`, allowing an existing SIF to work after a worker
  upgrade.
- Re-run the kvcached co-tenancy gate before publishing any change to the base or kvcached pin.
