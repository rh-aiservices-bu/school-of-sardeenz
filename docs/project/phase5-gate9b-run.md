# Phase 5 — Gate 9b run record (2026-11-17)

The deploy-only co-location verification specified by [`phase5.md`](phase5.md) §Verification —
Gate 9b. This file is the run record; the recipe stays in the phase document. Environment:
`school-of-sardeenz` namespace, one GPU worker (`sardeenz-worker`, `NVIDIA L4`, NVML total
23,034 MiB / 24,152,899,584 bytes), two vLLM models on device 0:

| model                                 | `modelPath`                                    | runner module |
| ------------------------------------- | ---------------------------------------------- | ------------- |
| `meta-llama/Llama-3.2-1B-Instruct`    | `/weights/meta-llama/Llama-3.2-1B-Instruct`    | `vllm-0.24`   |
| `HuggingFaceTB/SmolLM2-135M-Instruct` | `/weights/HuggingFaceTB/SmolLM2-135M-Instruct` | `vllm-0.26`   |

Both were launched through the control plane with the dashboard's co-location switch, i.e. the
placement decision under test came from the control plane (#276), not from hand-pointing runners
at one device through the worker API.

## Preflight — one blocker, now tracked as #289

A stock deployment advertises `kvCacheElasticSharing: false` for `vllm`: the worker reads the
runner catalog from `SARDEENZ_RUNNER_CATALOG_URL`, which `deployment/` does not set, and its
loader accepts only local paths. The run used a manual workaround — the repo `runners.yaml`
mounted as a ConfigMap at `/etc/sardeenz`, `SARDEENZ_RUNNER_CATALOG_URL=/etc/sardeenz/runners.yaml`
— after which the worker reported:

```
elastic: [{runnerType: vllm, kvCacheElasticSharing: true},
          {runnerType: mlserver, kvCacheElasticSharing: false}]
```

Without that, the elastic branch is unreachable and this gate cannot run ([#289](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/289)).

## Steps 3-4 — co-location and the elastic pool

Both instances `ACTIVE`, `deviceIndices: [0]`, same worker. Each runner's `/memory-report`
device-0 entry (identical from both — one shared `/dev/shm` segment):

| field                   | idle value (both runners)                                                         |
| ----------------------- | --------------------------------------------------------------------------------- |
| `memoryTotalBytes`      | 23,661,248,512 (torch view; NVML reports 24,152,899,584)                          |
| `memoryUsedBytes`       | 6,219,563,008 (device scope, includes both engines)                               |
| `kvCache.totalBytes`    | 21,294,120,960 (≈90% of the device — kvcached pool at vLLM's default utilization) |
| `kvCache.usedBytes`     | 62,914,560                                                                        |
| `kvCache.preallocBytes` | 314,572,800                                                                       |
| `kvCache.freeBytes`     | 20,916,633,600                                                                    |

Partition invariant holds: `62,914,560 + 314,572,800 + 20,916,633,600 = 21,294,120,960`. This is
the observation Gate 9 never makes (it asserts `deviceIndex` only).

**Anomaly — `attribution` is absent** (`null`) on both runners' device rows, although the shim
sets `"attribution": "device"`. The imported modules predate that shim change, so #278's dedupe
falls back to the unknown-scope rule in production → [#287](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/287).

## Step 5 — past-capacity admission (the #276 policy)

|                               | value                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `memoryAvailableBytes` before | 19,339,935,744 (18.01 GiB)                                                   |
| SmolLM `requiredMemory`       | 21,474,836,480 (20 GiB) — 1.99 GiB past available                            |
| guarded headroom              | `min(free+prealloc, poolTotal, 50% × poolTotal)` = 10,647,060,480 (9.92 GiB) |
| result                        | `ACTIVE`, `deviceIndices: [0]`, same worker                                  |

The 1.99 GiB gap is bridgeable only by `guardedHeadroom` (`placement.ts:405-411`), so the
placement was decided by the co-location policy, not by byte-fit.

**Negative control — fail-closed.** With SmolLM set to the same 20 GiB and the switch **off**,
the start was refused: _"Placement failed for HuggingFaceTB/SmolLM2-135M-Instruct: No worker with
sufficient capacity"_ (`503`). Llama was `pinned: true` at that point so the eviction-retry path
in `deployFromRecord` had no victim; without pinning, the refusal would instead have evicted
Llama and succeeded. The model stayed `STOPPED` with `instances: []` — no half-created instance.

## Steps 6-7 — concurrent inference and the NVML reality check

Both models serving simultaneously through the proxy (`POST /openai/v1/chat/completions`,
300 `max_tokens` each), NVML sampled once per second inside the worker pod for 25 s:

```
meta-llama/Llama-3.2-1B-Instruct      -> 200 in 3.97 s, 1422 chars
HuggingFaceTB/SmolLM2-135M-Instruct   -> 200 in 1.75 s, 1449 chars

NVML memory.used: min 5932 MiB, max 5934 MiB, device total 23034 MiB (25.8%)
series: 5932 5934 5934 5934 5934 5934 5934 5934 5934 5934 5934 5934 5934 5934 5934 5934
        5934 5934 5934 5934 5934 5934 5934 5934 5934
```

Pool after the load (still identical on both runners): `usedBytes` 67,108,864,
`preallocBytes` 335,544,320, `freeBytes` 20,891,467,776, `totalBytes` 21,294,120,960 — the
partition invariant still holds and the pool did move under concurrent serving
(`usedBytes` +4 MiB, `preallocBytes` +20 MiB).

**Verdict: PASS on the recipe's acceptance criterion** — actual device usage under concurrent
inference stayed within physical capacity (5,934 of 23,034 MiB).

## What this run does _not_ prove

`kvCache.freeBytes` is unbacked virtual capacity, and the ratified headroom formula can count the
same free pool on behalf of more than one co-tenant. This run advertised 9.92 GiB of headroom
against a 19.8 GiB virtual pool, but the workload grew the pool by only ~24 MiB, so the
double-count never had a chance to express itself physically. The measurement bounds the
elasticity observed here; it does not falsify the saturation risk. Stress evidence needs a
long-context / high-concurrency workload that drives `usedBytes` toward `totalBytes` while NVML
usage is sampled.

The pool-pressure response (#277) was not exercised: `SARDEENZ_POOL_PRESSURE_ENABLED=false` in
this deployment, and the pool never approached the 90% threshold.

## Defects found during the run

- [#286](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/286) — an instance's Redis
  record can be dropped without stopping its runner; a previously failed start of
  `h2oai/h2o-danube-1.8b-chat` left a live `READY` runner holding 5.0 GB of VRAM that the control
  plane no longer knew about (`STOPPED`, `instances: []`). It was found with `ps` inside the pod
  and stopped with `DELETE /runners/runner-13142897`; every step above was re-baselined afterwards.
- [#288](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/288) — the deploy path
  issued `POST /runners` twice for that one instanceId; the same `runnerId` was handed two
  `apptainer exec` launches.
- [#287](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/287) — published runner
  modules predate #275 (`attribution` missing).
- [#289](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/289) — stock deployment
  cannot advertise `kvCacheElasticSharing`.

## Migration 008 against a live database

Exercised implicitly and successfully: the pre-existing `models` rows (created 2026-09-14)
survived the migration with `allowCoLocation` defaulting to `false`, and the flag round-tripped
through several stop → config-edit → start cycles while the column was in use.

## Cleanup

Both models were left `ACTIVE` on device 0 (Llama `pinned: true`, required memory 4 GiB each) for
the follow-up work; the leaked runner from #286 was stopped explicitly. Per-run artifacts
(completion payloads, the NVML series, pool dumps) were captured locally in a gitignored
`logs/` directory and are not committed.
