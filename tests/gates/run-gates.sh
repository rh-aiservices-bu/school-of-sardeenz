#!/usr/bin/env bash
# run-gates.sh — automate the Phase 4 Apptainer/SIF spike gates against a real cluster.
#
# Run this INSIDE a worker Pod (it uses the Pod's Apptainer + /dev/fuse + userns), e.g.:
#   oc cp tests/gates/run-gates.sh <pod>:/tmp/run-gates.sh -n sardeenz
#   oc exec -it <pod> -n sardeenz -- bash /tmp/run-gates.sh            # CPU gates
#   oc exec -it <pod> -n sardeenz -- bash /tmp/run-gates.sh --gpu      # + GPU gates (needs a GPU)
#
# CPU gates (0-6) run on any 4.15+ worker Pod. GPU gates (7-9) + the Gate 10 measurement need a GPU
# and are skipped unless --gpu is passed (or a GPU is detected). Exit code is non-zero if any
# non-skipped gate fails. Each gate traces to a spike gate (docs/project/phase4-apptainer-spike.md).
# NOTE: intentionally `set -uo pipefail` WITHOUT `-e`. Gates must CONTINUE after a failure so the
# pass/fail counters (below) tally every gate; `-e` would abort on the first failing command. The
# per-gate risk that a mid-gate failure still reaches a later `pass` is handled inside each gate by
# assigning command output to a variable and testing it — NOT by turning on `-e`. Do not add `-e`.
set -uo pipefail

MODULES_DIR="${MODULES_DIR:-/modules}"
SCRATCH_DIR="${SCRATCH_DIR:-/scratch}"
WEIGHTS_DIR="${WEIGHTS_DIR:-/weights}"
VLLM_SIF="${VLLM_SIF:-${MODULES_DIR}/vllm-0.21.sif}"
AGENT_URL="${AGENT_URL:-http://127.0.0.1:9100}"
RUN_GPU=0
[[ "${1:-}" == "--gpu" ]] && RUN_GPU=1

PASS=0
FAIL=0
SKIP=0
FAILED_GATES=()
# Runner ids created by Gate 9, deleted by an EXIT trap so none survive the suite (even on early
# exit). Must be GLOBAL: the EXIT trap fires after gate9_kvcached_share()/main() have returned, so a
# `local` array would be out of scope. See gate9_kvcached_share().
GATE9_RUNNERS=()

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
  FAILED_GATES+=("$1")
}
skip() {
  echo "  SKIP: $1"
  SKIP=$((SKIP + 1))
}
gate() { echo; echo "== $1 =="; }

# shellcheck disable=SC2317  # invoked via `trap ... EXIT`, not called directly
gate9_cleanup() {
  local rid
  for rid in "${GATE9_RUNNERS[@]:-}"; do
    [[ -n "$rid" ]] || continue
    curl -s -o /dev/null -X DELETE "${AGENT_URL}/runners/${rid}" 2>/dev/null || true
  done
}

need_apptainer() { command -v apptainer >/dev/null 2>&1; }

# ---------------------------------------------------------------------------------------------
# CPU gates
# ---------------------------------------------------------------------------------------------

gate0_fingerprint() {
  gate "Gate 0 — environment fingerprint"
  if ! need_apptainer; then
    fail "Gate 0: apptainer not installed"
    return
  fi
  apptainer --version || true

  local userns seccomp
  userns="$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 0)"
  [[ "$userns" -gt 0 ]] && pass "Gate 0: max_user_namespaces=$userns (>0)" ||
    fail "Gate 0: max_user_namespaces=$userns (kernel forbids userns)"

  seccomp="$(grep -E '^Seccomp:' /proc/self/status | awk '{print $2}')"
  [[ "$seccomp" == "0" ]] && pass "Gate 0: Seccomp=0 (Unconfined applied)" ||
    fail "Gate 0: Seccomp=$seccomp (expected 0 — SCC not applied, on RuntimeDefault)"

  [[ -e /dev/fuse ]] && pass "Gate 0: /dev/fuse present" ||
    fail "Gate 0: /dev/fuse missing (annotation not applied)"
}

gate1_userns() {
  gate "Gate 1 — in-container user namespace"
  local out
  out="$(unshare --user --map-root-user id -u 2>/dev/null || echo fail)"
  [[ "$out" == "0" ]] && pass "Gate 1: unshare --user --map-root-user -> uid 0" ||
    fail "Gate 1: userns unshare failed (got '$out')"
}

_tiny_sif="${SCRATCH_DIR}/gate-busybox.sif"

gate2_build_exec() {
  gate "Gate 2 — build + exec a SIF"
  export APPTAINER_TMPDIR="${SCRATCH_DIR}" APPTAINER_CACHEDIR="${SCRATCH_DIR}/cache"
  mkdir -p "${APPTAINER_CACHEDIR}"
  if apptainer build --force "${_tiny_sif}" docker://busybox >/dev/null 2>&1; then
    local out
    out="$(apptainer exec "${_tiny_sif}" echo ok 2>/dev/null)"
    [[ "$out" == "ok" ]] && pass "Gate 2: built + exec'd a SIF" ||
      fail "Gate 2: exec produced '$out'"
  else
    fail "Gate 2: apptainer build failed (check egress + node-local APPTAINER_TMPDIR)"
  fi
}

gate3_no_copy() {
  gate "Gate 3 — no-copy squashfuse mount (SIF runs in place)"
  [[ -f "${_tiny_sif}" ]] || {
    skip "Gate 3: needs Gate 2's SIF"
    return
  }
  local before after
  before="$(du -sb "${SCRATCH_DIR}" 2>/dev/null | awk '{print $1}')"
  apptainer exec "${_tiny_sif}" sleep 30 &
  local pid=$!
  sleep 3
  # Evidence: a squashfuse process serves the SIF read-only (the overlay hides it from /proc/mounts).
  # Scope the evidence to THIS gate's SIF: a bare `pgrep squashfuse` matches any SIF in the pid
  # namespace (another runner's), so it would pass regardless of whether our own exec mounted
  # anything. apptainer passes the SIF path in the squashfuse argv, so match on it.
  if pgrep -af 'squashfuse' 2>/dev/null | grep -qF "${_tiny_sif}"; then
    pass "Gate 3: squashfuse process serving the SIF"
  else
    fail "Gate 3: no squashfuse process (SIF may have been extracted, not mounted)"
  fi
  after="$(du -sb "${SCRATCH_DIR}" 2>/dev/null | awk '{print $1}')"
  # Allow small cache noise; a full extraction would grow scratch by the image size (MBs+).
  if [[ -n "$before" && -n "$after" && $((after - before)) -lt 1048576 ]]; then
    pass "Gate 3: scratch grew <1MiB during exec (no extraction)"
  else
    fail "Gate 3: scratch grew by $((after - before)) bytes (possible extraction)"
  fi
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
}

gate4_weights_bind() {
  gate "Gate 4 — weights via --bind"
  [[ -f "${_tiny_sif}" ]] || {
    skip "Gate 4: needs Gate 2's SIF"
    return
  }
  # Unique probe path — never a FIXED name on the shared RWX weights volume. A fixed path lets two
  # workers race the same file and leaks it if a run is interrupted. mktemp fails (→ skip) if the
  # volume is read-only here. The probe is removed inline right after the read-back below: gate4 has
  # a single straight-line exit path past this point, so a `trap ... RETURN` bought nothing here — and
  # in bash, a RETURN trap set inside a function re-fires in the CALLER's scope when the caller
  # returns too, which under `set -u` blew up on the (by-then out-of-scope) $marker at main()'s return.
  local marker
  marker="$(mktemp "${WEIGHTS_DIR}/.gate4-probe.XXXXXX" 2>/dev/null)" || {
    skip "Gate 4: weights volume not writable here (bind still testable if a file exists)"
    return
  }
  echo "gate4" >"$marker" 2>/dev/null
  local out
  out="$(apptainer exec --bind "${WEIGHTS_DIR}" "${_tiny_sif}" cat "${marker}" 2>/dev/null)"
  [[ "$out" == "gate4" ]] && pass "Gate 4: read weights through --bind" ||
    fail "Gate 4: could not read bound weights (got '$out')"
  rm -f "${marker}" 2>/dev/null
}

gate5_signal_clean() {
  gate "Gate 5 — long-lived runner + clean SIGTERM (no orphan/zombie)"
  # Load-bearing: apptainer-launcher.ts:12/:323 cite Gate 5 as evidence for the stop path (SIGTERM,
  # then SIGKILL after the grace period). Gate 5 was meant to catch #109; that issue's acceptance is
  # unit tests, not this gate, so fixing Gate 5 does not depend on #109 — but re-running Gate 5
  # after #109 lands is the real confirmation. Keep the two associated.
  [[ -f "${_tiny_sif}" ]] || {
    skip "Gate 5: needs Gate 2's SIF"
    return
  }
  # Apptainer creates NO pid namespace unless `--pid` is passed, so the exec'd `sleep 300` is
  # visible to (and killable from) this harness — Gate 8 verifies the pid namespace is shared.
  apptainer exec "${_tiny_sif}" sleep 300 &
  local pid=$!
  sleep 2
  # Record the in-container process(es) BEFORE signalling. `pgrep -f 'sleep 300'` also matches the
  # apptainer wrapper (its argv contains the command); harmless for an "assert nothing remains"
  # check, so we never treat this count as an assertion on its own.
  local before_pids
  before_pids="$(pgrep -f 'sleep 300' 2>/dev/null | tr '\n' ' ')"

  kill -TERM "$pid" 2>/dev/null
  sleep 3

  # Survived-SIGTERM check on the wrapper: `ps -o stat=` treating Z (defunct/zombie) as "exited".
  # `kill -0` was wrong here — it SUCCEEDS on an unreaped zombie and would spuriously report the
  # process as still alive.
  local stat
  stat="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')"
  if [[ -n "$stat" && "$stat" != Z* ]]; then
    fail "Gate 5: wrapper survived SIGTERM (stat=$stat)"
    kill -KILL "$pid" 2>/dev/null
  else
    pass "Gate 5: wrapper exited on SIGTERM (stat=${stat:-none})"
  fi
  wait "$pid" 2>/dev/null

  # The real assertion (previously UNCONDITIONAL — `wait` had already reaped the child before the
  # old `ps ... grep Z`): NO in-container `sleep 300` process may remain after the grace period.
  # This is what would catch a stop path that leaves the engine running (#109).
  local remaining
  remaining="$(pgrep -f 'sleep 300' 2>/dev/null | tr '\n' ' ')"
  if [[ -n "${remaining// /}" ]]; then
    fail "Gate 5: in-container process survived SIGTERM (before='${before_pids}' remaining='${remaining}')"
    pkill -KILL -f 'sleep 300' 2>/dev/null || true  # don't let a survivor poison later gates
  else
    pass "Gate 5: no orphan/zombie — all 'sleep 300' processes gone (before='${before_pids}')"
  fi
}

gate6_parallel_hotadd() {
  gate "Gate 6 — parallel versions + hot-add"
  [[ -f "${_tiny_sif}" ]] || {
    skip "Gate 6: needs Gate 2's SIF"
    return
  }
  local sif2="${SCRATCH_DIR}/gate-busybox-2.sif"
  cp "${_tiny_sif}" "${sif2}" 2>/dev/null # a "new version" hot-added without touching the first
  apptainer exec "${_tiny_sif}" sleep 20 &
  local p1=$!
  apptainer exec "${sif2}" sleep 20 &
  local p2=$!
  sleep 3
  if kill -0 "$p1" 2>/dev/null && kill -0 "$p2" 2>/dev/null; then
    pass "Gate 6: two SIFs run side by side; second hot-added with no restart"
  else
    fail "Gate 6: could not run two SIFs concurrently"
  fi
  kill "$p1" "$p2" 2>/dev/null
  wait "$p1" "$p2" 2>/dev/null
  rm -f "${sif2}" 2>/dev/null
}

# ---------------------------------------------------------------------------------------------
# GPU gates
# ---------------------------------------------------------------------------------------------

# Returns 0 if a GPU is usable via --nv; 2 if Gate 2 produced no SIF (so we CANNOT probe --nv);
# 1 if the SIF exists but no GPU. main() distinguishes 2 from 1 so a missing SIF is never silently
# reported as "no GPU".
gpu_available() {
  [[ -f "${_tiny_sif}" ]] || return 2
  apptainer exec --nv "${_tiny_sif}" nvidia-smi -L >/dev/null 2>&1
}

gate7_nv() {
  gate "Gate 7 — GPU visible via --nv"
  [[ -f "${_tiny_sif}" ]] || {
    skip "Gate 7: needs Gate 2's SIF (Gate 2 did not produce one)"
    return
  }
  if apptainer exec --nv "${_tiny_sif}" nvidia-smi -L 2>/dev/null | grep -qi GPU; then
    pass "Gate 7: nvidia-smi lists a GPU inside the SIF"
  else
    fail "Gate 7: no GPU visible via --nv (check NVIDIA GPU Operator + --nv)"
  fi
}

gate8_namespaces() {
  gate "Gate 8 — ipc/pid/net namespace sharing across the SIF"
  # Apptainer shares the host (container) IPC/PID/NET namespaces by default — kvcached needs IPC,
  # and the shared PID namespace is precisely what lets Gate 5 see and signal the exec'd process.
  [[ -f "${_tiny_sif}" ]] || {
    skip "Gate 8: needs Gate 2's SIF (Gate 2 did not produce one)"
    return
  }
  local host_ipc sif_ipc host_pid sif_pid
  host_ipc="$(readlink /proc/self/ns/ipc 2>/dev/null)"
  sif_ipc="$(apptainer exec "${_tiny_sif}" readlink /proc/self/ns/ipc 2>/dev/null)"
  [[ -n "$host_ipc" && "$host_ipc" == "$sif_ipc" ]] &&
    pass "Gate 8: IPC namespace shared ($sif_ipc)" ||
    fail "Gate 8: IPC namespace not shared (host=$host_ipc sif=$sif_ipc)"
  host_pid="$(readlink /proc/self/ns/pid 2>/dev/null)"
  sif_pid="$(apptainer exec "${_tiny_sif}" readlink /proc/self/ns/pid 2>/dev/null)"
  [[ -n "$host_pid" && "$host_pid" == "$sif_pid" ]] &&
    pass "Gate 8: PID namespace shared ($sif_pid) — Gate 5 can see/kill the exec'd process" ||
    fail "Gate 8: PID namespace not shared (host=$host_pid sif=$sif_pid)"
}

# Poll a runner's /memory-report until it answers HTTP 200 with a `.devices` array (READY), or the
# bounded budget below is exhausted. Echoes the JSON body and returns 0 on success; prints nothing
# and returns 1 on timeout. ~60 attempts * 2s sleep ≈ 2 minutes — enough for a real vLLM runner to
# leave STARTING on a live cluster without hanging the suite indefinitely on a stuck one.
gate9_wait_ready() {
  local host="$1" port="$2" attempt resp code body
  for ((attempt = 1; attempt <= 60; attempt++)); do
    resp="$(curl -s -w '\n%{http_code}' "http://${host}:${port}/memory-report" 2>/dev/null)"
    code="$(tail -n1 <<<"$resp")"
    body="$(sed '$d' <<<"$resp")"
    if [[ "$code" == "200" ]] && jq -e '.devices' <<<"$body" >/dev/null 2>&1; then
      echo "$body"
      return 0
    fi
    sleep 2
  done
  return 1
}

gate9_kvcached_share() {
  gate "Gate 9 — two runners share one GPU via kvcached (worker agent + ApptainerLauncher)"
  if [[ ! -f "${VLLM_SIF}" ]]; then
    skip "Gate 9: vLLM SIF not found at ${VLLM_SIF}"
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    skip "Gate 9: curl not available to drive the worker agent"
    return
  fi
  # Register the cleanup trap BEFORE the first POST: a failure between the two starts previously
  # left runner A running. gate9_cleanup DELETEs every id in GATE9_RUNNERS at suite EXIT (POST
  # /runners has no delete-by-model route, only DELETE /runners/:runnerId — id capture is required).
  trap gate9_cleanup EXIT

  # Drive the worker agent (as the control plane would): start two runners on the same device.
  local body_a body_b resp_a resp_b code_a code_b rid_a rid_b
  body_a='{"modelName":"gate9-a","runnerType":"vllm","runtimeModule":"vllm-0.21","modelPath":"'"${WEIGHTS_DIR}"'/gate9-a","requiredMemory":1,"tensorParallel":1,"deviceType":"CUDA","devices":[{"deviceIndex":0,"deviceType":"CUDA"}]}'
  body_b='{"modelName":"gate9-b","runnerType":"vllm","runtimeModule":"vllm-0.21","modelPath":"'"${WEIGHTS_DIR}"'/gate9-b","requiredMemory":1,"tensorParallel":1,"deviceType":"CUDA","devices":[{"deviceIndex":0,"deviceType":"CUDA"}]}'

  # Capture the body AND the HTTP code: `-w '\n%{http_code}'` appends the code on its own final line.
  resp_a="$(curl -s -w '\n%{http_code}' -XPOST "${AGENT_URL}/runners" -H 'content-type: application/json' -d "$body_a")"
  code_a="$(tail -n1 <<<"$resp_a")"
  rid_a="$(sed '$d' <<<"$resp_a" | jq -r '.runnerId // empty' 2>/dev/null)"
  [[ -n "$rid_a" ]] && GATE9_RUNNERS+=("$rid_a")

  resp_b="$(curl -s -w '\n%{http_code}' -XPOST "${AGENT_URL}/runners" -H 'content-type: application/json' -d "$body_b")"
  code_b="$(tail -n1 <<<"$resp_b")"
  rid_b="$(sed '$d' <<<"$resp_b" | jq -r '.runnerId // empty' 2>/dev/null)"
  [[ -n "$rid_b" ]] && GATE9_RUNNERS+=("$rid_b")

  if [[ "$code_a" != "201" || "$code_b" != "201" ]]; then
    fail "Gate 9: agent returned $code_a/$code_b starting two co-located runners"
    return
  fi
  pass "Gate 9: worker agent started two runners on device 0 (HTTP $code_a/$code_b)"

  # Establish SHARING (not just two 201s): each runner's runner-contract /memory-report must report
  # a device at deviceIndex 0 → both landed on the SAME physical GPU 0 = co-located via kvcached.
  # We assert on deviceIndex only (deterministic); memoryUsedBytes is intentionally NOT asserted
  # (it varies with kvcached and would be flaky on a live cluster).
  local host_a port_a host_b port_b mem_a mem_b
  host_a="$(sed '$d' <<<"$resp_a" | jq -r '.host // empty' 2>/dev/null)"
  port_a="$(sed '$d' <<<"$resp_a" | jq -r '.port // empty' 2>/dev/null)"
  host_b="$(sed '$d' <<<"$resp_b" | jq -r '.host // empty' 2>/dev/null)"
  port_b="$(sed '$d' <<<"$resp_b" | jq -r '.port // empty' 2>/dev/null)"

  # A freshly-started runner is STARTING (not READY) for seconds to minutes on a live cluster; while
  # STARTING/ERROR, /memory-report returns HTTP 409 {error,code} with no .devices array. Poll each
  # runner (bounded ~60 * 2s ≈ 2min, mirroring gate9_wait_ready's body/code split of the POST above)
  # until it is actually ready before asserting co-location, so a slow-to-start runner is reported as
  # a readiness timeout — not misreported as a co-location failure.
  if ! mem_a="$(gate9_wait_ready "$host_a" "$port_a")"; then
    fail "Gate 9: runner A never became ready (timed out waiting for /memory-report 200)"
    return
  fi
  if ! mem_b="$(gate9_wait_ready "$host_b" "$port_b")"; then
    fail "Gate 9: runner B never became ready (timed out waiting for /memory-report 200)"
    return
  fi

  if jq -e 'any(.devices[]?; .deviceIndex == 0)' <<<"$mem_a" >/dev/null 2>&1 &&
    jq -e 'any(.devices[]?; .deviceIndex == 0)' <<<"$mem_b" >/dev/null 2>&1; then
    pass "Gate 9: both runners report device 0 via /memory-report (kvcached co-location on one GPU)"
  else
    fail "Gate 9: runners started but did not both report device 0 (a='${mem_a}' b='${mem_b}')"
  fi
}

gate10_measure() {
  gate "Gate 10 — cold/warm spawn measurement"
  [[ -f "${VLLM_SIF}" ]] || {
    skip "Gate 10: vLLM SIF not found at ${VLLM_SIF} — record on the target RWX backend"
    return
  }
  local t0 t1
  t0="$(date +%s.%N)"
  apptainer exec "${VLLM_SIF}" true 2>/dev/null
  t1="$(date +%s.%N)"
  echo "  MEASURE: cold exec of $(basename "${VLLM_SIF}") = $(awk "BEGIN{printf \"%.2f\", ${t1}-${t0}}")s"
  t0="$(date +%s.%N)"
  apptainer exec "${VLLM_SIF}" true 2>/dev/null
  t1="$(date +%s.%N)"
  echo "  MEASURE: warm exec = $(awk "BEGIN{printf \"%.2f\", ${t1}-${t0}}")s"
  pass "Gate 10: recorded spawn timings (compare against the spike EFS floor)"
}

# ---------------------------------------------------------------------------------------------
main() {
  echo "Sardeenz Phase 4 — SIF runtime gate suite"
  echo "modules=${MODULES_DIR} scratch=${SCRATCH_DIR} weights=${WEIGHTS_DIR} gpu=${RUN_GPU}"

  gate0_fingerprint
  gate1_userns
  gate2_build_exec
  gate3_no_copy
  gate4_weights_bind
  gate5_signal_clean
  gate6_parallel_hotadd

  if [[ "$RUN_GPU" == "1" ]] || gpu_available; then
    gate7_nv
    gate8_namespaces
    gate9_kvcached_share
    gate10_measure
  elif [[ ! -f "${_tiny_sif}" ]]; then
    skip "GPU gates 7-9 + Gate 10 (Gate 2 produced no SIF — cannot probe --nv; NOT necessarily 'no GPU')"
  else
    skip "GPU gates 7-9 + Gate 10 (no GPU / --gpu not set)"
  fi

  rm -f "${_tiny_sif}" 2>/dev/null
  echo
  echo "Summary: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped"
  if [[ "$FAIL" -gt 0 ]]; then
    printf '  failed: %s\n' "${FAILED_GATES[@]}"
    exit 1
  fi
}

main "$@"
